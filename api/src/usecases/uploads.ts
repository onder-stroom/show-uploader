// api/src/usecases/uploads.ts
import { incomingKey } from '@show-uploader/domain';
import type { ApiDeps } from '../ports';
import { UseCaseError } from './errors';

// 16 MiB parts: well above S3's 5 MiB minimum, few enough requests for large
// files, small enough that a failed part is cheap to retry.
export const PART_SIZE = 16 * 1024 * 1024;

type SessionDeps = Pick<ApiDeps, 'objects' | 'sessions'>;

export type OpenSessionInput = {
  filename: string;
  contentType: string;
  size: number;
  /** The show this upload belongs to — bound from the start, so completion can stage it. */
  showId: string | null;
  /** Set when the file is a segment cut from an OBS recording. */
  cut?: { cutId: string; ref: string; startS: number; endS: number };
};

// Start a session: create the S3 multipart upload and persist it.
export async function openUploadSession(input: OpenSessionInput, { objects, sessions }: SessionDeps) {
  const key = incomingKey(input.filename);
  const s3UploadId = await objects.createMultipart(key, input.contentType);
  try {
    const sessionId = await sessions.create({
      showId: input.showId,
      key,
      s3UploadId,
      filename: input.filename,
      size: input.size,
      contentType: input.contentType,
      partSize: PART_SIZE,
      cut: input.cut ?? null,
    });
    return { sessionId, key, partSize: PART_SIZE, partCount: Math.max(1, Math.ceil(input.size / PART_SIZE)) };
  } catch (err) {
    // Without its row nothing can ever complete or abort this upload, so it would
    // sit in the bucket accruing parts. Give it up now.
    await objects.abortMultipart(key, s3UploadId).catch(() => {});
    throw err;
  }
}

// Finish: complete the S3 object and — the key robustness point — record the staged
// video against the show ATOMICALLY here. The show record therefore always knows it
// has a video the instant the upload finishes, independent of the client
// (navigation, refresh, a crash) or the worker that drove it.
export async function completeUpload(sessionId: string, { objects, sessions }: SessionDeps): Promise<{ key: string }> {
  const s = await sessions.get(sessionId);
  if (!s) throw new UseCaseError('NOT_FOUND', 'Unknown session');
  if (s.status === 'completed') return { key: s.s3_key };

  await objects.completeMultipart(s.s3_key, s.s3_upload_id);
  await sessions.setStatus(s.id, 'completed');
  if (s.show_id) await sessions.stage(s.show_id, s.s3_key, s.filename, Number(s.size_bytes));
  return { key: s.s3_key };
}

// Cancel: abort the S3 upload and mark the session. Only a session still in progress
// can be cancelled: a completed one has a finished object and a staged video, and a
// late abort (a caller that lost the completion response) must not rewrite that history.
export async function abortUpload(sessionId: string, { objects, sessions }: SessionDeps): Promise<void> {
  const s = await sessions.get(sessionId);
  if (!s) throw new UseCaseError('NOT_FOUND', 'Unknown session');
  if (s.status !== 'in_progress') return;
  await objects.abortMultipart(s.s3_key, s.s3_upload_id);
  await sessions.setStatus(s.id, 'aborted');
}
