import type { Job } from 'bullmq';
import path from 'path';
import type { PreviewJobPayload } from '../types';
import type { WorkerDeps } from '../ports';
import { remuxToMp4, cleanup } from '../services/ffmpeg';
import { createWorkspace } from '../services/workspace';

/**
 * Make a recording playable in a browser, before it is published.
 *
 * MKV/AVI don't play in any browser, so the prepare screen can't preview them.
 * Rather than keep a throwaway preview copy alongside the original, this does
 * the SAME rewrap the archive job would have done later (`-c:v copy`, lossless)
 * and replaces the source with it. The archive job then finds an MP4 and skips
 * its own remux, so the work is moved earlier, not duplicated.
 *
 * Deliberately untrimmed: the operator previews in order to DECIDE the trim.
 * The archive job still applies the trim to this MP4 at publish time.
 *
 * Deletion order matches archive.ts and is the reason this is safe to run on the
 * only copy of a recording: upload, prove the object landed, repoint the DB, and
 * only then drop the original. A failure before the repoint leaves the source on
 * S3 and still referenced, so pressing preview again simply retries.
 */
export async function processPreview(
  job: Job<PreviewJobPayload>,
  { store, records }: Pick<WorkerDeps, 'store' | 'records'>
): Promise<string> {
  const { videoS3Key } = job.data;

  const ext = path.extname(videoS3Key);
  // Already playable — the API never enqueues this, but a stale queued job must
  // not re-run the rewrap and delete a file that is already the MP4.
  if (ext.toLowerCase() === '.mp4') return videoS3Key;

  // The API sets a deterministic job id (a hash of the key); the key itself is
  // the fallback, and createWorkspace sanitises it into one path segment.
  const ws = createWorkspace(job.id ?? videoS3Key);
  const inputPath = ws.path(`input${ext || '.mkv'}`);
  const mp4Path = ws.path('preview.mp4');
  const mp4Key = `${videoS3Key.slice(0, videoS3Key.length - ext.length)}.mp4`;

  try {
    await job.updateProgress(5);
    await store.download(videoS3Key, inputPath);

    await remuxToMp4(inputPath, mp4Path, {
      onProgress: async (pct) => {
        // Download is the first slice of the wait, so the remux drives 10–95.
        await job.updateProgress(10 + Math.round(pct * 0.85));
      },
    });

    // Drop the source locally before the PUT so /tmp isn't holding the recording
    // twice while a multi-GB upload runs.
    cleanup(inputPath);

    await store.upload(mp4Path, mp4Key, 'video/mp4');

    const size = await store.size(mp4Key);
    if (!size) throw new Error(`Remuxed MP4 missing or empty on S3: ${mp4Key}`);

    const filename = `${path.basename(videoS3Key, ext)}.mp4`;
    const repointed = await records.repointPreview(videoS3Key, mp4Key, filename, size);

    // Nothing references this recording any more — the record was replaced or
    // removed while the remux ran. Deleting the source now would strand the MP4
    // with nothing pointing at it, so stop while the original is still intact.
    if (repointed === 0) {
      throw new Error(`No pre-publish record still points at ${videoS3Key}; left the source in place`);
    }

    await job.updateProgress(100);

    // Past the point of no return: the MP4 is verified and the rows point at it.
    // A failure here leaves an orphan, never a dead link.
    await store.delete(videoS3Key).catch((err) =>
      console.warn(`Remuxed to ${mp4Key} but could not delete ${videoS3Key}:`, err)
    );

    return mp4Key;
  } finally {
    ws.cleanup();
  }
}
