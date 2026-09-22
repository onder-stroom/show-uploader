import { db } from '../db/client';
import { takeStagedUpload, isVideoKeyClaimed } from '../db/queries';
import { deleteObject } from './s3';

/**
 * Abandon a show's staged pick: delete the row and the S3 object it pointed
 * at.
 *
 * Whatever key a staged row holds gets deleted here, so staged rows must only
 * ever hold keys the server built. The one writer is multipart completion
 * (routes/multipart.ts), with an `incoming/` key from incomingKey(); never add
 * an endpoint that stages a client-supplied key.
 *
 * Deliberately distinct from the internal cleanup that runs right after a
 * successful publish (`deleteStagedUpload`, called directly from `create`) — that path's staged key has just become
 * `show_uploads.video_s3_key` and must never be deleted here. This function is
 * only for the operator explicitly abandoning a pick via "replace".
 *
 * Best-effort: a failed S3 delete just leaves an orphan for the storage page
 * to surface later, which is strictly better than blocking the replace.
 */
export async function deleteStagedVideo(showId: string): Promise<void> {
  let key: string | null;
  try {
    key = await takeStagedUpload(db, showId);
  } catch {
    return; // no staged row for this show — nothing to clean up
  }
  if (!key) return;

  // A publish that overlapped this replace can have already written `key`
  // into a show_uploads row — see isVideoKeyClaimed. Narrows the race rather
  // than closing it (there's still a gap between this check and the DELETE
  // below), but a claimed key is exactly the case where deleting is wrong, so
  // it's worth catching what it can.
  if (await isVideoKeyClaimed(db, key)) {
    console.warn(`Staged key ${key} was claimed by a publish before replace could delete it — leaving it in place.`);
    return;
  }

  await deleteObject(key).catch((err) => console.error(`Failed to delete staged object ${key}:`, err));
}
