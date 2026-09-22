/**
 * The real implementations of ports.ts, wired to this deployment. Built once in
 * deps.ts; nothing else constructs infrastructure for the use cases.
 */
import { db } from './db/client';
import {
  createPlatformJob,
  createUpload,
  deleteStagedUpload,
  getLatestUploadWithJobsForShow,
  getUploadWithJobs,
  isPrePublishVideoKey,
  listUploadingSessions,
  listUploadsNeedingRemux,
  releaseClaimForShow,
  resetPlatformJobForRetry,
  updateUploadMetadata,
} from './db/queries';
import { env } from './env';
import { previewQueue, uploadQueue } from './queue';
import { enqueueArchiveJob, enqueueCompressJob } from './services/archive-jobs';
import { getLiveState } from './services/live-guard';
import { syncMixcloudMetadata, syncYoutubeMetadata } from './services/platform-metadata';
import { presenceHub } from './services/presence-hub';
import { listUploadedParts, objectInfo } from './services/s3';
import { findShowFolder } from './services/show-folder';
import { getArchiveShow, resolveGenreIds, updateArchiveRecord } from './services/shows-api';
import type { PreviewJobView } from './services/video-preview';
import type { ApiDeps } from './ports';

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
    },
    agenda: {
      getShow: getArchiveShow,
      update: updateArchiveRecord,
      resolveGenres: resolveGenreIds,
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
    config: { jingleS3Key: env.JINGLE_S3_KEY ?? null },
  };
}
