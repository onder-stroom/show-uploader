/**
 * The real implementations of ports.ts, wired to this deployment. Built once in
 * deps.ts; nothing else constructs infrastructure for the use cases.
 */
import type { CutStep } from '@show-uploader/domain';
import { db } from './db/client';
import {
  createMultipartSession,
  createPlatformJob,
  createUpload,
  deleteStagedUpload,
  findMultipartSessionByCutId,
  getLatestUploadWithJobsForShow,
  getMultipartSession,
  getUploadWithJobs,
  isPrePublishVideoKey,
  listUploadingSessions,
  listUploadsNeedingRemux,
  releaseClaimForShow,
  resetPlatformJobForRetry,
  setMultipartStatus,
  updateUploadMetadata,
  upsertStagedUpload,
} from './db/queries';
import { env } from './env';
import { previewQueue, recordingCutQueue, uploadQueue } from './queue';
import { enqueueArchiveJob, enqueueCompressJob } from './services/archive-jobs';
import { getLiveState } from './services/live-guard';
import { syncMixcloudMetadata, syncYoutubeMetadata } from './services/platform-metadata';
import { presenceHub } from './services/presence-hub';
import { createRecordingsAgent } from './services/recordings-agent';
import { abortMultipart, completeMultipart, createMultipart, listUploadedParts, objectInfo, presignUploadPart } from './services/s3';
import { findShowFolder } from './services/show-folder';
import { createArchiveDraft, getArchiveShow, listShows, listStrands, resolveGenreIds, updateArchiveRecord } from './services/shows-api';
import type { PreviewJobView } from './services/video-preview';
import type { ApiDeps, CutJobView } from './ports';

export function createDeps(): ApiDeps {
  return {
    uploads: {
      create: (data) => createUpload(db, data),
      createJob: (uploadId, platform) => createPlatformJob(db, { upload_id: uploadId, platform }),
      get: (uploadId) => getUploadWithJobs(db, uploadId),
      latestForShow: (showId) => getLatestUploadWithJobsForShow(db, showId),
      needingRemux: () => listUploadsNeedingRemux(db),
      async updateMetadata(uploadId, edit) {
        await updateUploadMetadata(db, uploadId, edit);
      },
      async resetJob(jobId) {
        await resetPlatformJobForRetry(db, jobId);
      },
      async releaseClaim(showId) {
        await releaseClaimForShow(db, showId);
      },
      async clearStaged(showId) {
        await deleteStagedUpload(db, showId);
      },
      isPrePublishVideo: (keys) => isPrePublishVideoKey(db, keys),
      uploadingSessions: () => listUploadingSessions(db),
    },
    objects: {
      info: objectInfo,
      uploadedParts: listUploadedParts,
      findShowFolder,
      createMultipart,
      presignPart: presignUploadPart,
      completeMultipart,
      abortMultipart,
    },
    sessions: {
      create: (data) => createMultipartSession(db, data),
      get: (id) => getMultipartSession(db, id),
      findByCutId: (cutId) => findMultipartSessionByCutId(db, cutId),
      setStatus: (id, status) => setMultipartStatus(db, id, status),
      async stage(showId, key, filename, sizeBytes) {
        await upsertStagedUpload(db, showId, key, filename, sizeBytes);
      },
    },
    agenda: {
      getShow: getArchiveShow,
      update: updateArchiveRecord,
      resolveGenres: resolveGenreIds,
      listStrands,
      listDrafts: listShows,
      createDraft: createArchiveDraft,
      liveState: getLiveState,
    },
    queue: {
      enqueueArchive: (upload, opts) => enqueueArchiveJob(db, upload, opts),
      enqueueCompress: (upload) => enqueueCompressJob(db, upload),
      async enqueuePlatform(payload) {
        await uploadQueue.add(payload.platform, payload);
      },
      async queuePreview(videoS3Key, jobId) {
        // A previous failure keeps its job (and id) around, which would make the
        // retry a silent no-op. Clear it so pressing preview again really retries.
        const existing = await previewQueue.getJob(jobId);
        if (existing && (await existing.isFailed())) await existing.remove();
        await previewQueue.add('preview', { videoS3Key }, { jobId });
      },
      async previewJob(jobId) {
        const job = await previewQueue.getJob(jobId);
        if (!job) return null;
        return {
          status: (await job.getState()) as NonNullable<PreviewJobView>['status'],
          pct: typeof job.progress === 'number' ? job.progress : 0,
          failedReason: job.failedReason,
        };
      },
    },
    platforms: {
      syncYoutube: syncYoutubeMetadata,
      syncMixcloud: syncMixcloudMetadata,
    },
    presence: {
      broadcastClaims: () => void presenceHub.broadcastClaims(),
    },
    recordings: createRecordingsAgent({ baseUrl: env.RECORDINGS_AGENT_URL, token: env.RECORDINGS_AGENT_TOKEN }),
    cuts: {
      async enqueue(payload) {
        // A finished or failed job under this id would make the add a silent no-op. Clear
        // it so a deliberate redo really runs. A job that is waiting or running is left
        // alone, which is what makes a double confirm harmless.
        const existing = await recordingCutQueue.getJob(payload.cutId);
        if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) await existing.remove();
        await recordingCutQueue.add('cut', payload, { jobId: payload.cutId });
      },
      async job(cutId) {
        const job = await recordingCutQueue.getJob(cutId);
        if (!job) return null;
        const progress = job.progress as { step?: CutStep } | number;
        return {
          status: (await job.getState()) as NonNullable<CutJobView>['status'],
          step: typeof progress === 'object' && progress ? (progress.step ?? null) : null,
          failedReason: job.failedReason ?? null,
        };
      },
    },
    config: { jingleS3Key: env.JINGLE_S3_KEY ?? null, recordingsSecret: env.RECORDINGS_AGENT_TOKEN ?? null },
  };
}
