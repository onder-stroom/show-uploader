import { getArchivedUploadsMissingDuration, setVideoDuration } from '../db';
import { probeDuration } from './ffmpeg';
import { signedGetUrl } from './s3';

/**
 * Record the duration of shows archived before the archive job measured it.
 *
 * ffprobe reads the file over a signed URL, so this costs a few range requests
 * per show rather than a download. Serial on purpose — it runs beside the job
 * workers on boot. A file that can't be probed stays null and is retried on the
 * next boot; nothing here is worth failing startup over.
 */
export async function backfillDurations(): Promise<number> {
  const rows = await getArchivedUploadsMissingDuration();
  let filled = 0;
  for (const row of rows) {
    const seconds = Math.round(await probeDuration(await signedGetUrl(row.video_s3_key)));
    if (seconds > 0) {
      await setVideoDuration(row.id, seconds);
      filled++;
    }
  }
  return filled;
}
