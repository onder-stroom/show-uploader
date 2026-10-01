import { RECORDING_CUTS_QUEUE, type CutJobPayload } from '@show-uploader/domain';
import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env';

export const QUEUE_NAME = 'platform-uploads';
export const COMPRESS_QUEUE_NAME = 'compress-jobs';
export const PREVIEW_QUEUE_NAME = 'video-previews';

// Cast to bullmq's ConnectionOptions: bullmq bundles its own nested ioredis copy,
// so the instance's type differs from ours even though it's the same runtime class.
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
}) as unknown as ConnectionOptions;

export const uploadQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

// Compress re-encodes get their own queue and their own worker lane: a shrink
// is the slowest job in the system (a whole-file re-encode) and used to park
// every fresh upload behind it for an hour. One attempt — the job is lossy and
// manual, so a retry is the operator's call, never automatic.
export const compressQueue = new Queue(COMPRESS_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

// Mirrors worker/src/queue.ts. Kept to one attempt: a failed remux leaves the
// source recording untouched, so retrying is just pressing preview again.
export const previewQueue = new Queue<PreviewJobPayload>(PREVIEW_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

// The worker's cut-recording lane. Three attempts with a long backoff: a failure is
// usually the PC being briefly offline, and a retry resumes the upload where it stopped.
export const recordingCutQueue = new Queue<CutJobPayload>(RECORDING_CUTS_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

export type PreviewJobPayload = {
  videoS3Key: string;
};

export type JobPayload = {
  jobId: string;
  uploadId: string;
  platform: 'youtube' | 'mixcloud' | 'archive' | 'compress';
  videoS3Key: string;
  audioS3Key?: string | null;
  title: string;
  description: string;
  tags: string[];
  imageUrl: string | null;
  jingleS3Key: string | null;
  includeJingle: boolean;
  trimStart: string | null;
  trimEnd: string | null;
};
