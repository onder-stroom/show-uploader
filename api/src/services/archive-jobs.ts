import type { Sql } from 'postgres';
import { createPlatformJob, resetPlatformJobForRetry } from '../db/queries';
import type { PlatformJob, ShowUpload } from '../db/queries';
import { uploadQueue, compressQueue } from '../queue';

/**
 * Drop an upload's not-yet-started jobs from the queue.
 *
 * Deleting the DB row alone isn't enough: BullMQ holds its own copy of the
 * payload, so a waiting job would still run and publish to YouTube or MixCloud
 * after the operator removed it. Jobs are matched on payload uploadId — the
 * BullMQ job id isn't stored anywhere.
 *
 * Returns the number of jobs still running, which can't be removed while a
 * worker holds their lock. Those finish, then write to rows that no longer
 * exist (a no-op UPDATE), so nothing breaks — but the work isn't stopped.
 */
export async function cancelQueuedJobs(uploadId: string): Promise<{ removed: number; active: number }> {
  const jobs = await uploadQueue.getJobs(['waiting', 'delayed', 'paused', 'failed']);
  let removed = 0;
  for (const job of jobs) {
    if (job.data?.uploadId !== uploadId) continue;
    // Racy by nature: a job can start between the fetch and the remove, which
    // throws. Treat that as "still active" rather than failing the delete.
    try {
      await job.remove();
      removed++;
    } catch {
      /* picked up by a worker in the meantime */
    }
  }
  const active = (await uploadQueue.getJobs(['active'])).filter((j) => j.data?.uploadId === uploadId).length;
  return { removed, active };
}

/**
 * Queue the 'archive' job for an upload — it extracts the downloadable m4a and
 * remuxes the recording to MP4. Reuses the upload's existing archive job row
 * (resetting it) so re-running never piles up duplicate rows.
 *
 * Returns false when the job is already running; the caller decides whether
 * that's a conflict (single upload) or just a skip (backfill).
 */
export async function enqueueArchiveJob(
  db: Sql,
  upload: ShowUpload & { jobs: PlatformJob[] },
  // includeJingle rides along for the platform jobs the archive enqueues when
  // it finishes — the operator's checkbox isn't persisted anywhere else.
  // autoTrimSilence is the form's "cut dead air" checkbox; defaults to on, as
  // the form does, for callers with no operator choice to pass.
  opts?: { delay?: number; includeJingle?: boolean; autoTrimSilence?: boolean }
): Promise<boolean> {
  let job = upload.jobs.find((j) => j.platform === 'archive');
  if (job?.status === 'processing') return false;

  if (!job) job = await createPlatformJob(db, { upload_id: upload.id, platform: 'archive' });
  else await resetPlatformJobForRetry(db, job.id);

  await uploadQueue.add(
    'archive',
    {
      jobId: job.id,
      uploadId: upload.id,
      platform: 'archive',
      videoS3Key: upload.video_s3_key,
      title: upload.title,
      description: upload.description ?? '',
      tags: upload.tags ?? [],
      imageUrl: upload.image_url,
      jingleS3Key: upload.jingle_s3_key,
      includeJingle: opts?.includeJingle ?? false,
      autoTrimSilence: opts?.autoTrimSilence ?? true,
      trimStart: upload.trim_start,
      trimEnd: upload.trim_end,
    },
    opts?.delay ? { delay: opts.delay } : {}
  );
  return true;
}

/**
 * Queue the 'compress' job for an already-archived upload — a real re-encode
 * that shrinks the video in place (same S3 key), unlike the lossless remux the
 * 'archive' job does. Operator-triggered only, never auto-enqueued: it's a
 * judgment call about one outlier recording, not something every upload needs.
 *
 * Same reuse-or-reset-the-row shape as enqueueArchiveJob, so pressing the
 * button again after a failure (or to shrink further) just re-runs it.
 *
 * Guards against a double-click enqueueing the same recording twice: 'queued'
 * blocks the same as 'processing' (a queued-but-not-yet-started job would
 * otherwise get a second BullMQ entry racing the first over the same S3 key),
 * and the insert's unique(upload_id, platform) index is the backstop for two
 * concurrent requests both finding no existing row.
 *
 * One attempt only (overriding the queue's default retries): a failure here
 * may land after the re-encoded file already replaced the original on S3, so
 * an automatic retry would re-download and re-compress the already-lossy
 * output. Requiring the operator to press the button again keeps that a
 * deliberate, visible choice instead of a silent second generation of loss.
 */
export async function enqueueCompressJob(
  db: Sql,
  upload: ShowUpload & { jobs: PlatformJob[] }
): Promise<boolean> {
  let job = upload.jobs.find((j) => j.platform === 'compress');
  if (job?.status === 'processing' || job?.status === 'queued') return false;

  if (!job) {
    try {
      job = await createPlatformJob(db, { upload_id: upload.id, platform: 'compress' });
    } catch (err) {
      // Unique violation: another request created the row first between the
      // lookup above and this insert. Treat it the same as "already running".
      if ((err as { code?: string }).code === '23505') return false;
      throw err;
    }
  } else {
    await resetPlatformJobForRetry(db, job.id);
  }

  await compressQueue.add(
    'compress',
    {
      jobId: job.id,
      uploadId: upload.id,
      platform: 'compress',
      videoS3Key: upload.video_s3_key,
      title: '',
      description: '',
      tags: [],
      imageUrl: null,
      jingleS3Key: null,
      includeJingle: false,
      trimStart: null,
      trimEnd: null,
    },
    { attempts: 1 }
  );
  return true;
}
