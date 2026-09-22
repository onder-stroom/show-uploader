import type { ApiDeps, UploadStore } from '../ports';
import { derivePreviewState, isPlayable, previewJobId, previewKeyFor } from '../services/video-preview';
import { UseCaseError } from './errors';

/**
 * Reject any key that isn't a recording this app is holding for publication.
 *
 * One preview endpoint signs a download URL for the key and the other enqueues a
 * remux that DELETES it, so a caller-supplied key can never be the authority —
 * otherwise a jingle or another show's archive could be fed to either.
 *
 * Both sides of the rename are accepted: a successful remux repoints the record
 * to the `.mp4`, at which point the caller's original key is legitimately absent
 * but still the one it is polling with.
 */
async function assertPrePublishVideo(uploads: UploadStore, videoS3Key: string): Promise<void> {
  const ok = await uploads.isPrePublishVideo([videoS3Key, previewKeyFor(videoS3Key)]);
  if (!ok) throw new UseCaseError('NOT_FOUND', 'Not a recording awaiting publication');
}

// Start the preview remux for a not-yet-published recording. Idempotent: the job
// id is derived from the key, so pressing preview in two tabs enqueues one
// remux. Already-MP4 keys need no work and never reach the queue.
export async function startPreview(videoS3Key: string, { uploads, queue }: Pick<ApiDeps, 'uploads' | 'queue'>) {
  // The key decides what gets rewrapped AND deleted, so it is never taken on the
  // caller's word — only a recording the app is holding qualifies.
  await assertPrePublishVideo(uploads, videoS3Key);
  if (isPlayable(videoS3Key)) return { state: 'ready' as const, key: videoS3Key };

  await queue.queuePreview(videoS3Key, previewJobId(videoS3Key));
  return { state: 'working' as const, pct: 0 };
}

// Polled by the prepare screen while a remux runs. Readiness is read from the
// key itself, not from queue bookkeeping — see derivePreviewState.
export async function previewStatus(videoS3Key: string, { uploads, queue }: Pick<ApiDeps, 'uploads' | 'queue'>) {
  // Same rule as startPreview: the result leads to a signed download, so an
  // arbitrary key would be an arbitrary read of the bucket.
  await assertPrePublishVideo(uploads, videoS3Key);
  const job = await queue.previewJob(previewJobId(videoS3Key));
  // Returns the key, never a signed URL. Signing here would hand back a
  // different URL on every poll and tear down a playing <video>; the player
  // signs the key once via storage.signObject instead.
  return derivePreviewState({ videoS3Key, job });
}

// In-progress multipart uploads with a real % per show, so OTHER machines show
// "uploading elsewhere · N%" while a browser is mid-upload. The % is computed
// server-side from S3 ListParts (uploaded bytes / total) — no client reporting,
// so it's the same number on every machine. A failed ListParts drops that
// session's % to null (still shown as "uploading", just without the number).
export async function uploadingProgress({ uploads, objects }: Pick<ApiDeps, 'uploads' | 'objects'>) {
  const sessions = await uploads.uploadingSessions();
  return Promise.all(
    sessions.map(async (s) => {
      const total = Number(s.size_bytes) || 0;
      let pct: number | null = null;
      try {
        const parts = await objects.uploadedParts(s.s3_key, s.s3_upload_id);
        const uploaded = parts.reduce((sum, p) => sum + (p.Size ?? 0), 0);
        if (total > 0) pct = Math.min(99, Math.round((uploaded / total) * 100));
      } catch {
        pct = null; // session may have just completed/aborted — ignore
      }
      return { show_id: s.show_id, pct };
    })
  );
}

// Is the source recording actually still on S3 for this upload? The row's
// video_s3_key is not proof — so this HEADs the object rather than trusting it,
// which is the whole point: it's what tells an operator whether there's a file
// to replace.
export async function videoInfo(uploadId: string, { uploads, objects }: Pick<ApiDeps, 'uploads' | 'objects'>) {
  const upload = await uploads.get(uploadId);
  if (!upload) throw new UseCaseError('NOT_FOUND', 'Upload not found');
  const { exists, size } = await objects.info(upload.video_s3_key);
  return {
    exists,
    size,
    // Strip the upload timestamp prefix the watcher adds, e.g. "1785677613218-".
    filename: (upload.video_s3_key.split('/').pop() ?? '').replace(/^\d+-/, ''),
    showId: upload.show_id,
  };
}
