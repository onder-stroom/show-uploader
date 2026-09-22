import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { db } from '../../db/client';
import {
  createUpload,
  createPlatformJob,
  type PlatformJob,
  listUploadsWithJobs,
  getUploadWithJobs,
  releaseClaimForShow,
  getStagedUpload,
  deleteStagedUpload,
  resetPlatformJobForRetry,
  updateUploadMetadata,
  listStagedShowIds,
  listUploadingSessions,
  listUploadsNeedingRemux,
  listArchivedUploads,
  deleteUpload,
  isPrePublishVideoKey,
  getLatestUploadForShow,
  getLatestUploadWithJobsForShow,
  updateJobStatus,
} from '../../db/queries';
import { enqueueArchiveJob, enqueueCompressJob, readyToArchive, cancelQueuedJobs } from '../../services/archive-jobs';
import { presenceHub } from '../../services/presence-hub';
import { uploadQueue, previewQueue } from '../../queue';
import {
  derivePreviewState,
  isPlayable,
  previewJobId,
  previewKeyFor,
  type PreviewJobView,
} from '../../services/video-preview';

/**
 * Reject any key that isn't a recording this app is holding for publication.
 *
 * One preview endpoint signs a download URL for the key and the other enqueues a
 * remux that DELETES it, so a caller-supplied key can never be the authority —
 * otherwise a jingle or another show's archive could be fed to either.
 *
 * Both sides of the rename are accepted: a successful remux repoints the record
 * to the `.mp4`, at which point the caller's original key is legitimately absent
 * but still the one it is polling with.
 */
async function assertPrePublishVideo(videoS3Key: string): Promise<void> {
  const ok = await isPrePublishVideoKey(db, [videoS3Key, previewKeyFor(videoS3Key)]);
  if (!ok) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Not a recording awaiting publication' });
  }
}
import { createDownloadPresignedUrl, listUploadedParts, objectInfo } from '../../services/s3';
import { findShowFolder } from '../../services/show-folder';
import { deleteStagedVideo } from '../../services/staged-video';
import { withDownloadUrls } from '../../services/upload-urls';
import { getLiveState } from '../../services/live-guard';
import {
  updateArchiveRecord,
  removeArchiveMediaLink,
  resolveGenreIds,
  getArchiveShow,
  listAllArchiveShows,
  platformOfLabel,
  type AgendaShow,
} from '../../services/shows-api';
import { syncYoutubeMetadata, syncMixcloudMetadata } from '../../services/platform-metadata';
import { baseTitle, platformTitle } from '@show-uploader/domain';
import { slugify } from '@show-uploader/domain';
import { env } from '../../env';

// tRPC mirror of routes/uploads.ts (non-SSE, non-multipart). Reuses the exact
// same db queries + services + zod validation, so behaviour matches the REST
// route. The multipart flow and the SSE event stream stay REST — file uploads +
// SSE don't fit tRPC's batch link.

// HH:MM:SS or MM:SS format
const TimeCode = z.string().regex(/^(\d{1,2}:)?\d{2}:\d{2}$/).optional().nullable();

const CreateUploadSchema = z.object({
  showId: z.string(),
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  imageUrl: z.string().url().nullable().default(null),
  videoS3Key: z.string().min(1),
  // Empty is valid: attaching a recording to a show already published
  // elsewhere needs nothing to publish, just the archive step (see the
  // platforms.length === 0 branch in `create` below).
  platforms: z.array(z.enum(['youtube', 'mixcloud'])),
  includeJingle: z.boolean().default(true),
  // Auto-detect and cut leading/trailing silence (dead air) via ffmpeg. Manual
  // trim below overrides it.
  autoTrimSilence: z.boolean().default(true),
  trimStart: TimeCode,
  trimEnd: TimeCode,
});

const MetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
});

// Re-throw domain TRPCErrors as-is; wrap anything else as INTERNAL_SERVER_ERROR
// (the REST route logged + returned 500 for these). Keeps try/catch parity with
// the Express handlers without swallowing intentional 404/409 errors.
function internal(err: unknown, logMessage: string, message: string): never {
  if (err instanceof TRPCError) throw err;
  console.error(logMessage, err);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
}

// An upload row for an archived show, found or created. Actions on the archive
// catalogue (shrink, publish-to-platform) create whatever bookkeeping they need
// — the operator never prepares a row so that a button becomes pressable. A
// show whose upload row was cleared along with its finished jobs gets a fresh
// one here, built from the archive record and its S3 folder, exactly like
// adopting does.
async function adoptArchivedUpload(showId: string) {
  const existing = await getLatestUploadWithJobsForShow(db, showId);
  if (existing) return existing;

  const show = await getArchiveShow(showId);
  if (!show) throw new TRPCError({ code: 'NOT_FOUND', message: 'Show not found' });
  const folder = await findShowFolder(show);
  if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: 'No archived recording found on S3' });
  const videoS3Key = `${folder}video.mp4`;
  if (!(await objectInfo(videoS3Key)).exists) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No archived video found on S3' });
  }
  const audioS3Key = `${folder}audio.m4a`;
  const audioInfo = await objectInfo(audioS3Key);
  const row = await createUpload(db, {
    show_id: showId,
    title: show.title,
    description: show.description,
    tags: show.tags ?? [],
    image_url: show.imageUrl,
    video_s3_key: videoS3Key,
    audio_s3_key: audioInfo.exists ? audioS3Key : null,
    jingle_s3_key: null,
    trim_start: null,
    trim_end: null,
  });
  return { ...row, jobs: [] as PlatformJob[] };
}

export const uploadsRouter = router({
  /**
   * GET /api/uploads — every upload with its jobs. Keys, not signed URLs.
   *
   * This list is polled, and signing here meant re-signing every artefact of
   * every upload on every poll: pure churn for objects that never change, and
   * it handed the UI a download URL that mutated underneath anything using it
   * (a playing <video> was torn down and restarted). The UI signs a key when
   * the operator actually asks for it — see storage.signObject.
   */
  list: protectedProcedure.query(async () => {
    try {
      return await listUploadsWithJobs(db);
    } catch (err) {
      internal(err, 'Failed to list uploads:', 'Failed to list uploads');
    }
  }),

  // GET /api/uploads/:id — one upload with its jobs + download URLs.
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    try {
      const upload = await getUploadWithJobs(db, input.id);
      if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' });
      return await withDownloadUrls(upload);
    } catch (err) {
      internal(err, 'Failed to get upload:', 'Failed to get upload');
    }
  }),

  // GET /api/uploads/staged/:showId — staged (uploaded, not-yet-published) video
  // for a show. Survives refresh and is visible on any machine.
  getStaged: protectedProcedure.input(z.object({ showId: z.string() })).query(async ({ input }) => {
    try {
      return await getStagedUpload(db, input.showId);
    } catch (err) {
      internal(err, 'Failed to read staged upload:', 'Failed to read staged upload');
    }
  }),

  // DELETE /api/uploads/staged/:showId — the operator abandoning a staged
  // pick (replace). See services/staged-video.ts for why this must delete the
  // S3 object while the post-publish cleanup in `create` below must not.
  deleteStaged: protectedProcedure.input(z.object({ showId: z.string() })).mutation(async ({ input }) => {
    await deleteStagedVideo(input.showId);
    return { ok: true };
  }),

  // GET /api/uploads/staged — show_ids that already have a staged video, for the
  // "to process" table to flag which shows have a recording ready.
  getStagedShowIds: protectedProcedure.query(async () => {
    try {
      return await listStagedShowIds(db);
    } catch (err) {
      internal(err, 'Failed to list staged shows:', 'Failed to list staged shows');
    }
  }),

  // In-progress multipart uploads with a real % per show, so OTHER machines show
  // "uploading elsewhere · N%" while a browser is mid-upload. The % is computed
  // server-side from S3 ListParts (uploaded bytes / total) — no client reporting,
  // so it's the same number on every machine. A failed ListParts drops that
  // session's % to null (still shown as "uploading", just without the number).
  getUploadingProgress: protectedProcedure.query(async () => {
    try {
      const sessions = await listUploadingSessions(db);
      return await Promise.all(
        sessions.map(async (s) => {
          const total = Number(s.size_bytes) || 0;
          let pct: number | null = null;
          try {
            const parts = await listUploadedParts(s.s3_key, s.s3_upload_id);
            const uploaded = parts.reduce((sum, p) => sum + (p.Size ?? 0), 0);
            if (total > 0) pct = Math.min(99, Math.round((uploaded / total) * 100));
          } catch {
            pct = null; // session may have just completed/aborted — ignore
          }
          return { show_id: s.show_id, pct };
        })
      );
    } catch (err) {
      internal(err, 'Failed to read upload progress:', 'Failed to read upload progress');
    }
  }),

  // GET /api/uploads/jingle-preview — presigned URL to preview the configured
  // jingle. NOT_FOUND when no jingle is set.
  getJinglePreview: protectedProcedure.query(async () => {
    if (!env.JINGLE_S3_KEY) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No jingle configured' });
    }
    try {
      const url = await createDownloadPresignedUrl(env.JINGLE_S3_KEY);
      return { url, filename: env.JINGLE_S3_KEY.split('/').pop() ?? 'jingle' };
    } catch (err) {
      internal(err, 'Failed to sign jingle URL:', 'Failed to sign jingle URL');
    }
  }),

  // POST /api/uploads — create an upload + a platform job per platform, enqueue
  // the BullMQ jobs (deferred while a show is on air), release the show claim and
  // clear the staged upload. Returns { uploadId, jobs, deferredUntil }.
  create: protectedProcedure.input(CreateUploadSchema).mutation(async ({ input: data }) => {
    const jingleS3Key = env.JINGLE_S3_KEY ?? null;
    try {
      // Refuse to publish somewhere this show already is. The form hides those
      // platforms, but that's a view of the record as it looked when the page
      // loaded — someone can add a link in the agenda meanwhile, or an old tab
      // can submit. Publishing twice creates a second video or cloudcast that
      // has to be taken down by hand, so it's worth a check the UI can't skip.
      if (data.platforms.length > 0) {
        const show = await getArchiveShow(data.showId);
        const already = new Set(
          (show?.mediaLinks ?? []).map((l) => platformOfLabel(l.label)).filter(Boolean)
        );
        const duplicate = data.platforms.filter((p) => already.has(p));
        if (duplicate.length > 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This show is already published to ${duplicate.join(' and ')}. Remove the existing link on the agenda record first if you mean to publish again.`,
          });
        }
      }

      const upload = await createUpload(db, {
        show_id: data.showId,
        title: data.title,
        description: data.description,
        tags: data.tags,
        image_url: data.imageUrl,
        video_s3_key: data.videoS3Key,
        jingle_s3_key: jingleS3Key,
        trim_start: data.trimStart ?? null,
        trim_end: data.trimEnd ?? null,
      });

      const jobs = await Promise.all(
        data.platforms.map((platform) => createPlatformJob(db, { upload_id: upload.id, platform }))
      );

      // Don't run heavy work (transcode/upload) while a show is on air — defer
      // the jobs until the live window (plus buffer) clears. Fails open if PB is
      // down.
      const live = await getLiveState(new Date());
      const delay = live.isLive && live.resumeAt ? Math.max(0, live.resumeAt.getTime() - Date.now()) : 0;
      if (delay > 0) {
        console.log(`Show live — deferring upload ${upload.id} jobs until ${live.resumeAt!.toISOString()}`);
      }

      // Archive first, always: one download, one trim, one loudness pass
      // producing the two canonical files, and the platform jobs upload THOSE.
      // Their rows are created queued here so the operator sees the whole
      // pipeline at submit, but only the archive job enters the queue — it
      // enqueues the platforms itself when its artefacts exist. That ordering
      // is what makes "MixCloud succeeded but the archive failed" impossible,
      // and it cut the per-show work to a third.
      await enqueueArchiveJob(db, { ...upload, jobs }, { delay, includeJingle: data.includeJingle });

      // The show is now published — free its claim so it drops off everyone's
      // "being processed" list immediately, and clear the staged row. Row only:
      // its s3_key is what data.videoS3Key just became, so unlike deleteStaged
      // (the operator's "replace" action) this must never touch S3 — that
      // would delete the video the show now points at, seconds after publish.
      await releaseClaimForShow(db, data.showId);
      await deleteStagedUpload(db, data.showId).catch(() => {});
      void presenceHub.broadcastClaims();

      return {
        uploadId: upload.id,
        jobs,
        deferredUntil: delay > 0 ? live.resumeAt!.toISOString() : null,
      };
    } catch (err) {
      internal(err, 'Failed to create upload:', 'Failed to create upload');
    }
  }),

  // POST /api/uploads/:uploadId/jobs/:platform/retry — re-run a single platform
  // job. Reconstructs the payload from the stored upload row and re-enqueues.
  retryJob: protectedProcedure
    .input(z.object({ uploadId: z.string(), platform: z.enum(['youtube', 'mixcloud', 'archive']) }))
    .mutation(async ({ input }) => {
      const { uploadId, platform } = input;
      try {
        const upload = await getUploadWithJobs(db, uploadId);
        if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });
        const job = upload.jobs.find((j) => j.platform === platform);
        if (!job) throw new TRPCError({ code: 'NOT_FOUND', message: 'Job not found' });
        if (job.status === 'processing') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Job already running' });
        }

        // Platforms upload archive artefacts; retrying one before those exist
        // would hand it the raw source (or nothing, for audio). The archive
        // job enqueues them itself when it finishes — including after its own
        // retry — so the answer here is "retry the archive", not a dead job.
        if (platform !== 'archive') {
          const archiveDone = upload.jobs.some((j) => j.platform === 'archive' && j.status === 'done');
          if (!archiveDone) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'The archive step has not finished — retry that first; it starts the platform uploads itself.',
            });
          }
        }

        await resetPlatformJobForRetry(db, job.id);
        await uploadQueue.add(platform, {
          jobId: job.id,
          uploadId,
          platform,
          // Post-archive these point at the archived artefacts — the row was
          // repointed when archiving finished.
          videoS3Key: upload.video_s3_key,
          audioS3Key: upload.audio_s3_key,
          title: upload.title,
          description: upload.description ?? '',
          tags: upload.tags ?? [],
          imageUrl: upload.image_url,
          jingleS3Key: upload.jingle_s3_key,
          includeJingle: !!upload.jingle_s3_key,
          autoTrimSilence: false,
          trimStart: null,
          trimEnd: null,
        });
        return { ok: true };
      } catch (err) {
        internal(err, 'Failed to retry job:', 'Failed to retry job');
      }
    }),

  // POST /api/uploads/:uploadId/archive — (re)generate the downloadable audio
  // archive (m4a). Reuses or creates the 'archive' job and enqueues extraction.
  generateAudio: protectedProcedure.input(z.object({ uploadId: z.string() })).mutation(async ({ input }) => {
    try {
      const upload = await getUploadWithJobs(db, input.uploadId);
      if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });
      const queued = await enqueueArchiveJob(db, upload);
      if (!queued) throw new TRPCError({ code: 'CONFLICT', message: 'Already generating' });
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to enqueue audio archive:', 'Failed to generate audio');
    }
  }),

  // POST /api/uploads/:uploadId/compress — shrink an already-archived show's
  // video via a real re-encode (see worker/src/services/ffmpeg.ts compressVideo).
  // Unlike remux this is lossy and operator-triggered per show, for the rare
  // recording that came out of OBS at a much higher bitrate than usual.

  /**
   * POST an archived recording to one platform it isn't on yet — no re-upload,
   * no new processing: the job is the same thin platform upload the archive
   * pipeline enqueues, fed the finished shows/<folder>/ artefacts. This is how
   * a show that skipped MixCloud (or any platform added later — the enum is
   * the only gate) gets published there afterwards.
   */
  publishToPlatform: protectedProcedure
    .input(z.object({ showId: z.string().min(1), platform: z.enum(['youtube', 'mixcloud']) }))
    .mutation(async ({ input }) => {
      try {
        const show = await getArchiveShow(input.showId);
        if (!show) throw new TRPCError({ code: 'NOT_FOUND', message: 'Show not found' });
        // Same duplicate guard as create: the record's links are the truth
        // about where this show already lives.
        if ((show.mediaLinks ?? []).some((l) => platformOfLabel(l.label) === input.platform)) {
          throw new TRPCError({ code: 'CONFLICT', message: `Already published on ${input.platform}` });
        }

        const upload = await adoptArchivedUpload(input.showId);
        if (!upload.video_s3_key.startsWith('shows/')) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Not archived yet — the archive job must finish first',
          });
        }
        if (input.platform === 'mixcloud' && !upload.audio_s3_key) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No archived audio for this show' });
        }
        const existing = upload.jobs.find((j) => j.platform === input.platform);
        if (existing && (existing.status === 'queued' || existing.status === 'processing')) {
          throw new TRPCError({ code: 'CONFLICT', message: `A ${input.platform} upload is already running` });
        }

        // A finished/failed row from an earlier post is common (a deleted
        // duplicate, a first attempt). The (upload_id, platform) unique index
        // means a blind insert 500s — reuse and reset the row instead, exactly
        // like retryJob and enqueueCompressJob do.
        const job = existing
          ? (await resetPlatformJobForRetry(db, existing.id), existing)
          : await createPlatformJob(db, { upload_id: upload.id, platform: input.platform });
        await uploadQueue.add(input.platform, {
          jobId: job.id,
          uploadId: upload.id,
          platform: input.platform,
          videoS3Key: upload.video_s3_key,
          audioS3Key: upload.audio_s3_key,
          // platformTitle strips any existing "<date> @ coming soon" suffix
          // before re-adding, so it's correct for both a fresh row (raw record
          // title) and an old one that already carries the convention.
          title: platformTitle(upload.title, show.date),
          description: upload.description ?? '',
          tags: upload.tags ?? [],
          imageUrl: show.imageUrl,
          // The archived audio is jingle-less by design (the jingle is
          // prepended per platform); posting later should sound like posting
          // right away, so the configured jingle rides along.
          jingleS3Key: env.JINGLE_S3_KEY ?? null,
          includeJingle: !!env.JINGLE_S3_KEY,
          trimStart: null,
          trimEnd: null,
        });
        return { ok: true, jobId: job.id };
      } catch (err) {
        internal(err, 'Failed to enqueue platform publish:', 'Failed to start the platform upload');
      }
    }),

  compressArchiveVideo: protectedProcedure
    .input(z.object({ showId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        let upload = await adoptArchivedUpload(input.showId);

        // The key's location carries the "safe to rewrite" guarantee: shows/
        // is the published layout, written only when archiving completed, so
        // nothing else is still reading or writing this object — except a job
        // in flight right now, which is the one thing left to check.
        if (!upload.video_s3_key.startsWith('shows/') || !/\.mp4$/i.test(upload.video_s3_key)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Not an archived mp4 yet — run the mp4 conversion first',
          });
        }
        if (upload.jobs.some((j) => j.status === 'queued' || j.status === 'processing')) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This recording is still being processed — try again once it finishes',
          });
        }
        const queued = await enqueueCompressJob(db, upload);
        if (!queued) throw new TRPCError({ code: 'CONFLICT', message: 'Already shrinking this recording' });
        return { ok: true };
      } catch (err) {
        internal(err, 'Failed to enqueue compress job:', 'Failed to start shrink');
      }
    }),

  // Backfill for recordings that predate the MP4 remux: re-run the archive job
  // on every upload whose video is still in its original container. The job is
  // the same one a single upload gets, so this needs no separate code path —
  // and it's safe to run twice, since an upload drops off the list once its
  // video_s3_key ends in .mp4.
  remuxBackfill: protectedProcedure.mutation(async () => {
    try {
      const pending = await listUploadsNeedingRemux(db);
      let enqueued = 0;
      for (const upload of pending) {
        // Same precondition the worker uses before auto-enqueuing an archive:
        // the archive replaces the source video on S3, so it must not run while
        // a platform job still needs the original file.
        if (!readyToArchive(upload.jobs)) continue;
        if (await enqueueArchiveJob(db, upload)) enqueued++;
      }
      return { enqueued, skipped: pending.length - enqueued };
    } catch (err) {
      internal(err, 'Failed to enqueue remux backfill:', 'Failed to start remux');
    }
  }),

  // POST /api/uploads/:uploadId/publish — flip the PocketBase archive record to
  // "published" (the explicit, separate step that makes it live on the agenda).
  // Takes the agenda record's own id: this only ever writes to PocketBase, so
  // routing it through an upload row (just to read show_id back off it) would
  // make publishing fail for an archived show whose job was since deleted.
  publishRecord: protectedProcedure.input(z.object({ showId: z.string().min(1) })).mutation(async ({ input }) => {
    try {
      await updateArchiveRecord(input.showId, { status: 'published' });
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to publish archive record:', 'Failed to publish archive record');
    }
  }),

  // Start the preview remux for a not-yet-published recording. Idempotent: the
  // job id is derived from the key, so pressing preview in two tabs enqueues one
  // remux. Already-MP4 keys need no work and never reach the queue.
  startPreview: protectedProcedure
    .input(z.object({ videoS3Key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { videoS3Key } = input;
      // The key decides what gets rewrapped AND deleted, so it is never taken on
      // the caller's word — only a recording the app is holding qualifies.
      await assertPrePublishVideo(videoS3Key);
      if (isPlayable(videoS3Key)) return { state: 'ready' as const, key: videoS3Key };
      try {
        const jobId = previewJobId(videoS3Key);
        // A previous failure keeps its job (and id) around, which would make the
        // retry a silent no-op. Clear it so pressing preview again really retries.
        const existing = await previewQueue.getJob(jobId);
        if (existing && (await existing.isFailed())) await existing.remove();

        await previewQueue.add('preview', { videoS3Key }, { jobId });
        return { state: 'working' as const, pct: 0 };
      } catch (err) {
        internal(err, 'Failed to start preview:', 'Failed to start preview');
      }
    }),

  // Polled by the prepare screen while a remux runs. Readiness is read from the
  // key itself, not from queue bookkeeping — see derivePreviewState.
  previewStatus: protectedProcedure
    .input(z.object({ videoS3Key: z.string().min(1) }))
    .query(async ({ input }) => {
      const { videoS3Key } = input;
      // Same rule as startPreview: this signs a download URL, so an arbitrary key
      // would be an arbitrary read of the bucket.
      await assertPrePublishVideo(videoS3Key);
      try {
        const job = await previewQueue.getJob(previewJobId(videoS3Key));
        const state = derivePreviewState({
          videoS3Key,
          job: job
            ? {
                status: (await job.getState()) as NonNullable<PreviewJobView>['status'],
                pct: typeof job.progress === 'number' ? job.progress : 0,
                failedReason: job.failedReason,
              }
            : null,
        });

        // Returns the key, never a signed URL. Signing here would hand back a
        // different URL on every poll and tear down a playing <video>; the
        // player signs the key once via storage.signObject instead.
        return state;
      } catch (err) {
        internal(err, 'Failed to read preview status:', 'Failed to read preview status');
      }
    }),

  // Is the source recording actually still on S3 for this upload? The row's
  // video_s3_key is not proof — so this HEADs the object rather than trusting
  // it, which is the whole point: it's what tells an operator whether there's a
  // file to replace.
  videoInfo: protectedProcedure.input(z.object({ uploadId: z.string() })).query(async ({ input }) => {
    try {
      const upload = await getUploadWithJobs(db, input.uploadId);
      if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });
      const { exists, size } = await objectInfo(upload.video_s3_key);
      return {
        exists,
        size,
        // Strip the upload timestamp prefix the watcher adds, e.g. "1785677613218-".
        filename: (upload.video_s3_key.split('/').pop() ?? '').replace(/^\d+-/, ''),
        showId: upload.show_id,
      };
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      internal(err, 'Failed to read video info:', 'Failed to read video info');
    }
  }),

  // The inverse: put the agenda record back to draft so it drops off the main
  // website. Only touches PocketBase status — the platform uploads and their
  // links stay exactly as they are.
  // Agenda record id, for the same reason publishRecord takes one.
  unpublishRecord: protectedProcedure.input(z.object({ showId: z.string().min(1) })).mutation(async ({ input }) => {
    try {
      await updateArchiveRecord(input.showId, { status: 'draft' });
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to unpublish archive record:', 'Failed to unpublish archive record');
    }
  }),

  // Remove an upload from the jobs queue: the row and its jobs go, the S3
  // objects and the PocketBase record stay. Allowed even while a job is
  // processing — a stuck job is exactly what an operator wants to clear.
  deleteUpload: protectedProcedure.input(z.object({ uploadId: z.string() })).mutation(async ({ input }) => {
    try {
      // Pull the queued work first: BullMQ keeps its own copy of the payload, so
      // a waiting job would happily publish an upload the operator just deleted.
      const { active } = await cancelQueuedJobs(input.uploadId);
      const removed = await deleteUpload(db, input.uploadId);
      if (!removed) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });
      // A job already in flight keeps its worker lock and runs to completion.
      return { ok: true, stillRunning: active };
    } catch (err) {
      internal(err, 'Failed to delete upload:', 'Failed to delete upload');
    }
  }),

  // PATCH /api/uploads/:uploadId/metadata — edit published metadata and push it
  // to the local DB, each published platform, and the PocketBase archive record.
  // Platform failures are reported per-target (sync), not fatal — the DB always
  // updates so the operator's edit isn't lost.
  updateMetadata: protectedProcedure
    .input(z.object({ uploadId: z.string() }).merge(MetadataSchema))
    .mutation(async ({ input }) => {
      const edit = { title: input.title, description: input.description, tags: input.tags };
      try {
        const upload = await getUploadWithJobs(db, input.uploadId);
        if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });

        await updateUploadMetadata(db, upload.id, edit);

        const sync: Record<string, 'ok' | string> = {};
        const yt = upload.jobs.find((j) => j.platform === 'youtube' && j.status === 'done' && j.result_url);
        const mc = upload.jobs.find((j) => j.platform === 'mixcloud' && j.status === 'done' && j.result_url);

        const [ytErr, mcErr] = await Promise.all([
          yt ? syncYoutubeMetadata(yt.result_url!, edit) : Promise.resolve<string | null>(null),
          mc ? syncMixcloudMetadata(mc.result_url!, edit) : Promise.resolve<string | null>(null),
        ]);
        if (yt) sync.youtube = ytErr ?? 'ok';
        if (mc) sync.mixcloud = mcErr ?? 'ok';

        try {
          // Tags are the PocketBase genres relation (PB is master) — resolve the
          // edited names to genre IDs (creating any new ones). Only write the
          // relation when tags are present, so clearing tags never wipes curated
          // genres.
          const genres = edit.tags.length ? await resolveGenreIds(edit.tags) : [];
          // Re-assert the published platform links too, so an edit fully re-syncs
          // the archive record (e.g. after a write-back that failed at publish
          // time).
          const mediaLinks: { label: string; type: string; url: string }[] = [];
          if (yt) mediaLinks.push({ label: 'YouTube', type: 'video', url: yt.result_url! });
          if (mc) mediaLinks.push({ label: 'MixCloud', type: 'audio', url: mc.result_url! });
          await updateArchiveRecord(upload.show_id, {
            // The archive record keeps the plain title; the date/@coming-soon
            // suffix is only for the platform titles.
            title: baseTitle(edit.title),
            notes: edit.description,
            ...(genres.length ? { genres } : {}),
            ...(mediaLinks.length ? { mediaLinks } : {}),
          });
          sync.pocketbase = 'ok';
        } catch (err) {
          sync.pocketbase = err instanceof Error ? err.message : String(err);
        }

        return { ok: true, sync };
      } catch (err) {
        internal(err, 'Failed to update metadata:', 'Failed to update metadata');
      }
    }),
});
