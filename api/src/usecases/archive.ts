import type { PlatformJob } from '../db/queries';
import type { ApiDeps } from '../ports';
import { readyToArchive } from '@show-uploader/domain';
import { UseCaseError } from './errors';

// An upload row for an archived show, found or created. Actions on the archive
// catalogue (shrink, publish-to-platform) create whatever bookkeeping they need
// — the operator never prepares a row so that a button becomes pressable. A
// show whose upload row was cleared along with its finished jobs gets a fresh
// one here, built from the archive record and its S3 folder, exactly like
// adopting does.
export async function adoptArchivedUpload(
  showId: string,
  { uploads, objects, agenda }: Pick<ApiDeps, 'uploads' | 'objects' | 'agenda'>
) {
  const existing = await uploads.latestForShow(showId);
  if (existing) return existing;

  const show = await agenda.getShow(showId);
  if (!show) throw new UseCaseError('NOT_FOUND', 'Show not found');
  const folder = await objects.findShowFolder(show);
  if (!folder) throw new UseCaseError('NOT_FOUND', 'No archived recording found on S3');
  const videoS3Key = `${folder}video.mp4`;
  if (!(await objects.info(videoS3Key)).exists) {
    throw new UseCaseError('NOT_FOUND', 'No archived video found on S3');
  }
  const audioS3Key = `${folder}audio.m4a`;
  const audioInfo = await objects.info(audioS3Key);
  const row = await uploads.create({
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

// (Re)generate the downloadable audio archive (m4a). Reuses or creates the
// 'archive' job and enqueues extraction.
export async function generateAudio(
  uploadId: string,
  { uploads, queue }: Pick<ApiDeps, 'uploads' | 'queue'>
): Promise<void> {
  const upload = await uploads.get(uploadId);
  if (!upload) throw new UseCaseError('NOT_FOUND', 'Upload not found');
  if (!(await queue.enqueueArchive(upload))) throw new UseCaseError('CONFLICT', 'Already generating');
}

// Shrink an already-archived show's video via a real re-encode (see
// worker/src/services/ffmpeg.ts compressVideo). Unlike remux this is lossy and
// operator-triggered per show, for the rare recording that came out of OBS at a
// much higher bitrate than usual.
export async function compressArchivedVideo(
  showId: string,
  deps: Pick<ApiDeps, 'uploads' | 'objects' | 'agenda' | 'queue'>
): Promise<void> {
  const upload = await adoptArchivedUpload(showId, deps);

  // The key's location carries the "safe to rewrite" guarantee: shows/ is the
  // published layout, written only when archiving completed, so nothing else is
  // still reading or writing this object — except a job in flight right now,
  // which is the one thing left to check.
  if (!upload.video_s3_key.startsWith('shows/') || !/\.mp4$/i.test(upload.video_s3_key)) {
    throw new UseCaseError('PRECONDITION_FAILED', 'Not an archived mp4 yet — run the mp4 conversion first');
  }
  if (upload.jobs.some((j) => j.status === 'queued' || j.status === 'processing')) {
    throw new UseCaseError(
      'PRECONDITION_FAILED',
      'This recording is still being processed — try again once it finishes'
    );
  }
  if (!(await deps.queue.enqueueCompress(upload))) {
    throw new UseCaseError('CONFLICT', 'Already shrinking this recording');
  }
}

// Backfill for recordings that predate the MP4 remux: re-run the archive job on
// every upload whose video is still in its original container. The job is the
// same one a single upload gets, so this needs no separate code path — and it's
// safe to run twice, since an upload drops off the list once its video_s3_key
// ends in .mp4.
export async function remuxBackfill({
  uploads,
  queue,
}: Pick<ApiDeps, 'uploads' | 'queue'>): Promise<{ enqueued: number; skipped: number }> {
  const pending = await uploads.needingRemux();
  let enqueued = 0;
  for (const upload of pending) {
    // Same precondition the worker uses before auto-enqueuing an archive: the
    // archive replaces the source video on S3, so it must not run while a
    // platform job still needs the original file.
    if (!readyToArchive(upload.jobs)) continue;
    if (await queue.enqueueArchive(upload)) enqueued++;
  }
  return { enqueued, skipped: pending.length - enqueued };
}
