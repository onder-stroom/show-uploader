import { vi } from 'vitest';
import type { PlatformJob } from '../src/db/queries';
import type { ApiDeps, UploadWithJobs } from '../src/ports';
import type { AgendaShow } from '../src/services/shows-api';

/**
 * In-memory stand-ins for every api port, so a use-case test needs no module
 * mocks. Each method is a vi.fn, so tests can both inspect state (the upload
 * rows, the queue) and assert on calls.
 */
export function fakeDeps(opts: {
  uploads?: UploadWithJobs[];
  shows?: Partial<AgendaShow>[];
  objects?: string[];
  folders?: Record<string, string>;
  live?: { isLive: boolean; resumeAt: Date | null };
  jingleS3Key?: string | null;
} = {}) {
  const uploads = new Map((opts.uploads ?? []).map((u) => [u.id, u]));
  const shows = new Map((opts.shows ?? []).map((s) => [s.id!, s as AgendaShow]));
  const objects = new Set(opts.objects ?? []);
  const queued: { kind: string; payload: unknown }[] = [];
  let nextId = 1;

  const deps = {
    uploads: {
      create: vi.fn(async (data) => {
        const row = {
          id: `up-${nextId++}`,
          archive_s3_key: null,
          audio_s3_key: null,
          duration_seconds: null,
          created_at: new Date(),
          ...data,
        } as UploadWithJobs;
        uploads.set(row.id, { ...row, jobs: [] });
        return row;
      }),
      createJob: vi.fn(async (uploadId: string, platform: PlatformJob['platform']) => {
        const job = { id: `job-${nextId++}`, upload_id: uploadId, platform, status: 'queued', result_url: null } as PlatformJob;
        uploads.get(uploadId)?.jobs.push(job);
        return job;
      }),
      get: vi.fn(async (id: string) => uploads.get(id) ?? null),
      latestForShow: vi.fn(async (showId: string) => [...uploads.values()].find((u) => u.show_id === showId) ?? null),
      needingRemux: vi.fn(async () => [...uploads.values()].filter((u) => !/\.mp4$/i.test(u.video_s3_key))),
      updateMetadata: vi.fn(async () => {}),
      resetJob: vi.fn(async (jobId: string) => {
        for (const u of uploads.values()) {
          const job = u.jobs.find((j) => j.id === jobId);
          if (job) Object.assign(job, { status: 'queued', error: null, result_url: null });
        }
      }),
      releaseClaim: vi.fn(async () => {}),
      clearStaged: vi.fn(async () => {}),
      isPrePublishVideo: vi.fn(async () => true),
      uploadingSessions: vi.fn(async () => []),
    },
    objects: {
      info: vi.fn(async (key: string) => ({ exists: objects.has(key), size: objects.has(key) ? 1 : null })),
      uploadedParts: vi.fn(async () => []),
      findShowFolder: vi.fn(async (show: AgendaShow) => opts.folders?.[show.id] ?? null),
    },
    agenda: {
      getShow: vi.fn(async (id: string) => shows.get(id) ?? null),
      update: vi.fn(async () => {}),
      resolveGenres: vi.fn(async (names: string[]) => names.map((n) => `genre-${n}`)),
      liveState: vi.fn(async () => opts.live ?? { isLive: false, resumeAt: null }),
    },
    queue: {
      enqueueArchive: vi.fn(async (upload: UploadWithJobs, o?: unknown) => {
        queued.push({ kind: 'archive', payload: { uploadId: upload.id, ...(o as object) } });
        return true;
      }),
      enqueueCompress: vi.fn(async (upload: UploadWithJobs) => {
        queued.push({ kind: 'compress', payload: { uploadId: upload.id } });
        return true;
      }),
      enqueuePlatform: vi.fn(async (payload) => {
        queued.push({ kind: payload.platform, payload });
      }),
      queuePreview: vi.fn(async () => {}),
      previewJob: vi.fn(async () => null),
    },
    platforms: {
      syncYoutube: vi.fn(async () => null),
      syncMixcloud: vi.fn(async () => null),
    },
    presence: { broadcastClaims: vi.fn() },
    config: { jingleS3Key: opts.jingleS3Key ?? null },
  } satisfies ApiDeps;

  return { ...deps, rows: uploads, queued };
}

/** An upload row with jobs, archived under shows/ unless overridden. */
export function uploadRow(over: Partial<UploadWithJobs> = {}, jobs: Partial<PlatformJob>[] = []): UploadWithJobs {
  return {
    id: 'up-1',
    show_id: 'show-1',
    title: 'Palmbomen II',
    description: null,
    tags: [],
    image_url: null,
    video_s3_key: 'shows/2026-08-08-palmbomen-ii/video.mp4',
    archive_s3_key: null,
    audio_s3_key: 'shows/2026-08-08-palmbomen-ii/audio.m4a',
    jingle_s3_key: null,
    trim_start: null,
    trim_end: null,
    duration_seconds: null,
    created_at: new Date(),
    ...over,
    jobs: jobs.map((j, i) => ({
      id: `job-${i}`,
      upload_id: over.id ?? 'up-1',
      result_url: null,
      error: null,
      progress_pct: 0,
      created_at: new Date(),
      updated_at: new Date(),
      platform: 'archive',
      status: 'queued',
      ...j,
    })) as PlatformJob[],
  };
}
