import type { Job } from 'bullmq';
import fs from 'fs';
import type { JobPayload } from '../types';
import type { WorkerDeps } from '../ports';
import { compressVideo, cleanup } from '../services/ffmpeg';
import { createWorkspace } from '../services/workspace';

/**
 * Shrink an already-archived show's video in place: same S3 key, smaller file.
 *
 * Operator-triggered, on-demand (see uploads.compressArchiveVideo) — unlike the
 * other platform jobs this never auto-enqueues. Only ever runs against a show
 * already sitting in the browser-playable MP4 layout, so unlike processArchive
 * there is no container/trim/loudness branching: one input, one re-encode, one
 * upload back over the same key.
 */
export async function processCompress(
  job: Job<JobPayload>,
  { store, records }: Pick<WorkerDeps, 'store' | 'records'>
): Promise<string> {
  const { jobId, uploadId, videoS3Key } = job.data;

  if (!/\.mp4$/i.test(videoS3Key)) {
    const msg = `Cannot shrink ${videoS3Key} — not an mp4 archive yet (run remux first)`;
    await records.setJobStatus(jobId, 'failed', { error: msg });
    throw new Error(msg);
  }

  await records.setJobStatus(jobId, 'processing', { progress_pct: 0 });

  const ws = createWorkspace(jobId);
  const inputPath = ws.path('input.mp4');
  const outputPath = ws.path('compressed.mp4');

  try {
    await job.updateProgress({ uploadId, platform: 'compress', pct: 5 });
    await store.download(videoS3Key, inputPath);

    await records.setJobStatus(jobId, 'processing', { progress_pct: 10 });
    await job.updateProgress({ uploadId, platform: 'compress', pct: 10 });

    await compressVideo(inputPath, outputPath, {
      onProgress: async (pct) => {
        const adjusted = 10 + Math.round(pct * 0.8);
        await records.setJobStatus(jobId, 'processing', { progress_pct: adjusted });
        await job.updateProgress({ uploadId, platform: 'compress', pct: adjusted });
      },
    });

    // A well-encoded source can come out of CRF 23 the same size or larger —
    // this button is meant to stay pressable on any future outlier, not just
    // the two it was built for, so that has to fail loudly rather than
    // silently replace a fine file with a same-size (or bigger) lossy copy.
    const inputSize = fs.statSync(inputPath).size;
    const outputSize = fs.statSync(outputPath).size;
    if (outputSize >= inputSize) {
      throw new Error(
        `Re-encode came out ${outputSize} bytes, not smaller than the ${inputSize}-byte original — already efficiently encoded, nothing to shrink`
      );
    }

    // Original no longer needed — drop it before the upload so /tmp isn't
    // holding the recording twice while a multi-GB PUT runs.
    cleanup(inputPath);

    await store.upload(outputPath, videoS3Key, 'video/mp4');

    const size = await store.size(videoS3Key);
    if (!size) throw new Error(`Compressed MP4 missing or empty on S3: ${videoS3Key}`);

    await records.setJobStatus(jobId, 'done', { progress_pct: 100 });
    await job.updateProgress({ uploadId, platform: 'compress', pct: 100 });

    return JSON.stringify({ uploadId, platform: 'compress', key: videoS3Key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await records.setJobStatus(jobId, 'failed', { error: msg });
    throw err;
  } finally {
    ws.cleanup();
  }
}
