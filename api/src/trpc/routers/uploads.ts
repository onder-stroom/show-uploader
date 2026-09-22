import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { db } from '../../db/client';
import {
  listUploadsWithJobs,
  getUploadWithJobs,
  getStagedUpload,
  listStagedShowIds,
  deleteUpload,
} from '../../db/queries';
import { cancelQueuedJobs } from '../../services/archive-jobs';
import { createDownloadPresignedUrl } from '../../services/s3';
import { deleteStagedVideo } from '../../services/staged-video';
import { withDownloadUrls } from '../../services/upload-urls';
import { updateArchiveRecord } from '../../services/shows-api';
import { env } from '../../env';
import { deps } from '../../deps';
import { UseCaseError } from '../../usecases/errors';
import { publishUpload, publishToPlatform, retryJob } from '../../usecases/publish';
import { compressArchivedVideo, generateAudio, remuxBackfill } from '../../usecases/archive';
import { updateMetadata } from '../../usecases/metadata';
import { previewStatus, startPreview, uploadingProgress, videoInfo } from '../../usecases/recordings';

// Validation and error mapping only. Anything with rules in it lives in
// usecases/, so it reads (and tests) without tRPC in the way.

// HH:MM:SS or MM:SS format
const TimeCode = z.string().regex(/^(\d{1,2}:)?\d{2}:\d{2}$/).optional().nullable();

const CreateUploadSchema = z.object({
  showId: z.string(),
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  imageUrl: z.string().url().nullable().default(null),
  videoS3Key: z.string().min(1),
  // Empty is valid: attaching a recording to a show already published
  // elsewhere needs nothing to publish, just the archive step.
  platforms: z.array(z.enum(['youtube', 'mixcloud'])),
  includeJingle: z.boolean().default(true),
  // Auto-detect and cut leading/trailing silence (dead air) via ffmpeg. Manual
  // trim below overrides it.
  autoTrimSilence: z.boolean().default(true),
  trimStart: TimeCode,
  trimEnd: TimeCode,
});

const MetadataSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
});

// A refused rule keeps its code (404/409/412) and message; TRPCErrors pass
// through; anything else is logged and becomes INTERNAL_SERVER_ERROR.
function internal(err: unknown, logMessage: string, message: string): never {
  if (err instanceof UseCaseError) throw new TRPCError({ code: err.code, message: err.message });
  if (err instanceof TRPCError) throw err;
  console.error(logMessage, err);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
}

export const uploadsRouter = router({
  /**
   * Every upload with its jobs. Keys, not signed URLs.
   *
   * This list is polled, and signing here meant re-signing every artefact of
   * every upload on every poll: pure churn for objects that never change, and
   * it handed the UI a download URL that mutated underneath anything using it
   * (a playing <video> was torn down and restarted). The UI signs a key when
   * the operator actually asks for it — see storage.signObject.
   */
  list: protectedProcedure.query(async () => {
    try {
      return await listUploadsWithJobs(db);
    } catch (err) {
      internal(err, 'Failed to list uploads:', 'Failed to list uploads');
    }
  }),

  // One upload with its jobs + download URLs.
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    try {
      const upload = await getUploadWithJobs(db, input.id);
      if (!upload) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' });
      return await withDownloadUrls(upload);
    } catch (err) {
      internal(err, 'Failed to get upload:', 'Failed to get upload');
    }
  }),

  // Staged (uploaded, not-yet-published) video
  // for a show. Survives refresh and is visible on any machine.
  getStaged: protectedProcedure.input(z.object({ showId: z.string() })).query(async ({ input }) => {
    try {
      return await getStagedUpload(db, input.showId);
    } catch (err) {
      internal(err, 'Failed to read staged upload:', 'Failed to read staged upload');
    }
  }),

  // The operator abandoning a staged
  // pick (replace). See services/staged-video.ts for why this must delete the
  // S3 object while the post-publish cleanup in `create` below must not.
  deleteStaged: protectedProcedure.input(z.object({ showId: z.string() })).mutation(async ({ input }) => {
    await deleteStagedVideo(input.showId);
    return { ok: true };
  }),

  // Show_ids that already have a staged video, for the
  // "to process" table to flag which shows have a recording ready.
  getStagedShowIds: protectedProcedure.query(async () => {
    try {
      return await listStagedShowIds(db);
    } catch (err) {
      internal(err, 'Failed to list staged shows:', 'Failed to list staged shows');
    }
  }),

  getUploadingProgress: protectedProcedure.query(async () => {
    try {
      return await uploadingProgress(deps);
    } catch (err) {
      internal(err, 'Failed to read upload progress:', 'Failed to read upload progress');
    }
  }),

  // Presigned URL to preview the configured
  // jingle. NOT_FOUND when no jingle is set.
  getJinglePreview: protectedProcedure.query(async () => {
    if (!env.JINGLE_S3_KEY) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No jingle configured' });
    }
    try {
      const url = await createDownloadPresignedUrl(env.JINGLE_S3_KEY);
      return { url, filename: env.JINGLE_S3_KEY.split('/').pop() ?? 'jingle' };
    } catch (err) {
      internal(err, 'Failed to sign jingle URL:', 'Failed to sign jingle URL');
    }
  }),

  create: protectedProcedure.input(CreateUploadSchema).mutation(async ({ input }) => {
    try {
      return await publishUpload(input, deps);
    } catch (err) {
      internal(err, 'Failed to create upload:', 'Failed to create upload');
    }
  }),

  retryJob: protectedProcedure
    .input(z.object({ uploadId: z.string(), platform: z.enum(['youtube', 'mixcloud', 'archive']) }))
    .mutation(async ({ input }) => {
      try {
        await retryJob(input.uploadId, input.platform, deps);
        return { ok: true };
      } catch (err) {
        internal(err, 'Failed to retry job:', 'Failed to retry job');
      }
    }),

  generateAudio: protectedProcedure.input(z.object({ uploadId: z.string() })).mutation(async ({ input }) => {
    try {
      await generateAudio(input.uploadId, deps);
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to enqueue audio archive:', 'Failed to generate audio');
    }
  }),

  publishToPlatform: protectedProcedure
    .input(z.object({ showId: z.string().min(1), platform: z.enum(['youtube', 'mixcloud']) }))
    .mutation(async ({ input }) => {
      try {
        const { jobId } = await publishToPlatform(input.showId, input.platform, deps);
        return { ok: true, jobId };
      } catch (err) {
        internal(err, 'Failed to enqueue platform publish:', 'Failed to start the platform upload');
      }
    }),

  compressArchiveVideo: protectedProcedure
    .input(z.object({ showId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await compressArchivedVideo(input.showId, deps);
        return { ok: true };
      } catch (err) {
        internal(err, 'Failed to enqueue compress job:', 'Failed to start shrink');
      }
    }),

  remuxBackfill: protectedProcedure.mutation(async () => {
    try {
      return await remuxBackfill(deps);
    } catch (err) {
      internal(err, 'Failed to enqueue remux backfill:', 'Failed to start remux');
    }
  }),

  // Flip the PocketBase archive record to
  // "published" (the explicit, separate step that makes it live on the agenda).
  // Takes the agenda record's own id: this only ever writes to PocketBase, so
  // routing it through an upload row (just to read show_id back off it) would
  // make publishing fail for an archived show whose job was since deleted.
  publishRecord: protectedProcedure.input(z.object({ showId: z.string().min(1) })).mutation(async ({ input }) => {
    try {
      await updateArchiveRecord(input.showId, { status: 'published' });
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to publish archive record:', 'Failed to publish archive record');
    }
  }),

  startPreview: protectedProcedure
    .input(z.object({ videoS3Key: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await startPreview(input.videoS3Key, deps);
      } catch (err) {
        internal(err, 'Failed to start preview:', 'Failed to start preview');
      }
    }),

  previewStatus: protectedProcedure
    .input(z.object({ videoS3Key: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await previewStatus(input.videoS3Key, deps);
      } catch (err) {
        internal(err, 'Failed to read preview status:', 'Failed to read preview status');
      }
    }),

  videoInfo: protectedProcedure.input(z.object({ uploadId: z.string() })).query(async ({ input }) => {
    try {
      return await videoInfo(input.uploadId, deps);
    } catch (err) {
      internal(err, 'Failed to read video info:', 'Failed to read video info');
    }
  }),

  // The inverse: put the agenda record back to draft so it drops off the main
  // website. Only touches PocketBase status — the platform uploads and their
  // links stay exactly as they are.
  // Agenda record id, for the same reason publishRecord takes one.
  unpublishRecord: protectedProcedure.input(z.object({ showId: z.string().min(1) })).mutation(async ({ input }) => {
    try {
      await updateArchiveRecord(input.showId, { status: 'draft' });
      return { ok: true };
    } catch (err) {
      internal(err, 'Failed to unpublish archive record:', 'Failed to unpublish archive record');
    }
  }),

  // Remove an upload from the jobs queue: the row and its jobs go, the S3
  // objects and the PocketBase record stay. Allowed even while a job is
  // processing — a stuck job is exactly what an operator wants to clear.
  deleteUpload: protectedProcedure.input(z.object({ uploadId: z.string() })).mutation(async ({ input }) => {
    try {
      // Pull the queued work first: BullMQ keeps its own copy of the payload, so
      // a waiting job would happily publish an upload the operator just deleted.
      const { active } = await cancelQueuedJobs(input.uploadId);
      const removed = await deleteUpload(db, input.uploadId);
      if (!removed) throw new TRPCError({ code: 'NOT_FOUND', message: 'Upload not found' });
      // A job already in flight keeps its worker lock and runs to completion.
      return { ok: true, stillRunning: active };
    } catch (err) {
      internal(err, 'Failed to delete upload:', 'Failed to delete upload');
    }
  }),

  updateMetadata: protectedProcedure
    .input(z.object({ uploadId: z.string() }).merge(MetadataSchema))
    .mutation(async ({ input }) => {
      try {
        const { sync } = await updateMetadata(
          input.uploadId,
          { title: input.title, description: input.description, tags: input.tags },
          deps
        );
        return { ok: true, sync };
      } catch (err) {
        internal(err, 'Failed to update metadata:', 'Failed to update metadata');
      }
    }),
});
