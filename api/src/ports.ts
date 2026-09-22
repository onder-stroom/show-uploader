/**
 * What the use cases (usecases/) need from the outside world, and nothing about
 * how it's done — the api's counterpart of worker/src/ports.ts.
 *
 * Use cases take these as a `deps` argument; `adapters.ts` builds the real ones
 * (Postgres, S3, PocketBase, BullMQ, YouTube/MixCloud, the presence hub) and
 * `deps.ts` holds the one instance the routers pass in. Tests pass in-memory
 * fakes (see test/fakes.ts).
 *
 * Routers and REST routes are the other side of the hexagon: they translate
 * HTTP into calls. Simple reads there still call services directly; anything
 * with a rule in it goes through a use case and these ports.
 */
import type { PlatformJob, ShowUpload } from './db/queries';
import type { JobPayload } from './queue';
import type { AgendaShow, ArchivePatch } from './services/shows-api';
import type { PreviewJobView } from './services/video-preview';

export type UploadWithJobs = ShowUpload & { jobs: PlatformJob[] };

export type NewUpload = Pick<
  ShowUpload,
  'show_id' | 'title' | 'description' | 'tags' | 'image_url' | 'video_s3_key' | 'jingle_s3_key' | 'trim_start' | 'trim_end'
> & { audio_s3_key?: string | null };

export type MetadataEdit = { title: string; description: string; tags: string[] };

/** The app's own rows (Postgres): uploads, their jobs, claims and staging. */
export interface UploadStore {
  create(data: NewUpload): Promise<ShowUpload>;
  createJob(uploadId: string, platform: PlatformJob['platform']): Promise<PlatformJob>;
  get(uploadId: string): Promise<UploadWithJobs | null>;
  latestForShow(showId: string): Promise<UploadWithJobs | null>;
  needingRemux(): Promise<UploadWithJobs[]>;
  updateMetadata(uploadId: string, edit: MetadataEdit): Promise<void>;
  /** Back to queued, clearing progress, error and result. */
  resetJob(jobId: string): Promise<void>;
  releaseClaim(showId: string): Promise<void>;
  /** Drop the staged row only — never the S3 object it names. */
  clearStaged(showId: string): Promise<void>;
  /** Is any of these keys a recording the app is holding for publication? */
  isPrePublishVideo(keys: string[]): Promise<boolean>;
  /** Multipart uploads still in flight, one per show. */
  uploadingSessions(): Promise<{ show_id: string; s3_key: string; s3_upload_id: string; size_bytes: string }[]>;
}

/** The S3 bucket. */
export interface ObjectStore {
  info(key: string): Promise<{ exists: boolean; size: number | null }>;
  uploadedParts(key: string, uploadId: string): Promise<{ Size?: number }[]>;
  /** The `shows/<folder>/` holding an agenda record's recording, if any. */
  findShowFolder(show: AgendaShow): Promise<string | null>;
}

/** The agenda: PocketBase archive records and the broadcast schedule. */
export interface Agenda {
  getShow(showId: string): Promise<AgendaShow | null>;
  update(showId: string, patch: ArchivePatch): Promise<void>;
  /** Genre record ids for these names, creating any that don't exist yet. */
  resolveGenres(names: string[]): Promise<string[]>;
  /** Whether a show is on air now, and when heavy work may resume. Fails open. */
  liveState(now: Date): Promise<{ isLive: boolean; resumeAt: Date | null }>;
}

export type PlatformPayload = JobPayload & { platform: 'youtube' | 'mixcloud'; autoTrimSilence?: boolean };

/** The job queues the worker consumes. */
export interface JobQueue {
  /** Queue (or re-queue) the upload's archive job; false when it's already running. */
  enqueueArchive(
    upload: UploadWithJobs,
    opts?: { delay?: number; includeJingle?: boolean; autoTrimSilence?: boolean }
  ): Promise<boolean>;
  /** Queue the upload's shrink job; false when one is already queued or running. */
  enqueueCompress(upload: UploadWithJobs): Promise<boolean>;
  enqueuePlatform(payload: PlatformPayload): Promise<void>;
  /** Start a preview remux; a failed earlier attempt with this id is cleared first. */
  queuePreview(videoS3Key: string, jobId: string): Promise<void>;
  /** The preview job's state, or null when there is none. */
  previewJob(jobId: string): Promise<PreviewJobView>;
}

/** Already-published metadata on the platforms. Each returns an error message, or null. */
export interface PlatformMetadata {
  syncYoutube(url: string, edit: MetadataEdit): Promise<string | null>;
  syncMixcloud(url: string, edit: MetadataEdit): Promise<string | null>;
}

/** Tells connected browsers the claim list changed. */
export interface Presence {
  broadcastClaims(): void;
}

export type ApiConfig = {
  /** The jingle prepended on MixCloud, if one is configured. */
  jingleS3Key: string | null;
};

export type ApiDeps = {
  uploads: UploadStore;
  objects: ObjectStore;
  agenda: Agenda;
  queue: JobQueue;
  platforms: PlatformMetadata;
  presence: Presence;
  config: ApiConfig;
};
