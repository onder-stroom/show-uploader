import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../../db/client';
import { env } from '../../env';
import { updateArchiveRecord, resolveGenreIds } from '../../services/shows-api';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import type { Context } from '../trpc';

// pending_videos row shape (SELECT *). The watcher drops a
// row here when a file lands on S3; the UI polls it and claims one per upload.
type PendingVideo = {
  id: string;
  s3_key: string;
  filename: string;
  size_bytes: number;
  created_at: Date;
  claimed: boolean;
};

// The watcher + worker endpoints are gated by the shared WATCHER_API_KEY (NOT the
// Zitadel JWT), the same check as routes/watcher.ts: Bearer token from the
// Authorization header, compared to env.WATCHER_API_KEY, UNAUTHORIZED (→ HTTP
// 401) on mismatch.
function assertWatcherKey(ctx: Context): void {
  const raw = ctx.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
  const token = header.replace('Bearer ', '');
  if (token !== env.WATCHER_API_KEY) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

const NotifySchema = z.object({
  key: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
});

const ArchivePatchSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  // Free-text tag names — resolved to genre record IDs (PB is the master list).
  tags: z.array(z.string()).optional(),
  mediaLinks: z
    .array(z.object({ label: z.string(), type: z.string(), url: z.string().url() }))
    .optional(),
});

export const watcherRouter = router({
  // POST /api/watcher/notify — called by the Windows watcher when a file lands on
  // S3. Watcher API-key gated (not the member JWT). Fire-and-forget insert so the
  // UI can pick the file up; conflicting keys are ignored.
  notify: publicProcedure.input(NotifySchema).mutation(({ ctx, input }) => {
    assertWatcherKey(ctx);

    const { key, filename, sizeBytes } = input;

    void db`
      INSERT INTO pending_videos (s3_key, filename, size_bytes)
      VALUES (${key}, ${filename}, ${sizeBytes})
      ON CONFLICT (s3_key) DO NOTHING
    `;

    console.log(`Watcher notified: ${filename} → ${key}`);
    return { ok: true as const };
  }),

  // GET /api/watcher/pending — UI polls this to show recently dropped files.
  // Member-JWT gated (protectedProcedure mirrors requireAuth).
  pending: protectedProcedure.query(async () => {
    return db<PendingVideo[]>`
      SELECT * FROM pending_videos
      WHERE claimed = false
      ORDER BY created_at DESC
      LIMIT 20
    `;
  }),

  // DELETE /api/watcher/pending/:id — mark as claimed once an upload is created.
  // Member-JWT gated.
  claimPending: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db`UPDATE pending_videos SET claimed = true WHERE id = ${input.id}`;
      return { ok: true as const };
    }),

  // PATCH /api/watcher/shows/:id — the worker writes the published result
  // (platform links + finalised metadata) back onto the PocketBase archive record
  // once all uploads succeed. Watcher API-key gated (same shared internal secret),
  // so PocketBase superuser creds stay in the api and never reach the worker.
  updateShow: publicProcedure
    .input(ArchivePatchSchema.extend({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertWatcherKey(ctx);

      const { id, tags, ...rest } = input;
      try {
        // Only touch the genres relation when tags were actually provided — an
        // empty array must NOT clear the record's curated genres (PB is master).
        const genres = tags && tags.length ? await resolveGenreIds(tags) : [];
        await updateArchiveRecord(id, { ...rest, ...(genres.length ? { genres } : {}) });
        return { ok: true as const };
      } catch (err) {
        console.error('Archive write-back failed:', err);
        // REST returns HTTP 502 here; tRPC has no BAD_GATEWAY code, so surface the
        // upstream PocketBase failure as INTERNAL_SERVER_ERROR (the request fails
        // with the same message, same as the REST 502).
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Archive write-back failed' });
      }
    }),
});
