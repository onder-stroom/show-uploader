import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import {
  createUpload,
  createPlatformJob,
  listUploadsWithJobs,
  getUploadWithJobs,
  releaseClaimForShow,
  upsertStagedUpload,
  getStagedUpload,
  deleteStagedUpload,
  resetPlatformJobForRetry,
  updateUploadMetadata,
  getLatestUploadForShow,
  listStagedShowIds,
} from '../db/queries';
import { presenceHub } from '../services/presence-hub';
import { uploadQueue } from '../queue';
import { createUploadPresignedUrl, createDownloadPresignedUrl } from '../services/s3';
import { deleteStagedVideo, isValidStagedKey } from '../services/staged-video';
import { withDownloadUrls } from '../services/upload-urls';
import { enqueueArchiveJob } from '../services/archive-jobs';
import { getLiveState } from '../services/live-guard';
import { updateArchiveRecord, resolveGenreIds, removeArchiveMediaLink } from '../services/shows-api';
import { syncYoutubeMetadata, syncMixcloudMetadata, setYoutubePublic, getYoutubePrivacyStatus } from '../services/platform-metadata';
import { baseTitle } from '@show-uploader/domain';
import { env } from '../env';
import { incomingKey } from '@show-uploader/domain';

export const uploadsRouter = Router();

// HH:MM:SS or MM:SS format
const TimeCode = z.string().regex(/^(\d{1,2}:)?\d{2}:\d{2}$/).optional().nullable();

const CreateUploadSchema = z.object({
  showId: z.string(),
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  imageUrl: z.string().url().nullable().default(null),
  videoS3Key: z.string().min(1),
  platforms: z.array(z.enum(['youtube', 'mixcloud'])).min(1),
  includeJingle: z.boolean().default(true),
  // Auto-detect and cut leading/trailing silence (dead air) via ffmpeg. Manual
  // trim below overrides it.
  autoTrimSilence: z.boolean().default(true),
  trimStart: TimeCode,
  trimEnd: TimeCode,
});

// Staged video (uploaded, not yet published) per show — survives refresh and is
// visible on any machine, so an upload can be finished/published elsewhere.
uploadsRouter.get('/staged/:showId', async (req, res) => {
  try {
    const staged = await getStagedUpload(db, req.params.showId);
    res.json(staged);
  } catch (err) {
    console.error('Failed to read staged upload:', err);
    res.status(500).json({ error: 'Failed to read staged upload' });
  }
});

const StagedBody = z.object({ s3Key: z.string().min(1), filename: z.string().min(1), sizeBytes: z.number().default(0) });
uploadsRouter.put('/staged/:showId', async (req, res) => {
  const parsed = StagedBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  if (!isValidStagedKey(parsed.data.s3Key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  try {
    await upsertStagedUpload(db, req.params.showId, parsed.data.s3Key, parsed.data.filename, parsed.data.sizeBytes);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save staged upload:', err);
    res.status(500).json({ error: 'Failed to save staged upload' });
  }
});

// Operator abandoning a staged pick (replace). See services/staged-video.ts
// for why this must delete the S3 object while the post-publish cleanup
// further down (inside the create route) must not.
uploadsRouter.delete('/staged/:showId', async (req, res) => {
  await deleteStagedVideo(req.params.showId);
  res.json({ ok: true });
});

// show_ids that already have a staged (uploaded, not-yet-published) video — for
// the "to process" table to flag which shows have a recording ready.
uploadsRouter.get('/staged', async (_req, res) => {
  try {
    res.json(await listStagedShowIds(db));
  } catch {
    res.status(500).json({ error: 'Failed to list staged shows' });
  }
});

// The most recent completed upload's video for a show — restores a published
// recording into the form (staged rows are cleared on publish). null if none.
uploadsRouter.get('/for-show/:showId', async (req, res) => {
  try {
    const row = await getLatestUploadForShow(db, req.params.showId);
    if (!row) return res.json(null);
    const filename = (row.video_s3_key.split('/').pop() ?? '').replace(/^\d+-/, '');
    res.json({ videoS3Key: row.video_s3_key, filename });
  } catch (err) {
    console.error('Failed to get show video:', err);
    res.status(500).json({ error: 'Failed to get show video' });
  }
});

// Presigned URL to preview the configured jingle (so the operator hears what
// gets prepended to the MixCloud audio). 404 when no jingle is set.
uploadsRouter.get('/jingle-preview', async (_req, res) => {
  if (!env.JINGLE_S3_KEY) return res.status(404).json({ error: 'No jingle configured' });
  try {
    const url = await createDownloadPresignedUrl(env.JINGLE_S3_KEY);
    res.json({ url, filename: env.JINGLE_S3_KEY.split('/').pop() ?? 'jingle' });
  } catch {
    res.status(500).json({ error: 'Failed to sign jingle URL' });
  }
});

uploadsRouter.post('/presign', async (req, res) => {
  const { filename, contentType } = req.body as { filename: string; contentType: string };
  if (!filename || !contentType) {
    return res.status(400).json({ error: 'filename and contentType required' });
  }
  const key = incomingKey(filename);
  try {
    const url = await createUploadPresignedUrl(key, contentType);
    res.json({ url, key });
  } catch {
    res.status(500).json({ error: 'Failed to create presigned URL' });
  }
});

uploadsRouter.post('/', async (req, res) => {
  const parsed = CreateUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;
  const jingleS3Key = env.JINGLE_S3_KEY ?? null;

  try {
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
      data.platforms.map((platform) =>
        createPlatformJob(db, { upload_id: upload.id, platform })
      )
    );

    // Don't run heavy work (transcode/upload) while a show is on air — defer the
    // jobs until the live window (plus buffer) clears. Fails open if PB is down.
    const live = await getLiveState(new Date());
    const delay = live.isLive && live.resumeAt ? Math.max(0, live.resumeAt.getTime() - Date.now()) : 0;
    if (delay > 0) {
      console.log(`Show live — deferring upload ${upload.id} jobs until ${live.resumeAt!.toISOString()}`);
    }

    await Promise.all(
      jobs.map((job) =>
        uploadQueue.add(
          job.platform,
          {
            jobId: job.id,
            uploadId: upload.id,
            platform: job.platform,
            videoS3Key: data.videoS3Key,
            title: data.title,
            description: data.description,
            tags: data.tags,
            imageUrl: data.imageUrl,
            jingleS3Key,
            includeJingle: data.includeJingle,
            autoTrimSilence: data.autoTrimSilence,
            trimStart: data.trimStart ?? null,
            trimEnd: data.trimEnd ?? null,
          },
          { delay }
        )
      )
    );

    // The show is now published — free its claim so it drops off everyone's
    // "being processed" list immediately, and clear the staged row. Row only —
    // see the DELETE /staged/:showId route above for why this must not touch S3.
    await releaseClaimForShow(db, data.showId);
    await deleteStagedUpload(db, data.showId).catch(() => {});
    void presenceHub.broadcastClaims();

    res.status(201).json({
      uploadId: upload.id,
      jobs,
      deferredUntil: delay > 0 ? live.resumeAt!.toISOString() : null,
    });
  } catch (err) {
    console.error('Failed to create upload:', err);
    res.status(500).json({ error: 'Failed to create upload' });
  }
});

// Re-run a single platform job that failed (or was interrupted by a worker
// restart). Reconstructs the payload from the stored upload row and re-enqueues.
uploadsRouter.post('/:uploadId/jobs/:platform/retry', async (req, res) => {
  const { uploadId, platform } = req.params;
  if (platform !== 'youtube' && platform !== 'mixcloud' && platform !== 'archive') {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  try {
    const upload = await getUploadWithJobs(db, uploadId);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });
    const job = upload.jobs.find((j) => j.platform === platform);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'processing') return res.status(409).json({ error: 'Job already running' });

    await resetPlatformJobForRetry(db, job.id);
    await uploadQueue.add(platform, {
      jobId: job.id,
      uploadId,
      platform,
      videoS3Key: upload.video_s3_key,
      title: upload.title,
      description: upload.description ?? '',
      tags: upload.tags ?? [],
      imageUrl: upload.image_url,
      jingleS3Key: upload.jingle_s3_key,
      includeJingle: !!upload.jingle_s3_key,
      autoTrimSilence: true,
      trimStart: upload.trim_start,
      trimEnd: upload.trim_end,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to retry job:', err);
    res.status(500).json({ error: 'Failed to retry job' });
  }
});

// (Re)generate the downloadable audio archive (m4a) for a completed upload —
// used when the archive job didn't run (e.g. a platform was marked done out of
// band). Reuses or creates the 'archive' job and enqueues the extraction.
uploadsRouter.post('/:uploadId/archive', async (req, res) => {
  try {
    const upload = await getUploadWithJobs(db, req.params.uploadId);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });
    const queued = await enqueueArchiveJob(db, upload);
    if (!queued) return res.status(409).json({ error: 'Already generating' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to enqueue audio archive:', err);
    res.status(500).json({ error: 'Failed to generate audio' });
  }
});

// Flip the PocketBase archive record to "published" — the explicit, separate
// step that makes the show live on the agenda site (distinct from uploading to
// the platforms). Everywhere else deliberately never touches `status`.
uploadsRouter.post('/:uploadId/publish', async (req, res) => {
  try {
    const upload = await getUploadWithJobs(db, req.params.uploadId);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });
    await updateArchiveRecord(upload.show_id, { status: 'published' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to publish archive record:', err);
    res.status(502).json({ error: 'Failed to publish archive record' });
  }
});

// Edit published metadata (title/description/tags) and push it to every place
// the show lives: the local DB, each published platform, and the PocketBase
// archive record. Platform failures are reported per-target, not fatal — the DB
// always updates so the operator's edit isn't lost.
const MetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
});
uploadsRouter.patch('/:uploadId/metadata', async (req, res) => {
  const parsed = MetadataSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const edit = parsed.data;
  try {
    const upload = await getUploadWithJobs(db, req.params.uploadId);
    if (!upload) return res.status(404).json({ error: 'Upload not found' });

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
      // edited names to genre IDs (creating any new ones). Only write the relation
      // when tags are present, so clearing tags never wipes curated genres.
      const genres = edit.tags.length ? await resolveGenreIds(edit.tags) : [];
      // Re-assert the published platform links too, so an edit fully re-syncs the
      // archive record (e.g. after a write-back that failed at publish time).
      const mediaLinks: { label: string; type: string; url: string }[] = [];
      if (yt) mediaLinks.push({ label: 'YouTube', type: 'video', url: yt.result_url! });
      if (mc) mediaLinks.push({ label: 'MixCloud', type: 'audio', url: mc.result_url! });
      await updateArchiveRecord(upload.show_id, {
        // The archive record keeps the plain title; the date/@coming-soon suffix
        // is only for the platform titles.
        title: baseTitle(edit.title),
        notes: edit.description,
        ...(genres.length ? { genres } : {}),
        ...(mediaLinks.length ? { mediaLinks } : {}),
      });
      sync.pocketbase = 'ok';
    } catch (err) {
      sync.pocketbase = err instanceof Error ? err.message : String(err);
    }

    res.json({ ok: true, sync });
  } catch (err) {
    console.error('Failed to update metadata:', err);
    res.status(500).json({ error: 'Failed to update metadata' });
  }
});

// --- Managing an already-published platform link (from the "Publish to" section
// on the upload form). These act on a platform URL / archive record directly,
// independent of any show_uploads row, so they work for shows published by any
// means. Each returns { error } (a string on failure, null on success).

// Push the current form metadata to a single already-published platform.
const PlatformUpdateSchema = z.object({
  platform: z.enum(['youtube', 'mixcloud']),
  url: z.string().url(),
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  // The current PocketBase cover — re-synced to MixCloud's artwork when present.
  imageUrl: z.string().url().nullable().default(null),
});
uploadsRouter.post('/platform/update', async (req, res) => {
  const parsed = PlatformUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  const { platform, url, imageUrl, ...edit } = parsed.data;
  try {
    const error =
      platform === 'youtube'
        ? await syncYoutubeMetadata(url, edit)
        : await syncMixcloudMetadata(url, edit, imageUrl);
    res.json({ error });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Read a YouTube video's real privacy status so the UI can reflect it (public
// hides the "set public" button). Never throws — returns { privacyStatus, error }.
uploadsRouter.get('/platform/youtube-status', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return res.status(400).json({ privacyStatus: null, error: 'url required' });
  res.json(await getYoutubePrivacyStatus(url));
});

// Flip a published YouTube video to public (needs the force-ssl scope).
const SetPublicSchema = z.object({ url: z.string().url() });
uploadsRouter.post('/platform/set-public', async (req, res) => {
  const parsed = SetPublicSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  try {
    const error = await setYoutubePublic(parsed.data.url);
    res.json({ error });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Un-link a platform from the archive record (removes the mediaLink so it's no
// longer shown as published and can be re-published). Does NOT delete the actual
// video/cloudcast — that stays live on the platform.
const RemoveLinkSchema = z.object({ showId: z.string().min(1), label: z.string().min(1) });
uploadsRouter.post('/platform/remove', async (req, res) => {
  const parsed = RemoveLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  try {
    await removeArchiveMediaLink(parsed.data.showId, parsed.data.label);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to remove media link:', err);
    res.status(502).json({ error: 'Failed to remove link' });
  }
});

uploadsRouter.get('/', async (_req, res) => {
  try {
    const uploads = await listUploadsWithJobs(db);
    res.json(await Promise.all(uploads.map(withDownloadUrls)));
  } catch {
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

uploadsRouter.get('/:id', async (req, res) => {
  try {
    const upload = await getUploadWithJobs(db, req.params.id);
    if (!upload) return res.status(404).json({ error: 'Not found' });
    res.json(await withDownloadUrls(upload));
  } catch {
    res.status(500).json({ error: 'Failed to get upload' });
  }
});
