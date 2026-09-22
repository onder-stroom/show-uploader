import type { Job } from 'bullmq';
import fs from 'fs';
import type { JobPayload } from '../types';
import type { WorkerDeps } from '../ports';
import { prependJingle, captureSquareFrame, measureLoudness } from '../services/ffmpeg';
import { baseTitle, htmlToText } from '@show-uploader/domain';
import { createWorkspace } from '../services/workspace';

/**
 * Upload the ARCHIVED audio to MixCloud.
 *
 * A thin upload on purpose: the archive job already extracted, trimmed and
 * normalised the audio — this job is enqueued by it, receives the finished
 * shows/<slug>/audio.m4a, and only prepends the jingle when asked. What
 * MixCloud plays is the archive's own audio, and the extraction work happens
 * exactly once.
 */
export async function processMixcloud(
  job: Job<JobPayload>,
  { store, records, agenda, mixcloud }: Pick<WorkerDeps, 'store' | 'records' | 'agenda' | 'mixcloud'>
): Promise<string> {
  const { jobId, uploadId, videoS3Key, audioS3Key, title, description, tags, imageUrl, jingleS3Key, includeJingle } =
    job.data;

  await records.setJobStatus(jobId, 'processing', { progress_pct: 0 });

  if (!audioS3Key) {
    // Platform jobs are enqueued by the archive job with both keys — a payload
    // without one predates the inversion or was hand-built wrong.
    const msg = 'No archived audio for this upload — run the archive job first';
    await records.setJobStatus(jobId, 'failed', { error: msg });
    throw new Error(msg);
  }

  const ws = createWorkspace(jobId);
  const audioPath = ws.path('audio.m4a');
  const jinglePath = ws.path('jingle.m4a');
  const mergedPath = ws.path('merged.m4a');
  const thumbPath = ws.path('cover.jpg');
  const videoPath = ws.path('video.mp4');

  try {
    await job.updateProgress({ uploadId, platform: 'mixcloud', pct: 5 });
    await store.download(audioS3Key, audioPath);

    await records.setJobStatus(jobId, 'processing', { progress_pct: 25 });
    await job.updateProgress({ uploadId, platform: 'mixcloud', pct: 25 });

    let finalAudioPath = audioPath;

    if (includeJingle && jingleS3Key) {
      // A missing/misconfigured jingle must not fail the whole upload — publish
      // the audio as-is and warn instead.
      try {
        await store.download(jingleS3Key, jinglePath);
        // Measured separately so the jingle lands at the same target as the show
        // rather than whatever level it happens to be mastered at. The show
        // audio itself is already at target — the archive job put it there.
        const jingleLoudness = await measureLoudness(jinglePath);
        await prependJingle(jinglePath, audioPath, mergedPath, jingleLoudness);
        finalAudioPath = mergedPath;
      } catch (err) {
        console.warn(
          `Jingle "${jingleS3Key}" unavailable — publishing without it:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    await records.setJobStatus(jobId, 'processing', { progress_pct: 50 });
    await job.updateProgress({ uploadId, platform: 'mixcloud', pct: 50 });

    // Cover art: the PocketBase record image (the master cover, set by the
    // operator) wins; otherwise a square frame grabbed 20s into the archived
    // video — fetched only for this, since the audio upload needs no video.
    // Both are non-fatal — publish coverless if they fail.
    if (imageUrl) {
      const cover = await agenda.fetchCover(imageUrl);
      if (cover) await fs.promises.writeFile(thumbPath, cover);
    }
    if (!fs.existsSync(thumbPath)) {
      try {
        await store.download(videoS3Key, videoPath);
        await captureSquareFrame(videoPath, thumbPath, 20);
      } catch (err) {
        console.warn('Cover frame capture failed:', err instanceof Error ? err.message : err);
      }
    }

    await records.setJobStatus(jobId, 'processing', { progress_pct: 70 });
    await job.updateProgress({ uploadId, platform: 'mixcloud', pct: 70 });

    const resultUrl = await mixcloud.upload({
      audioPath: finalAudioPath,
      title,
      // MixCloud wants plain text; the description is rich-text HTML (the PB master).
      description: htmlToText(description),
      tags,
      imagePath: fs.existsSync(thumbPath) ? thumbPath : undefined,
    });

    await records.setJobStatus(jobId, 'done', { result_url: resultUrl, progress_pct: 100 });
    await job.updateProgress({ uploadId, platform: 'mixcloud', pct: 100 });

    // Write MixCloud's link back immediately (merged with any existing links).
    const row = await records.getUpload(uploadId);
    if (row) {
      await agenda.finalize(row.show_id, {
        title: baseTitle(title),
        notes: description,
        tags,
        mediaLinks: [{ label: 'MixCloud', type: 'audio', url: resultUrl }],
      });
    }

    return JSON.stringify({ uploadId, platform: 'mixcloud', url: resultUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await records.setJobStatus(jobId, 'failed', { error: msg });
    throw err;
  } finally {
    ws.cleanup();
  }
}
