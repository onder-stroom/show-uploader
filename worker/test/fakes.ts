import fs from 'fs';
import { vi } from 'vitest';
import type { WorkerDeps } from '../src/ports';

/**
 * In-memory stand-ins for every port, so a job test needs no module mocks for
 * S3, Postgres, Redis, PocketBase or the platforms. Each method is a vi.fn, so
 * tests can both inspect state (the bucket, the job log) and assert on calls.
 *
 * The bucket is real enough to catch ordering bugs: `download` writes the stored
 * bytes to disk, `upload` reads the file back, `size` answers from what was
 * uploaded, and `delete` really removes the key.
 */
export function fakeDeps(opts: {
  objects?: Record<string, Buffer | number>;
  upload?: { show_id: string; jingle_s3_key: string | null } | null;
  platformJobs?: { id: string; platform: string; status: string }[];
  appPublicUrl?: string | null;
  cover?: Buffer | null;
} = {}) {
  const bucket = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(opts.objects ?? {})) {
    bucket.set(key, typeof value === 'number' ? Buffer.alloc(value) : value);
  }
  const statuses: { jobId: string; status: string; extra?: Record<string, unknown> }[] = [];
  const upload = opts.upload === undefined ? { show_id: 'show-1', jingle_s3_key: null } : opts.upload;

  const deps = {
    store: {
      download: vi.fn(async (key: string, dest: string) => {
        const bytes = bucket.get(key);
        if (!bytes) throw new Error(`NoSuchKey: ${key}`);
        fs.writeFileSync(dest, bytes);
      }),
      upload: vi.fn(async (localPath: string, key: string, _contentType: string) => {
        bucket.set(key, fs.existsSync(localPath) ? fs.readFileSync(localPath) : Buffer.alloc(0));
      }),
      size: vi.fn(async (key: string) => bucket.get(key)?.length ?? null),
      delete: vi.fn(async (key: string) => {
        bucket.delete(key);
      }),
    },
    agenda: {
      finalize: vi.fn(async () => {}),
      fetchCover: vi.fn(async () => opts.cover ?? null),
    },
    records: {
      setJobStatus: vi.fn(async (jobId: string, status: string, extra?: Record<string, unknown>) => {
        statuses.push({ jobId, status, extra });
      }),
      getUpload: vi.fn(async () => upload),
      getPlatformJobs: vi.fn(async () => opts.platformJobs ?? []),
      setAudioKey: vi.fn(async () => {}),
      setVideoKey: vi.fn(async () => {}),
      setDuration: vi.fn(async () => {}),
      repointPreview: vi.fn(async () => 1),
    },
    platformQueue: { add: vi.fn(async () => {}) },
    youtube: { upload: vi.fn(async () => 'https://youtu.be/new') },
    mixcloud: { upload: vi.fn(async () => 'https://www.mixcloud.com/coming_soon/new/') },
    config: { appPublicUrl: opts.appPublicUrl === undefined ? 'https://uploader.test' : opts.appPublicUrl },
  } satisfies WorkerDeps;

  return {
    ...deps,
    bucket,
    statuses,
    /** The last status a job row was set to. */
    finalStatus: (jobId = 'job-1') => statuses.filter((s) => s.jobId === jobId).at(-1)?.status,
  };
}

/** A BullMQ job as the jobs read it: payload plus a progress sink. */
export function fakeJob<T>(data: T, id = 'bull-1') {
  return { id, data, updateProgress: vi.fn(async () => {}) } as never;
}
