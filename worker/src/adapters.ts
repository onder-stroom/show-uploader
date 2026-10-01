/**
 * The real implementations of ports.ts, wired to this deployment. The one place
 * jobs get their infrastructure from — built once in index.ts.
 */
import { env } from './env';
import {
  getPlatformJobsForUpload,
  getUploadRow,
  repointPreviewKey,
  setAudioKey,
  setJobStatus,
  setVideoDuration,
  setVideoKey,
} from './db';
import { uploadQueue } from './queue';
import { deleteFromS3, downloadFromS3, objectSize, uploadToS3 } from './services/s3';
import { finalizeArchiveRecord } from './services/shows-api';
import { uploadToMixcloud } from './services/mixcloud-client';
import { uploadToYoutube } from './services/youtube-client';
import { createRecordingsAgent } from './services/recordings-agent';
import { createUploadSessions } from './services/upload-sessions';
import type { WorkerDeps } from './ports';

export function createDeps(): WorkerDeps {
  return {
    store: {
      download: downloadFromS3,
      upload: uploadToS3,
      size: objectSize,
      delete: deleteFromS3,
    },
    agenda: {
      finalize: finalizeArchiveRecord,
      async fetchCover(imageUrl) {
        // Fetch the PB cover over the internal host (the public one isn't
        // reachable from inside the box — NAT hairpin); as-is when unset.
        const url =
          env.POCKETBASE_INTERNAL_URL && env.POCKETBASE_URL
            ? imageUrl.replace(env.POCKETBASE_URL, env.POCKETBASE_INTERNAL_URL)
            : imageUrl;
        try {
          const res = await fetch(url);
          if (!res.ok) {
            console.warn(`PB cover fetch ${res.status}`);
            return null;
          }
          return Buffer.from(await res.arrayBuffer());
        } catch (err) {
          console.warn('PB cover fetch failed:', err instanceof Error ? err.message : err);
          return null;
        }
      },
    },
    records: {
      async setJobStatus(jobId, status, extra) {
        await setJobStatus(jobId, status, extra);
      },
      getUpload: getUploadRow,
      getPlatformJobs: getPlatformJobsForUpload,
      setAudioKey,
      setVideoKey,
      setDuration: setVideoDuration,
      repointPreview: repointPreviewKey,
    },
    platformQueue: {
      async add(platform, payload) {
        await uploadQueue.add(platform, payload);
      },
    },
    youtube: { upload: (input) => uploadToYoutube(input) },
    mixcloud: { upload: (input) => uploadToMixcloud(input) },
    agent: createRecordingsAgent({ baseUrl: env.RECORDINGS_AGENT_URL, token: env.RECORDINGS_AGENT_TOKEN }),
    sessions: createUploadSessions({ baseUrl: env.INTERNAL_API_URL, apiKey: env.WATCHER_API_KEY }),
    config: {
      appPublicUrl: env.APP_PUBLIC_URL ?? null,
      cutPoll: { intervalMs: env.CUT_POLL_INTERVAL_MS, cutTimeoutMs: env.CUT_WAIT_MS, uploadTimeoutMs: env.UPLOAD_WAIT_MS },
    },
  };
}
