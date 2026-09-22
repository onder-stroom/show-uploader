/**
 * What the jobs need from the outside world, and nothing about how it's done.
 *
 * Jobs receive these as a `deps` argument; `adapters.ts` builds the real ones
 * (S3, Postgres, Redis, the api's PocketBase write-back, YouTube, MixCloud) and
 * `index.ts` hands them over. Tests pass in-memory fakes (see test/fakes.ts).
 *
 * ffmpeg and the scratch workspace are deliberately NOT ports: they are local
 * tools on this box, not systems the jobs talk to, so the jobs import them.
 */
import type { JobPayload } from './types';

export type MediaLink = { label: string; type: string; url: string };

/** The S3 bucket holding recordings and their archives. */
export interface ObjectStore {
  download(key: string, destPath: string): Promise<void>;
  upload(localPath: string, key: string, contentType: string): Promise<void>;
  /** Byte size, or null when the object is missing. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

/** The agenda's archive record in PocketBase, reached through the api. */
export interface AgendaRecords {
  /**
   * Merge the published result onto the show's record. Never throws: the upload
   * already succeeded, so a write-back hiccup is logged, not a job failure.
   */
  finalize(
    showId: string,
    patch: { title?: string; notes?: string; tags?: string[]; mediaLinks?: MediaLink[] }
  ): Promise<void>;
  /** The record's cover image bytes, or null when it can't be fetched. */
  fetchCover(imageUrl: string): Promise<Buffer | null>;
}

/** The app's own rows: uploads, their platform jobs and pending recordings. */
export interface UploadRecords {
  setJobStatus(
    jobId: string,
    status: 'processing' | 'done' | 'failed',
    extra?: { result_url?: string; error?: string; progress_pct?: number }
  ): Promise<void>;
  getUpload(uploadId: string): Promise<{ show_id: string; jingle_s3_key: string | null } | null>;
  getPlatformJobs(uploadId: string): Promise<{ id: string; platform: string; status: string }[]>;
  setAudioKey(uploadId: string, key: string): Promise<void>;
  /** Repoint the upload at its archived video; also clears the trim it already carries. */
  setVideoKey(uploadId: string, key: string): Promise<void>;
  setDuration(uploadId: string, seconds: number): Promise<void>;
  /** Repoint a not-yet-published recording at its preview remux. Returns rows changed. */
  repointPreview(oldKey: string, newKey: string, filename: string, sizeBytes: number): Promise<number>;
}

/** The queue platform jobs run from. */
export interface PlatformQueue {
  add(platform: 'youtube' | 'mixcloud', payload: JobPayload): Promise<void>;
}

/** Returns the published video/cloudcast URL. */
export interface YoutubeUploader {
  upload(input: {
    videoPath: string;
    title: string;
    description: string;
    tags: string[];
    onProgress?: (pct: number) => void | Promise<void>;
  }): Promise<string>;
}

export interface MixcloudUploader {
  upload(input: {
    audioPath: string;
    title: string;
    description: string;
    tags: string[];
    imagePath?: string;
  }): Promise<string>;
}

/** Deployment settings the jobs read. */
export type WorkerConfig = {
  /** Public origin of this app, for permanent archive links. Null disables them. */
  appPublicUrl: string | null;
};

export type WorkerDeps = {
  store: ObjectStore;
  agenda: AgendaRecords;
  records: UploadRecords;
  platformQueue: PlatformQueue;
  youtube: YoutubeUploader;
  mixcloud: MixcloudUploader;
  config: WorkerConfig;
};
