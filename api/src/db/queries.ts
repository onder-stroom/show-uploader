import type { Sql } from 'postgres';

export type ShowUpload = {
  id: string;
  show_id: string;
  title: string;
  description: string | null;
  tags: string[];
  image_url: string | null;
  video_s3_key: string;
  archive_s3_key: string | null;
  audio_s3_key: string | null;
  jingle_s3_key: string | null;
  trim_start: string | null;
  trim_end: string | null;
  duration_seconds: number | null;
  created_at: Date;
};

export type PlatformJob = {
  id: string;
  upload_id: string;
  platform: 'youtube' | 'mixcloud' | 'archive' | 'compress';
  status: 'queued' | 'processing' | 'done' | 'failed';
  result_url: string | null;
  error: string | null;
  progress_pct: number;
  created_at: Date;
  updated_at: Date;
};

export function createUpload(
  db: Sql,
  data: Pick<
    ShowUpload,
    'show_id' | 'title' | 'description' | 'tags' | 'image_url' | 'video_s3_key' | 'jingle_s3_key' | 'trim_start' | 'trim_end'
  > & {
    // Optional: adoptArchive sets this when the m4a already sits on S3
    // alongside the video, so "generate audio" isn't a needless re-extract of
    // a file that's already there. Every other caller leaves it unset (null).
    audio_s3_key?: string | null;
  }
) {
  return db<ShowUpload[]>`
    INSERT INTO show_uploads (show_id, title, description, tags, image_url, video_s3_key, audio_s3_key, jingle_s3_key, trim_start, trim_end)
    VALUES (
      ${data.show_id}, ${data.title}, ${data.description ?? null},
      ${db.array(data.tags)}, ${data.image_url ?? null},
      ${data.video_s3_key}, ${data.audio_s3_key ?? null}, ${data.jingle_s3_key ?? null},
      ${data.trim_start ?? null}, ${data.trim_end ?? null}
    )
    RETURNING *
  `.then((rows) => rows[0]);
}

export function createPlatformJob(
  db: Sql,
  data: Pick<PlatformJob, 'upload_id' | 'platform'>
) {
  return db<PlatformJob[]>`
    INSERT INTO platform_jobs (upload_id, platform)
    VALUES (${data.upload_id}, ${data.platform})
    RETURNING *
  `.then((rows) => rows[0]);
}

export function getUploadWithJobs(db: Sql, uploadId: string) {
  return db<(ShowUpload & { jobs: PlatformJob[] })[]>`
    SELECT
      u.*,
      COALESCE(
        json_agg(j ORDER BY j.created_at) FILTER (WHERE j.id IS NOT NULL),
        '[]'
      ) AS jobs
    FROM show_uploads u
    LEFT JOIN platform_jobs j ON j.upload_id = u.id
    WHERE u.id = ${uploadId}
    GROUP BY u.id
  `.then((rows) => rows[0] ?? null);
}

export function listUploadsWithJobs(db: Sql) {
  return db<(ShowUpload & { jobs: PlatformJob[] })[]>`
    SELECT
      u.*,
      COALESCE(
        json_agg(j ORDER BY j.created_at) FILTER (WHERE j.id IS NOT NULL),
        '[]'
      ) AS jobs
    FROM show_uploads u
    LEFT JOIN platform_jobs j ON j.upload_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT 50
  `;
}

// Drop an upload and, via ON DELETE CASCADE on platform_jobs, its job rows.
// Deliberately leaves the S3 objects and the PocketBase record alone: this
// clears the queue entry, it does not destroy the recording.
export function deleteUpload(db: Sql, uploadId: string) {
  return db`
    DELETE FROM show_uploads WHERE id = ${uploadId} RETURNING id
  `.then((rows) => rows.length > 0);
}

// Uploads whose video archive is still in its original container. The archive
// job remuxes those to MP4 in place, so this is the backfill worklist for
// recordings that predate that step.
export function listUploadsNeedingRemux(db: Sql) {
  return db<(ShowUpload & { jobs: PlatformJob[] })[]>`
    SELECT
      u.*,
      COALESCE(
        json_agg(j ORDER BY j.created_at) FILTER (WHERE j.id IS NOT NULL),
        '[]'
      ) AS jobs
    FROM show_uploads u
    LEFT JOIN platform_jobs j ON j.upload_id = u.id
    WHERE u.video_s3_key NOT ILIKE '%.mp4'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `;
}

export function updateJobStatus(
  db: Sql,
  jobId: string,
  update: Partial<Pick<PlatformJob, 'status' | 'result_url' | 'error' | 'progress_pct'>>
) {
  return db`
    UPDATE platform_jobs
    SET
      status = COALESCE(${update.status ?? null}, status),
      result_url = COALESCE(${update.result_url ?? null}, result_url),
      error = COALESCE(${update.error ?? null}, error),
      progress_pct = COALESCE(${update.progress_pct ?? null}, progress_pct),
      updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export function updateArchiveKey(db: Sql, uploadId: string, archiveS3Key: string) {
  return db`
    UPDATE show_uploads SET archive_s3_key = ${archiveS3Key} WHERE id = ${uploadId}
  `;
}

export function getPlatformJobsForUpload(db: Sql, uploadId: string) {
  return db<PlatformJob[]>`
    SELECT * FROM platform_jobs WHERE upload_id = ${uploadId}
  `;
}

// All show_ids that currently have a staged (uploaded-but-unpublished) video —
// so the "to process" table can flag which shows already have a recording.
export function listStagedShowIds(db: Sql) {
  return db<{ show_id: string }[]>`SELECT show_id FROM staged_uploads`.then((r) => r.map((x) => x.show_id));
}

// In-progress multipart sessions (recent only, so a browser that quit mid-upload
// doesn't leave a phantom forever) — used to show "uploading elsewhere" with a
// real % on OTHER machines. The % is computed server-side from S3 ListParts, so
// no client reporting is needed. Newest per show, in case of a restarted session.
export function listUploadingSessions(db: Sql) {
  return db<{ show_id: string; s3_key: string; s3_upload_id: string; size_bytes: string }[]>`
    SELECT DISTINCT ON (show_id) show_id, s3_key, s3_upload_id, size_bytes
    FROM multipart_uploads
    WHERE status = 'in_progress' AND show_id IS NOT NULL AND created_at > now() - interval '6 hours'
    ORDER BY show_id, created_at DESC
  `;
}

// Most recent upload for a show, with its jobs — for actions that operate on a
// show (the durable thing) and only reach for the row as bookkeeping.
export function getLatestUploadWithJobsForShow(db: Sql, showId: string) {
  return db<(ShowUpload & { jobs: PlatformJob[] })[]>`
    SELECT
      u.*,
      COALESCE(
        json_agg(j ORDER BY j.created_at) FILTER (WHERE j.id IS NOT NULL),
        '[]'
      ) AS jobs
    FROM show_uploads u
    LEFT JOIN platform_jobs j ON j.upload_id = u.id
    WHERE u.show_id = ${showId}
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT 1
  `.then((rows) => rows[0] ?? null);
}

// Most recent upload for a show — used to restore its (published) video into the
// form after the staged row has been cleared.
export function getLatestUploadForShow(db: Sql, showId: string) {
  return db<{ video_s3_key: string }[]>`
    SELECT video_s3_key FROM show_uploads WHERE show_id = ${showId} ORDER BY created_at DESC LIMIT 1
  `.then((rows) => rows[0] ?? null);
}

// Operator-edited archive metadata, kept in sync with the published platforms.
export function updateUploadMetadata(
  db: Sql,
  uploadId: string,
  data: { title: string; description: string; tags: string[] }
) {
  return db`
    UPDATE show_uploads
    SET title = ${data.title}, description = ${data.description}, tags = ${db.array(data.tags)}
    WHERE id = ${uploadId}
  `;
}

// Clear a failed job back to a clean queued state so it can be re-enqueued.
// Unlike updateJobStatus this explicitly nulls error/result_url (COALESCE can't).
export function resetPlatformJobForRetry(db: Sql, jobId: string) {
  return db`
    UPDATE platform_jobs
    SET status = 'queued', progress_pct = 0, error = NULL, result_url = NULL, updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export type ShowClaim = {
  show_id: string;
  user_sub: string;
  user_name: string;
  claimed_at: Date;
  last_seen_at: Date;
};

// Claim (or steal) a show for a user. A conflicting claim by anyone is
// overwritten — claims are soft/advisory, so "open anyway" just re-claims.
export function upsertClaim(db: Sql, showId: string, userSub: string, userName: string) {
  return db<ShowClaim[]>`
    INSERT INTO show_claims (show_id, user_sub, user_name, claimed_at, last_seen_at)
    VALUES (${showId}, ${userSub}, ${userName}, NOW(), NOW())
    ON CONFLICT (show_id) DO UPDATE SET
      user_sub = EXCLUDED.user_sub,
      user_name = EXCLUDED.user_name,
      claimed_at = CASE
        WHEN show_claims.user_sub = EXCLUDED.user_sub THEN show_claims.claimed_at
        ELSE NOW()
      END,
      last_seen_at = NOW()
    RETURNING *
  `.then((rows) => rows[0]);
}

// Refresh last_seen only while the claim is still held by this user (a steal
// by someone else must not be kept alive by the previous owner's heartbeat).
export function heartbeatClaim(db: Sql, showId: string, userSub: string) {
  return db`
    UPDATE show_claims SET last_seen_at = NOW()
    WHERE show_id = ${showId} AND user_sub = ${userSub}
  `;
}

// Release only if still owned by this user.
export function releaseClaim(db: Sql, showId: string, userSub: string) {
  return db`
    DELETE FROM show_claims WHERE show_id = ${showId} AND user_sub = ${userSub}
  `;
}

// Publish-time release: drop the claim regardless of owner.
export function releaseClaimForShow(db: Sql, showId: string) {
  return db`DELETE FROM show_claims WHERE show_id = ${showId}`;
}

// Sweep claims with no heartbeat for `olderThanMs`; returns the freed show_ids.
export function releaseStaleClaims(db: Sql, olderThanMs: number) {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db<{ show_id: string }[]>`
    DELETE FROM show_claims WHERE last_seen_at < ${cutoff} RETURNING show_id
  `;
}

export function listClaims(db: Sql) {
  return db<ShowClaim[]>`SELECT * FROM show_claims`;
}

export type StagedUpload = {
  show_id: string;
  s3_key: string;
  filename: string;
  size_bytes: number;
  created_at: Date;
};

// One staged (uploaded-but-unpublished) video per show; a new upload replaces it.
export function upsertStagedUpload(
  db: Sql,
  showId: string,
  s3Key: string,
  filename: string,
  sizeBytes: number
) {
  return db`
    INSERT INTO staged_uploads (show_id, s3_key, filename, size_bytes, created_at)
    VALUES (${showId}, ${s3Key}, ${filename}, ${sizeBytes}, NOW())
    ON CONFLICT (show_id) DO UPDATE SET
      s3_key = EXCLUDED.s3_key,
      filename = EXCLUDED.filename,
      size_bytes = EXCLUDED.size_bytes,
      created_at = NOW()
  `;
}

export function getStagedUpload(db: Sql, showId: string) {
  return db<StagedUpload[]>`SELECT * FROM staged_uploads WHERE show_id = ${showId}`.then((r) => r[0] ?? null);
}

export function deleteStagedUpload(db: Sql, showId: string) {
  return db`DELETE FROM staged_uploads WHERE show_id = ${showId}`;
}

/**
 * Delete a show's staged row and hand back the S3 key it pointed at, so the
 * caller can also delete the object.
 *
 * Deliberately separate from deleteStagedUpload, which stays a bare delete —
 * that one is also called right after a successful publish, where the staged
 * key has just become show_uploads.video_s3_key and must NOT be deleted. This
 * function is for the other caller: the operator abandoning a staged pick
 * (replace), where the key really is going nowhere else.
 */
export function takeStagedUpload(db: Sql, showId: string) {
  return db<{ s3_key: string }[]>`
    DELETE FROM staged_uploads WHERE show_id = ${showId} RETURNING s3_key
  `.then((r) => r[0]?.s3_key ?? null);
}

/**
 * Is this key a recording the app is actually holding for publication?
 *
 * The preview endpoints must never treat a caller-supplied S3 key as authority:
 * one signs a download URL for it, the other enqueues a remux that DELETES it.
 * Unchecked, any key in the bucket — a jingle, another show's archive — could be
 * fed to either. Only the two places a not-yet-published recording lives count.
 */
/**
 * Has any show_uploads row come to reference this key since it was staged?
 *
 * Guards the race between "replace" and "publish" on the same show: publish
 * captures video_s3_key from client state at submit time, so a replace that
 * overlaps a publish still in flight could otherwise delete the very key the
 * new show_uploads row now points at. Narrows the window rather than closing
 * it outright — a full fix needs a transaction spanning both operations,
 * which is more than this check-before-delete guard attempts.
 */
export function isVideoKeyClaimed(db: Sql, s3Key: string): Promise<boolean> {
  return db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM show_uploads WHERE video_s3_key = ${s3Key}) AS ok
  `.then((r) => r[0]?.ok === true);
}

/**
 * Does anything in the app still reference this key?
 *
 * The browser can delete from anywhere in the bucket, not just a scoped
 * "replace this show's pick" action — so unlike takeStagedUpload/deleteStaged,
 * there is no narrow caller context to lean on here. This spans every column
 * and table that can hold an S3 key, so the delete route can refuse anything
 * still in use rather than trusting the operator to have picked correctly.
 */
export function isKeyReferenced(db: Sql, key: string): Promise<boolean> {
  return db<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM show_uploads
        WHERE video_s3_key = ${key} OR audio_s3_key = ${key} OR archive_s3_key = ${key} OR jingle_s3_key = ${key}
      UNION ALL
      SELECT 1 FROM staged_uploads WHERE s3_key = ${key}
      UNION ALL
      SELECT 1 FROM pending_videos WHERE s3_key = ${key}
    ) AS ok
  `.then((r) => r[0]?.ok === true);
}

export function isPrePublishVideoKey(db: Sql, s3Keys: string[]): Promise<boolean> {
  return db<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM staged_uploads WHERE s3_key = ANY(${s3Keys})
      UNION ALL
      SELECT 1 FROM pending_videos WHERE s3_key = ANY(${s3Keys}) AND claimed = false
    ) AS ok
  `.then((r) => r[0]?.ok === true);
}

// ---- storage layout migration ----------------------------------------------

/**
 * Every upload whose archive job has finished — the population the
 * PocketBase-links backfill runs over. Same WHERE clause as listPublishedKeys
 * below, different columns: this needs id/show_id to write mediaLinks, that
 * needs the S3 keys to move them.
 */
export function listArchivedUploads(db: Sql) {
  return db<{ id: string; show_id: string }[]>`
    SELECT DISTINCT u.id, u.show_id
    FROM show_uploads u
    JOIN platform_jobs j ON j.upload_id = u.id
    WHERE j.platform = 'archive' AND j.status = 'done'
  `;
}

/** Published uploads (archive job finished) with their two artefact keys. */
export function listPublishedKeys(db: Sql) {
  return db<{ video_s3_key: string; audio_s3_key: string | null }[]>`
    SELECT DISTINCT u.video_s3_key, u.audio_s3_key
    FROM show_uploads u
    JOIN platform_jobs j ON j.upload_id = u.id
    WHERE j.platform = 'archive' AND j.status = 'done'
  `;
}

/** Keys still awaiting publication. */
export function listUnpublishedKeys(db: Sql) {
  return Promise.all([
    db<{ s3_key: string }[]>`SELECT s3_key FROM pending_videos WHERE claimed = false`,
    db<{ s3_key: string }[]>`SELECT s3_key FROM staged_uploads`,
  ]).then(([pending, staged]) => ({
    pendingKeys: pending.map((r) => r.s3_key),
    stagedKeys: staged.map((r) => r.s3_key),
  }));
}

/**
 * Repoint every reference to a moved object.
 *
 * Runs across all key columns rather than only the one the plan named: a key can
 * be referenced from more than one place (a pending row whose recording was also
 * staged), and a missed reference is a dead link.
 */
export async function repointStorageKey(db: Sql, from: string, to: string): Promise<void> {
  await db`UPDATE show_uploads SET video_s3_key = ${to} WHERE video_s3_key = ${from}`;
  await db`UPDATE show_uploads SET audio_s3_key = ${to} WHERE audio_s3_key = ${from}`;
  await db`UPDATE show_uploads SET archive_s3_key = ${to} WHERE archive_s3_key = ${from}`;
  await db`UPDATE pending_videos SET s3_key = ${to} WHERE s3_key = ${from}`;
  await db`UPDATE staged_uploads SET s3_key = ${to} WHERE s3_key = ${from}`;
}

// Last successful metadata sync per platform for one show. Upserted on every
// sync that the platform accepted; failures leave the previous stamp alone, so
// the timestamp always answers "when did the platform last match the agenda".
export function recordPlatformSync(db: Sql, showId: string, platform: string) {
  return db`
    INSERT INTO platform_syncs (show_id, platform, synced_at)
    VALUES (${showId}, ${platform}, NOW())
    ON CONFLICT (show_id, platform) DO UPDATE SET synced_at = NOW()
  `;
}

export function getPlatformSyncs(db: Sql, showId: string) {
  return db<{ platform: string; synced_at: string }[]>`
    SELECT platform, synced_at FROM platform_syncs WHERE show_id = ${showId}
  `;
}

export type MultipartSession = {
  id: string;
  show_id: string | null;
  s3_key: string;
  s3_upload_id: string;
  filename: string;
  size_bytes: string;
  content_type: string;
  part_size: number;
  status: string;
  cut_id: string | null;
};

export async function createMultipartSession(
  db: Sql,
  d: {
    showId: string | null; key: string; s3UploadId: string; filename: string; size: number;
    contentType: string; partSize: number;
    cut: { cutId: string; ref: string; startS: number; endS: number } | null;
  }
): Promise<string> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO multipart_uploads
      (show_id, s3_key, s3_upload_id, filename, size_bytes, content_type, part_size,
       source_ref, cut_id, cut_start_s, cut_end_s)
    VALUES
      (${d.showId}, ${d.key}, ${d.s3UploadId}, ${d.filename}, ${d.size}, ${d.contentType}, ${d.partSize},
       ${d.cut?.ref ?? null}, ${d.cut?.cutId ?? null}, ${d.cut?.startS ?? null}, ${d.cut?.endS ?? null})
    RETURNING id
  `;
  return rows[0].id;
}

export async function getMultipartSession(db: Sql, id: string): Promise<MultipartSession | null> {
  const rows = await db<MultipartSession[]>`SELECT * FROM multipart_uploads WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function findMultipartSessionByCutId(db: Sql, cutId: string): Promise<MultipartSession | null> {
  const rows = await db<MultipartSession[]>`
    SELECT * FROM multipart_uploads
    WHERE cut_id = ${cutId} AND status <> 'aborted'
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function setMultipartStatus(db: Sql, id: string, status: 'completed' | 'aborted'): Promise<void> {
  if (status === 'completed') {
    await db`UPDATE multipart_uploads SET status = 'completed', completed_at = now() WHERE id = ${id}`;
  } else {
    await db`UPDATE multipart_uploads SET status = 'aborted' WHERE id = ${id}`;
  }
}
