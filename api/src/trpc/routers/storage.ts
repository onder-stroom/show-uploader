import { router, protectedProcedure } from '../trpc';
import { bucketUsage, diskUsage, tempUsage } from '../../services/storage-usage';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { moveObject, createDownloadPresignedUrl, deleteObject } from '../../services/s3';
import { browse } from '../../services/storage-browse';
import { planMigration } from '@show-uploader/domain';
import { db } from '../../db/client';
import { listPublishedKeys, listUnpublishedKeys, repointStorageKey, isKeyReferenced } from '../../db/queries';
import { env } from '../../env';

// Where the object store keeps its data on the host, bind-mounted read-only into
// the api purely so this page can report real figures. Unset/unmounted degrades
// to "unavailable" rather than failing.
const STORAGE_DISK = process.env.STORAGE_DISK_PATH ?? '/mnt/storage';
// Log the cause, return something safe for the UI.
function internal(err: unknown, logPrefix: string, message: string): never {
  console.error(logPrefix, err);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
}

const TEMP_ROOT = process.env.WORKER_TEMP_ROOT ?? '/tmp/show-uploader';

/** Read the current layout of every tracked key and work out what should move. */
async function buildPlan() {
  const [published, unpublished] = await Promise.all([
    listPublishedKeys(db),
    listUnpublishedKeys(db),
  ]);
  return planMigration({
    published: published.map((r) => ({ videoKey: r.video_s3_key, audioKey: r.audio_s3_key })),
    ...unpublished,
  });
}

export const storageRouter = router({
  /** One level of the bucket, folders first. */
  browse: protectedProcedure
    .input(z.object({ prefix: z.string().default('') }))
    .query(async ({ input }) => {
      try {
        return await browse(input.prefix);
      } catch (err) {
        internal(err, 'Failed to browse storage:', 'Failed to browse storage');
      }
    }),

  /**
   * A download URL for one object.
   *
   * A query, not a mutation: signing has no side effect, and keying it by the
   * object means the same key yields the same cached URL. That is what keeps a
   * <video src> stable — the alternative is re-signing on every render and
   * tearing the media element down mid-playback.
   *
   * Signed on demand rather than during listing: signing a whole folder is
   * wasted work for the objects nobody opens.
   */
  signObject: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return { url: await createDownloadPresignedUrl(input.key) };
      } catch (err) {
        internal(err, 'Failed to sign object:', 'Failed to sign object');
      }
    }),

  /**
   * Delete one object from the browser.
   *
   * Unlike the scoped "replace" delete, this browser reaches anywhere in the
   * bucket, so there is no narrow caller context to lean on for safety. Refuses
   * anything isKeyReferenced still finds a row for — this can only ever remove
   * a true orphan, never a file the app itself still points at.
   */
  deleteObject: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      if (await isKeyReferenced(db, input.key)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This object is still referenced and cannot be deleted here.',
        });
      }
      try {
        await deleteObject(input.key);
        return { ok: true };
      } catch (err) {
        internal(err, 'Failed to delete object:', 'Failed to delete object');
      }
    }),

  /**
   * What the layout migration would do, without doing any of it.
   *
   * This rewrites live object keys, so the operator gets to see the exact list
   * first — that is the difference between a reversible decision and an
   * irreversible one.
   */
  migrationPlan: protectedProcedure.query(async () => {
    const moves = await buildPlan();
    return { moves, count: moves.length };
  }),

  /**
   * Perform the moves.
   *
   * Object first, then the DB: a copy is verified before the original is
   * deleted, and the row is repointed immediately after. An interruption
   * therefore leaves either a duplicate object or a moved object with a stale
   * row — both recoverable by re-running, neither a dead link.
   *
   * Failures are collected rather than thrown, so one bad object cannot strand
   * the rest of the migration half-done.
   */
  runMigration: protectedProcedure.mutation(async () => {
    const moves = await buildPlan();
    const failed: { from: string; error: string }[] = [];
    let moved = 0;

    for (const move of moves) {
      try {
        await moveObject(move.from, move.to);
        await repointStorageKey(db, move.from, move.to);
        moved++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`Storage migration failed for ${move.from}:`, error);
        failed.push({ from: move.from, error });
      }
    }

    return { moved, failed, attempted: moves.length };
  }),
  /**
   * Everything the storage page shows, in one call.
   *
   * The bucket scan is the slow part (it lists every object), so this is
   * deliberately a single procedure the page polls slowly rather than several
   * the page would fan out on.
   */
  overview: protectedProcedure.query(async () => {
    const { prefixes, truncated } = await bucketUsage();
    return {
      disk: diskUsage(STORAGE_DISK),
      // The container's own filesystem — separate disk from the object store,
      // and the one that fills up if scratch is not cleaned.
      root: diskUsage('/'),
      temp: tempUsage(TEMP_ROOT),
      bucket: {
        name: env.S3_BUCKET ?? null,
        prefixes,
        truncated,
        bytes: prefixes.reduce((sum, p) => sum + p.bytes, 0),
        objects: prefixes.reduce((sum, p) => sum + p.objects, 0),
      },
    };
  }),
});
