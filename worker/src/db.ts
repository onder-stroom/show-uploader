import postgres from 'postgres';
import { env } from './env';

// TLS comes from the connection string (`?sslmode=`), see api/src/db/client.ts.
export const db = postgres(env.DATABASE_URI, { max: 5 });

export async function setJobStatus(
  jobId: string,
  status: string,
  extra: { result_url?: string; error?: string; progress_pct?: number } = {}
) {
  // Postgres has no integer representation of NaN/Infinity — it rejects the
  // query outright, and every caller here is a fire-and-forget progress tick,
  // so a thrown error becomes an unhandled rejection that has, in practice,
  // crashed the whole worker process. A bad progress value should be dropped
  // (leaves progress_pct unchanged, same as omitting it), never fatal.
  const progressPct =
    extra.progress_pct != null && Number.isFinite(extra.progress_pct) ? extra.progress_pct : null;
  await db`
    UPDATE platform_jobs
    SET
      status = ${status},
      result_url = COALESCE(${extra.result_url ?? null}, result_url),
      error = COALESCE(${extra.error ?? null}, error),
      progress_pct = COALESCE(${progressPct}, progress_pct),
      updated_at = NOW()
    WHERE id = ${jobId}
      -- 'done' is terminal. A duplicate queue entry (double-clicked retry)
      -- running after the real one finished has, in production, overwritten
      -- 'done' with 'failed' over a source file the winner had already moved —
      -- a red row and a retry button on a job that succeeded. Late progress
      -- callbacks must not un-finish it either. Retry goes through
      -- resetPlatformJobForRetry, which is a direct UPDATE and unaffected.
      AND (status <> 'done' OR ${status} = 'done')
  `;
}

// On worker boot no job is running yet, so any row still in 'processing' belongs
// to a worker that died mid-run (redeploy/crash) — a permanent "processing"
// ghost in the UI. Mark them failed (retryable) before the Worker starts picking
// up new jobs, so nothing gets clobbered mid-flight.
export async function reconcileStalledJobs() {
  const rows = await db<{ id: string; platform: string; upload_id: string }[]>`
    UPDATE platform_jobs
    SET status = 'failed',
        error = 'Interrupted — worker restarted. Press retry to resume.',
        updated_at = NOW()
    WHERE status = 'processing'
    RETURNING id, platform, upload_id
  `;
  return rows;
}

export async function getPlatformJobsForUpload(uploadId: string) {
  return db<{ id: string; platform: string; status: string; result_url: string | null }[]>`
    SELECT id, platform, status, result_url FROM platform_jobs WHERE upload_id = ${uploadId}
  `;
}

export async function getUploadRow(uploadId: string) {
  const rows = await db<{ show_id: string; jingle_s3_key: string | null }[]>`
    SELECT show_id, jingle_s3_key FROM show_uploads WHERE id = ${uploadId}
  `;
  return rows[0] ?? null;
}

export async function setArchiveKey(uploadId: string, key: string) {
  await db`UPDATE show_uploads SET archive_s3_key = ${key} WHERE id = ${uploadId}`;
}

export async function setAudioKey(uploadId: string, key: string) {
  await db`UPDATE show_uploads SET audio_s3_key = ${key} WHERE id = ${uploadId}`;
}

export async function setVideoDuration(uploadId: string, seconds: number) {
  await db`UPDATE show_uploads SET duration_seconds = ${seconds} WHERE id = ${uploadId}`;
}

// Archived uploads from before the duration column existed. Only a finished
// archive counts: its video_s3_key is the trimmed file, so probing it gives the
// duration the archive job would have recorded.
export async function getArchivedUploadsMissingDuration() {
  return db<{ id: string; video_s3_key: string }[]>`
    SELECT u.id, u.video_s3_key FROM show_uploads u
    WHERE u.duration_seconds IS NULL
      AND EXISTS (
        SELECT 1 FROM platform_jobs j
        WHERE j.upload_id = u.id AND j.platform = 'archive' AND j.status = 'done'
      )
  `;
}

// Repoint the video archive at the remuxed MP4. Clearing the trim is required,
// not cosmetic: the retry endpoints rebuild job payloads from this row, and the
// new file is *already* trimmed — leaving the bounds in place would cut a
// retried job a second time.
export async function setVideoKey(uploadId: string, key: string) {
  await db`
    UPDATE show_uploads
    SET video_s3_key = ${key}, trim_start = NULL, trim_end = NULL
    WHERE id = ${uploadId}
  `;
}

/**
 * Point the pre-publish records at the remuxed MP4.
 *
 * Runs before any show_uploads row exists, so it touches only the two places a
 * not-yet-published video can live: a drop-folder file (pending_videos) and a
 * manually uploaded one (staged_uploads). A key appears in at most one of them,
 * but both are updated rather than branching — the miss is a no-op UPDATE.
 *
 * Returns how many records were repointed. The caller MUST treat zero as a
 * failure and leave the source in place: a job that was queued before its record
 * was replaced or removed would otherwise delete a recording that nothing points
 * at any more.
 */
export async function repointPreviewKey(
  oldKey: string,
  newKey: string,
  newFilename: string,
  sizeBytes: number
): Promise<number> {
  const pending = await db`
    UPDATE pending_videos
    SET s3_key = ${newKey}, filename = ${newFilename}, size_bytes = ${sizeBytes}
    WHERE s3_key = ${oldKey}
  `;
  const staged = await db`
    UPDATE staged_uploads
    SET s3_key = ${newKey}, filename = ${newFilename}, size_bytes = ${sizeBytes}
    WHERE s3_key = ${oldKey}
  `;
  return pending.count + staged.count;
}

export async function createArchiveJobRecord(uploadId: string): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO platform_jobs (upload_id, platform)
    VALUES (${uploadId}, 'archive')
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}
