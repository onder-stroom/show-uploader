import type { Job } from 'bullmq';
import path from 'path';
import type { JobPayload } from '../types';
import type { WorkerDeps } from '../ports';
import {
  extractAudio,
  remuxToMp4,
  trimVideoCopy,
  resolveTrim,
  measureLoudness,
  cleanup,
  probeDuration,
  hms,
  type LoudnessMeasurement,
} from '../services/ffmpeg';
import { createWorkspace } from '../services/workspace';
import { showAudioKey, showVideoKey } from '@show-uploader/domain';

type ArchiveDeps = Pick<WorkerDeps, 'store' | 'records' | 'agenda' | 'platformQueue' | 'config'>;

export async function processArchive(job: Job<JobPayload>, deps: ArchiveDeps): Promise<string> {
  const { store, records, platformQueue, config } = deps;
  const { jobId, uploadId, videoS3Key, trimStart, trimEnd, autoTrimSilence } = job.data;

  await records.setJobStatus(jobId, 'processing', { progress_pct: 0 });

  const ext = path.extname(videoS3Key) || '.mkv';
  const base = path.basename(videoS3Key, ext);
  const ws = createWorkspace(jobId);
  const inputPath = ws.path(`input${ext}`);
  const audioPath = ws.path('archive.m4a');
  const mp4Path = ws.path('archive.mp4');

  // Both stores in one call: the row drives the archive page, the job event
  // drives the live SSE bar, and letting them drift makes a finished job look
  // stuck on one screen and not the other.
  const report = async (pct: number) => {
    await records.setJobStatus(jobId, 'processing', { progress_pct: pct });
    await job.updateProgress({ uploadId, platform: 'archive', pct });
  };

  try {
    await job.updateProgress({ uploadId, platform: 'archive', pct: 5 });
    await store.download(videoS3Key, inputPath);

    await report(20);

    // Two archives come out of the recording: a trimmed m4a the operator can
    // download on its own, and a trimmed MP4 that replaces the original upload
    // as the video archive (MKV doesn't play in a browser).
    //
    // The next two steps each decode the whole recording and neither can
    // report progress from inside ffmpeg — silencedetect and loudnorm's
    // measuring pass both only emit a result at the end. On a two-hour show
    // that is minutes of apparent standstill, so mark the boundaries: the bar
    // moving between them is what says the job is alive rather than hung.
    const trim = await resolveTrim(inputPath, { manualStart: trimStart, manualEnd: trimEnd, autoTrimSilence });
    await report(25);

    // Effective post-trim length, in seconds, for display in the archive UI.
    const rawDuration = await probeDuration(inputPath);
    const durationSeconds = Math.max(
      0,
      Math.round((trim.trimEnd ? hms(trim.trimEnd) : rawDuration) - hms(trim.trimStart ?? '00:00:00'))
    );
    await records.setDuration(uploadId, durationSeconds);

    // Measured once and reused for both archives, so the downloadable audio and
    // the archived video sit at exactly the same level.
    const loudness = await measureLoudness(inputPath, {
      trimStart: trim.trimStart,
      trimEnd: trim.trimEnd,
    });
    await report(30);

    await extractAudio(inputPath, audioPath, {
      trimStart: trim.trimStart,
      trimEnd: trim.trimEnd,
      loudness,
      onProgress: async (pct) => report(30 + Math.round(pct * 0.25)),
    });

    const audioKey = showAudioKey(videoS3Key);
    await store.upload(audioPath, audioKey, 'audio/mp4');
    await records.setAudioKey(uploadId, audioKey);

    await report(60);

    const mp4Key = await remuxVideoToMp4(job, deps, { uploadId, jobId, videoS3Key, ext, inputPath, mp4Path, trim, loudness });

    // The permanent public link, not the raw S3 key: this lands verbatim as the
    // job's "view" link in the UI, and a key rendered as an href 404s.
    await records.setJobStatus(jobId, 'done', { result_url: publicShowUrl(config.appPublicUrl, audioKey) ?? audioKey, progress_pct: 100 });
    await job.updateProgress({ uploadId, platform: 'archive', pct: 100 });

    await publishArchiveLinks(deps, uploadId, audioKey);

    // The archive is the source for everything downstream: platform jobs are
    // created queued at submit and started HERE, on the finished artefacts —
    // one download, one trim, one loudness pass, and the platforms become thin
    // uploads of the same two files everyone gets. Also what makes "MixCloud
    // succeeded but the archive failed" impossible: the archive comes first.
    const rows = await records.getPlatformJobs(uploadId);
    for (const row of rows) {
      if (row.platform === 'archive' || row.platform === 'compress' || row.status !== 'queued') continue;
      const platform = row.platform as 'youtube' | 'mixcloud';
      await platformQueue.add(platform, {
        ...job.data,
        jobId: row.id,
        platform,
        videoS3Key: mp4Key,
        audioS3Key: audioKey,
        // Already applied while archiving — re-trimming would cut the show twice.
        trimStart: null,
        trimEnd: null,
        autoTrimSilence: false,
      });
    }

    return JSON.stringify({ uploadId, platform: 'archive', key: audioKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await records.setJobStatus(jobId, 'failed', { error: msg });
    throw err;
  } finally {
    ws.cleanup();
  }
}

/**
 * Put the finished recording on the agenda record, as two more mediaLinks
 * beside the YouTube and MixCloud ones the platform jobs already write.
 *
 * The URLs point at this app rather than at S3 directly: presigned links expire
 * within hours, and PocketBase stores these forever. /api/public redirects to a
 * freshly signed URL per request, so the stored link never rots.
 *
 * `type` matches `label` exactly (`cs-archive-video`/`cs-archive-audio`), not
 * `'download'` — radio-scheduler's addArchiveToPlaylists() gates Liquidsoap
 * playlist eligibility on `type === 'cs-archive-audio'` specifically, treating
 * `type` (not the free-text label) as the controlled vocabulary. See
 * cursor-pointer/radio-sheduler#9, which also retyped every existing record.
 *
 * Best-effort by design — the archive itself is already safely on S3, so a
 * PocketBase hiccup must not fail the job or trigger a retry that would redo the
 * whole transcode.
 */
// The permanent public link for an archived artefact, keyed by the show's own
// S3 folder (shows/<folder>/audio.m4a → …/api/public/shows/<folder>/audio).
// Null when APP_PUBLIC_URL is unset — callers keep their fallback.
function publicShowUrl(appPublicUrl: string | null, archiveKey: string): string | null {
  if (!appPublicUrl) return null;
  const [, folder, file] = archiveKey.split('/');
  if (!folder || !file) return null;
  const which = file.split('.')[0];
  return `${appPublicUrl.replace(/\/$/, '')}/api/public/shows/${folder}/${which}`;
}

async function publishArchiveLinks(
  { records, agenda, config }: Pick<WorkerDeps, 'records' | 'agenda' | 'config'>,
  uploadId: string,
  archiveKey: string
): Promise<void> {
  if (!config.appPublicUrl) {
    console.warn('APP_PUBLIC_URL unset — skipping archive links on the agenda record');
    return;
  }
  try {
    const row = await records.getUpload(uploadId);
    if (!row?.show_id) return;

    // Keyed by the show's own S3 folder, which this job just wrote and so
    // knows exactly. That makes the stored link self-describing: resolving it
    // needs no upload row and no guessing at which folder belongs to which
    // show — the two things that kept taking archived recordings offline.
    const folder = archiveKey.split('/')[1];
    const base = `${config.appPublicUrl.replace(/\/$/, '')}/api/public/shows/${folder}`;
    await agenda.finalize(row.show_id, {
      mediaLinks: [
        { label: 'cs-archive-video', type: 'cs-archive-video', url: `${base}/video` },
        { label: 'cs-archive-audio', type: 'cs-archive-audio', url: `${base}/audio` },
      ],
    });
  } catch (err) {
    console.error(`Could not attach archive links for ${uploadId}:`, err);
  }
}

/**
 * Rewrap the recording as MP4 and make it the video archive, replacing the
 * original upload on S3.
 *
 * Deletion order is deliberate: upload, prove the object landed, repoint the
 * DB, and only then drop the original. If anything throws before the repoint,
 * the source file is still on S3 and still referenced — retrying the archive
 * job picks up where it left off.
 */
async function remuxVideoToMp4(
  job: Job<JobPayload>,
  { store, records }: Pick<WorkerDeps, 'store' | 'records'>,
  ctx: {
    uploadId: string;
    jobId: string;
    videoS3Key: string;
    ext: string;
    inputPath: string;
    mp4Path: string;
    trim: { trimStart: string | null; trimEnd: string | null };
    loudness: LoudnessMeasurement | null;
  }
): Promise<string> {
  const { uploadId, jobId, videoS3Key, ext, inputPath, mp4Path, trim, loudness } = ctx;

  const isMp4 = ext.toLowerCase() === '.mp4';
  const hasTrim = !!(trim.trimStart || trim.trimEnd);

  // Already an MP4, nothing to cut and nothing to normalise — no work to do, and
  // re-running must stay a no-op. Normalising counts as work even when the
  // container is already right, so it cannot be skipped here.
  if (isMp4 && !hasTrim && !loudness) return videoS3Key;

  const onProgress = async (pct: number) => {
    const adjusted = 60 + Math.round(pct * 0.3);
    await records.setJobStatus(jobId, 'processing', { progress_pct: adjusted });
    await job.updateProgress({ uploadId, platform: 'archive', pct: adjusted });
  };

  if (isMp4) {
    // The preview remux already rewrapped this recording, so the container is
    // done and only the trim is outstanding. Stream copy — no re-encode, and the
    // result still replaces the source below exactly as a full remux would.
    await trimVideoCopy(inputPath, mp4Path, {
      trimStart: trim.trimStart,
      trimEnd: trim.trimEnd,
      // The archive is played in the browser, so it must stay progressive.
      faststart: true,
      loudness,
    });
    await onProgress(100);
  } else {
    await remuxToMp4(inputPath, mp4Path, {
      trimStart: trim.trimStart,
      trimEnd: trim.trimEnd,
      loudness,
      onProgress,
    });
  }

  // Source file is no longer needed — drop it before the upload so /tmp isn't
  // holding the recording twice while a multi-GB PUT runs.
  cleanup(inputPath);

  // Published artefacts move into the show's own folder; the source key may
  // still be under incoming/, which is exactly what this migration away from.
  const mp4Key = showVideoKey(`${videoS3Key.slice(0, -ext.length)}.mp4`);
  await store.upload(mp4Path, mp4Key, 'video/mp4');

  const size = await store.size(mp4Key);
  if (!size) throw new Error(`Remuxed MP4 missing or empty on S3: ${mp4Key}`);

  await records.setVideoKey(uploadId, mp4Key);

  await records.setJobStatus(jobId, 'processing', { progress_pct: 95 });
  await job.updateProgress({ uploadId, platform: 'archive', pct: 95 });

  // Past the point of no return for the original: the MP4 is verified on S3 and
  // the row points at it. A failure here leaves an orphan, never a dead link.
  //
  // Only when the key actually changed. A trimmed MP4 is written back over its
  // own key, so deleting "the original" here would delete the file just uploaded.
  if (mp4Key !== videoS3Key) {
    await store.delete(videoS3Key).catch((err) =>
      console.warn(`Remuxed to ${mp4Key} but could not delete ${videoS3Key}:`, err)
    );
  }
  return mp4Key;
}
