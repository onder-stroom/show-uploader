import { platformOfLabel, platformTitle } from '@show-uploader/domain';
import type { ApiDeps } from '../ports';
import { adoptArchivedUpload } from './archive';
import { UseCaseError } from './errors';

export type Platform = 'youtube' | 'mixcloud';

export type PublishInput = {
  showId: string;
  title: string;
  description: string;
  tags: string[];
  imageUrl: string | null;
  videoS3Key: string;
  // Empty is valid: attaching a recording to a show already published elsewhere
  // needs nothing to publish, just the archive step.
  platforms: Platform[];
  includeJingle: boolean;
  autoTrimSilence: boolean;
  trimStart?: string | null;
  trimEnd?: string | null;
};

/**
 * Publish a recording: create the upload and a job row per platform, enqueue
 * the archive (deferred while a show is on air), release the show claim and
 * clear the staged upload.
 */
export async function publishUpload(
  data: PublishInput,
  { uploads, agenda, queue, presence, config }: Pick<ApiDeps, 'uploads' | 'agenda' | 'queue' | 'presence' | 'config'>
) {
  const jingleS3Key = config.jingleS3Key;

  // Refuse to publish somewhere this show already is. The form hides those
  // platforms, but that's a view of the record as it looked when the page
  // loaded — someone can add a link in the agenda meanwhile, or an old tab can
  // submit. Publishing twice creates a second video or cloudcast that has to be
  // taken down by hand, so it's worth a check the UI can't skip.
  if (data.platforms.length > 0) {
    const show = await agenda.getShow(data.showId);
    const already = new Set((show?.mediaLinks ?? []).map((l) => platformOfLabel(l.label)).filter(Boolean));
    const duplicate = data.platforms.filter((p) => already.has(p));
    if (duplicate.length > 0) {
      throw new UseCaseError(
        'CONFLICT',
        `This show is already published to ${duplicate.join(' and ')}. Remove the existing link on the agenda record first if you mean to publish again.`
      );
    }
  }

  const upload = await uploads.create({
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
    data.platforms.map((platform) => uploads.createJob(upload.id, platform))
  );

  // Don't run heavy work (transcode/upload) while a show is on air — defer the
  // jobs until the live window (plus buffer) clears. Fails open if PB is down.
  const live = await agenda.liveState(new Date());
  const delay = live.isLive && live.resumeAt ? Math.max(0, live.resumeAt.getTime() - Date.now()) : 0;
  if (delay > 0) {
    console.log(`Show live — deferring upload ${upload.id} jobs until ${live.resumeAt!.toISOString()}`);
  }

  // Archive first, always: one download, one trim, one loudness pass producing
  // the two canonical files, and the platform jobs upload THOSE. Their rows are
  // created queued here so the operator sees the whole pipeline at submit, but
  // only the archive job enters the queue — it enqueues the platforms itself
  // when its artefacts exist. That ordering is what makes "MixCloud succeeded
  // but the archive failed" impossible, and it cut the per-show work to a third.
  await queue.enqueueArchive(
    { ...upload, jobs },
    { delay, includeJingle: data.includeJingle, autoTrimSilence: data.autoTrimSilence }
  );

  // The show is now published — free its claim so it drops off everyone's
  // "being processed" list immediately, and clear the staged row. Row only: its
  // s3_key is what data.videoS3Key just became, so unlike deleteStagedVideo (the
  // operator's "replace" action) this must never touch S3 — that would delete
  // the video the show now points at, seconds after publish.
  await uploads.releaseClaim(data.showId);
  await uploads.clearStaged(data.showId).catch(() => {});
  presence.broadcastClaims();

  return {
    uploadId: upload.id,
    jobs,
    deferredUntil: delay > 0 ? live.resumeAt!.toISOString() : null,
  };
}

// Re-run a single job, rebuilding the payload from the stored upload row.
export async function retryJob(
  uploadId: string,
  platform: Platform | 'archive',
  { uploads, queue }: Pick<ApiDeps, 'uploads' | 'queue'>
): Promise<void> {
  const upload = await uploads.get(uploadId);
  if (!upload) throw new UseCaseError('NOT_FOUND', 'Upload not found');
  const job = upload.jobs.find((j) => j.platform === platform);
  if (!job) throw new UseCaseError('NOT_FOUND', 'Job not found');
  if (job.status === 'processing') throw new UseCaseError('CONFLICT', 'Job already running');

  // Platforms upload archive artefacts; retrying one before those exist would
  // hand it the raw source (or nothing, for audio). The archive job enqueues
  // them itself when it finishes — including after its own retry — so the answer
  // here is "retry the archive", not a dead job.
  if (platform !== 'archive') {
    const archiveDone = upload.jobs.some((j) => j.platform === 'archive' && j.status === 'done');
    if (!archiveDone) {
      throw new UseCaseError(
        'PRECONDITION_FAILED',
        'The archive step has not finished — retry that first; it starts the platform uploads itself.'
      );
    }
  }

  // The archive retries the way it first ran: from the row's source key and
  // trim. The row keeps the trim until an archive succeeds (the worker clears
  // it along with repointing the key at the trimmed file under shows/), so a
  // failed first run is retried trimmed and a finished one isn't cut twice.
  // Silence detection follows the same line. The operator's checkbox isn't
  // stored, so an unfinished archive gets the form's default (on).
  if (platform === 'archive') {
    const queued = await queue.enqueueArchive(upload, {
      includeJingle: !!upload.jingle_s3_key,
      autoTrimSilence: !upload.video_s3_key.startsWith('shows/'),
    });
    if (!queued) throw new UseCaseError('CONFLICT', 'Job already running');
    return;
  }

  await uploads.resetJob(job.id);
  await queue.enqueuePlatform({
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
}

/**
 * Post an archived recording to one platform it isn't on yet — no re-upload, no
 * new processing: the job is the same thin platform upload the archive pipeline
 * enqueues, fed the finished shows/<folder>/ artefacts. This is how a show that
 * skipped MixCloud (or any platform added later) gets published there afterwards.
 */
export async function publishToPlatform(
  showId: string,
  platform: Platform,
  deps: Pick<ApiDeps, 'uploads' | 'objects' | 'agenda' | 'queue' | 'config'>
): Promise<{ jobId: string }> {
  const { uploads, queue, config } = deps;
  const show = await deps.agenda.getShow(showId);
  if (!show) throw new UseCaseError('NOT_FOUND', 'Show not found');
  // Same duplicate guard as publishUpload: the record's links are the truth
  // about where this show already lives.
  if ((show.mediaLinks ?? []).some((l) => platformOfLabel(l.label) === platform)) {
    throw new UseCaseError('CONFLICT', `Already published on ${platform}`);
  }

  const upload = await adoptArchivedUpload(showId, deps);
  if (!upload.video_s3_key.startsWith('shows/')) {
    throw new UseCaseError('PRECONDITION_FAILED', 'Not archived yet — the archive job must finish first');
  }
  if (platform === 'mixcloud' && !upload.audio_s3_key) {
    throw new UseCaseError('PRECONDITION_FAILED', 'No archived audio for this show');
  }
  const existing = upload.jobs.find((j) => j.platform === platform);
  if (existing && (existing.status === 'queued' || existing.status === 'processing')) {
    throw new UseCaseError('CONFLICT', `A ${platform} upload is already running`);
  }

  // A finished/failed row from an earlier post is common (a deleted duplicate, a
  // first attempt). The (upload_id, platform) unique index means a blind insert
  // 500s — reuse and reset the row instead, exactly like retryJob and
  // enqueueCompressJob do.
  const job = existing
    ? (await uploads.resetJob(existing.id), existing)
    : await uploads.createJob(upload.id, platform);
  await queue.enqueuePlatform({
    jobId: job.id,
    uploadId: upload.id,
    platform,
    videoS3Key: upload.video_s3_key,
    audioS3Key: upload.audio_s3_key,
    // platformTitle strips any existing "<date> @ coming soon" suffix before
    // re-adding, so it's correct for both a fresh row (raw record title) and an
    // old one that already carries the convention.
    title: platformTitle(upload.title, show.date),
    description: upload.description ?? '',
    tags: upload.tags ?? [],
    imageUrl: show.imageUrl,
    // The archived audio is jingle-less by design (the jingle is prepended per
    // platform); posting later should sound like posting right away, so the
    // configured jingle rides along.
    jingleS3Key: config.jingleS3Key,
    includeJingle: !!config.jingleS3Key,
    trimStart: null,
    trimEnd: null,
  });
  return { jobId: job.id };
}
