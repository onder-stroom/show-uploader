import type { Job } from 'bullmq';
import type { JobPayload } from '../types';
import { downloadFromS3 } from '../services/s3';
import { uploadToYoutube } from '../services/youtube-client';
import { setJobStatus, getUploadRow } from '../db';
import { createWorkspace } from '../services/workspace';
import { finalizeArchiveRecord } from '../services/shows-api';
import { baseTitle, htmlToText } from '@show-uploader/domain';

/**
 * Upload the ARCHIVED video to YouTube.
 *
 * A thin upload on purpose: the archive job already trimmed, normalised and
 * remuxed the recording — this job is enqueued by it, receives the finished
 * shows/<slug>/video.mp4, and does nothing to it. What YouTube serves is
 * bit-identical to what the archive holds, and the transcode work happens
 * exactly once, in the one job whose name says so.
 */
export async function processYoutube(job: Job<JobPayload>): Promise<string> {
  const { jobId, uploadId, videoS3Key, title, description, tags } = job.data;

  await setJobStatus(jobId, 'processing', { progress_pct: 0 });

  const ws = createWorkspace(jobId);
  const videoPath = ws.path('video.mp4');
  try {
    await job.updateProgress({ uploadId, platform: 'youtube', pct: 5 });
    await downloadFromS3(videoS3Key, videoPath);

    await setJobStatus(jobId, 'processing', { progress_pct: 20 });
    await job.updateProgress({ uploadId, platform: 'youtube', pct: 20 });

    const resultUrl = await uploadToYoutube({
      videoPath,
      title,
      // YouTube wants plain text; the description is rich-text HTML (the PB master).
      description: htmlToText(description),
      tags,
      onProgress: async (pct) => {
        const adjusted = 20 + Math.round(pct * 0.78);
        await setJobStatus(jobId, 'processing', { progress_pct: adjusted });
        await job.updateProgress({ uploadId, platform: 'youtube', pct: adjusted });
      },
    });

    // No custom thumbnail — YouTube's auto-chosen frame is fine.
    await setJobStatus(jobId, 'done', { result_url: resultUrl, progress_pct: 100 });
    await job.updateProgress({ uploadId, platform: 'youtube', pct: 100 });

    // Write this platform's link back to PocketBase immediately (merged), so the
    // archive record is updated the moment YouTube is done — no waiting on MixCloud.
    const row = await getUploadRow(uploadId);
    if (row) {
      await finalizeArchiveRecord(row.show_id, {
        title: baseTitle(title),
        notes: description,
        tags,
        mediaLinks: [{ label: 'YouTube', type: 'video', url: resultUrl }],
      });
    }

    return JSON.stringify({ uploadId, platform: 'youtube', url: resultUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setJobStatus(jobId, 'failed', { error: msg });
    throw err;
  } finally {
    ws.cleanup();
  }
}
