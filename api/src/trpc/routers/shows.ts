import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import {
  listShows,
  listPublishedShows,
  listAllArchiveShows,
  listGenres,
  listArchiveStates,
  getArchiveShow,
  syncShowToPlatforms,
  updateArchiveRecord,
  resolveGenreIds,
  type ArchivePatch,
} from '../../services/shows-api';
import { baseTitle } from '@show-uploader/domain';
import { generateMeta } from '../../services/groq';
import { db } from '../../db/client';
import { recordPlatformSync, getPlatformSyncs } from '../../db/queries';

// tRPC mirror of the plain request/response endpoints in routes/shows.ts. The SSE
// routes stay REST; this router lives ALONGSIDE the Express routes (additive) and
// reuses the exact same services, so behaviour + responses match. All three
// endpoints require the same Zitadel JWT + `member` role that requireAuth
// enforces, so they use protectedProcedure.
export const showsRouter = router({
  // Full genre vocabulary for tag autocomplete
  // (PocketBase is the master list).
  listGenres: protectedProcedure.query(async () => {
    try {
      return await listGenres();
    } catch (err) {
      console.error('Failed to fetch genres:', err);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch genres',
      });
    }
  }),

  // The "to process" list (draft archive records).
  listShows: protectedProcedure.query(async () => {
    try {
      return await listShows();
    } catch (err) {
      console.error('Failed to fetch shows:', err);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch shows',
      });
    }
  }),

  // Shows already live elsewhere, for the "attach
  // a recording" picker. Filtered to ones missing cs-archive-video client-side
  // (see ui/src/pages/Attach.tsx) — this returns every published record.
  listPublished: protectedProcedure.query(async () => {
    try {
      return await listPublishedShows();
    } catch (err) {
      console.error('Failed to fetch published shows:', err);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch published shows',
      });
    }
  }),

  // The whole archive catalogue, every record and status — what the archive
  // page lists. Independent of show_uploads/platform_jobs: a deleted job must
  // not hide a record.
  listArchived: protectedProcedure.query(async () => {
    try {
      return await listAllArchiveShows();
    } catch (err) {
      console.error('Failed to fetch archived shows:', err);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch archived shows',
      });
    }
  }),

  // AI-generated upload copy. Never blocks the form on an AI hiccup: falls back
  // to the show's own copy, so this resolver never throws.
  generateMeta: protectedProcedure
    .input(
      z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const title = input?.title ?? '';
      const description = input?.description ?? '';
      try {
        return await generateMeta(title, description);
      } catch (err) {
        // Never block the form on an AI hiccup — fall back to the show's own copy.
        console.error('Groq meta generation failed, using fallback:', err);
        return {
          youtubeDescription: description || title || '',
          mixcloudDescription: description || title || '',
          tags: [] as string[],
        };
      }
    }),

  // Cover URL + live publish status per archive record, keyed by show_id. The
  // status is what lets the archive page report whether a show is actually on
  // the website rather than what this browser last clicked.
  listStates: protectedProcedure.query(async () => {
    try {
      return await listArchiveStates();
    } catch (err) {
      console.error('Failed to fetch archive states:', err);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch archive states' });
    }
  }),

  // A single archive record (any status): the current
  // PocketBase metadata a sync would push.
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    try {
      const show = await getArchiveShow(input.id);
      if (!show) throw new TRPCError({ code: 'NOT_FOUND', message: 'Show not found' });
      return show;
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      console.error('Failed to fetch show:', err);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch show' });
    }
  }),

  // Re-sync PocketBase metadata/cover to the
  // selected platforms (PB is the master). `platforms` narrows which (default all).
  syncPlatforms: protectedProcedure
    .input(z.object({ id: z.string().min(1), platforms: z.array(z.enum(['youtube', 'mixcloud'])).optional() }))
    .mutation(async ({ input }) => {
      try {
        const results = await syncShowToPlatforms(input.id, input.platforms ?? null);
        if (!results) throw new TRPCError({ code: 'NOT_FOUND', message: 'Show not found' });
        // Stamp only what the platform accepted — a failed sync must not look
        // fresh.
        for (const [platform, outcome] of Object.entries(results)) {
          if (outcome === 'ok') await recordPlatformSync(db, input.id, platform);
        }
        return { results };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        console.error('Failed to sync platforms:', err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to sync platforms' });
      }
    }),

  // GET — when each platform last accepted a metadata sync for this show, for
  // the sync panel's "last synced" line.
  syncTimes: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    try {
      const rows = await getPlatformSyncs(db, input.id);
      return Object.fromEntries(rows.map((r) => [r.platform, r.synced_at])) as Record<string, string>;
    } catch (err) {
      console.error('Failed to read sync times:', err);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to read sync times' });
    }
  }),

  // Persist the operator's in-progress edits straight to the PocketBase archive
  // record (the master), independent of the upload finishing — so edits on the
  // upload page survive a refresh or navigation. Every field is optional so a
  // caller can save just the tags (the common case) without touching title/notes.
  // The record keeps the plain title (baseTitle strips the platform date/@coming
  // soon suffix); tags are the genres relation, only written when non-empty so
  // clearing never wipes the curated genres. The worker still writes the platform
  // links back on publish.
  saveMetadata: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const patch: ArchivePatch = {};
      if (input.title !== undefined) patch.title = baseTitle(input.title);
      if (input.description !== undefined) patch.notes = input.description;
      if (input.tags && input.tags.length) patch.genres = await resolveGenreIds(input.tags);
      if (Object.keys(patch).length === 0) return { ok: true };
      try {
        await updateArchiveRecord(input.id, patch);
        return { ok: true };
      } catch (err) {
        console.error('Failed to save show metadata:', err);
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Failed to save to agenda' });
      }
    }),
});
