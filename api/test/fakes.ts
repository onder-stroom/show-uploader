import { vi } from 'vitest';
import type { AgentHealth, AgentRecording, DraftSegment } from '@show-uploader/domain';
import type { PlatformJob } from '../src/db/queries';
import type { ApiDeps, UploadSession, UploadWithJobs } from '../src/ports';
import type { DraftResult } from '../src/services/recordings-agent';
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
  recordings?: AgentRecording[] | null;
  strands?: { id: string; name: string; isDefault: boolean }[];
  health?: AgentHealth | null;
  draft?: DraftResult;
  saveDraft?: DraftResult;
  recordingsSecret?: string | null;
} = {}) {
  const uploads = new Map((opts.uploads ?? []).map((u) => [u.id, u]));
  const shows = new Map((opts.shows ?? []).map((s) => [s.id!, s as AgendaShow]));
  const objects = new Set(opts.objects ?? []);
  const queued: { kind: string; payload: unknown }[] = [];
  let nextId = 1;
  const sessionRows = new Map<string, UploadSession>();
  const staged = new Map<string, { key: string; filename: string; size: number }>();

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
      // A complete part list for the session by default (every part full, last one short).
      uploadedParts: vi.fn(async (key: string, _uploadId: string) => {
        const s = [...sessionRows.values()].find((r) => r.s3_key === key);
        if (!s) return [];
        const size = Number(s.size_bytes);
        const n = Math.max(1, Math.ceil(size / s.part_size));
        return Array.from({ length: n }, (_, i) => ({
          PartNumber: i + 1,
          Size: i < n - 1 ? s.part_size : size - s.part_size * (n - 1),
        }));
      }),
      findShowFolder: vi.fn(async (show: AgendaShow) => opts.folders?.[show.id] ?? null),
      createMultipart: vi.fn(async (_key: string, _contentType: string) => 'mpu-1'),
      presignPart: vi.fn(async (key: string, _uploadId: string, n: number) => `https://s3.test/${key}?part=${n}`),
      completeMultipart: vi.fn(async (_key: string, _uploadId: string) => {}),
      abortMultipart: vi.fn(async (_key: string, _uploadId: string) => {}),
    },
    sessions: {
      create: vi.fn(async (d) => {
        const id = `sess-${nextId++}`;
        sessionRows.set(id, {
          id, show_id: d.showId, s3_key: d.key, s3_upload_id: d.s3UploadId, filename: d.filename,
          size_bytes: String(d.size), content_type: d.contentType, part_size: d.partSize,
          status: 'in_progress', cut_id: d.cut?.cutId ?? null,
        });
        return id;
      }),
      get: vi.fn(async (id: string) => sessionRows.get(id) ?? null),
      findByCutId: vi.fn(
        async (cutId: string) => [...sessionRows.values()].find((s) => s.cut_id === cutId && s.status !== 'aborted') ?? null
      ),
      setStatus: vi.fn(async (id: string, status: 'completed' | 'aborted') => {
        const s = sessionRows.get(id);
        if (s) s.status = status;
      }),
      stage: vi.fn(async (showId: string, key: string, filename: string, size: number) => {
        staged.set(showId, { key, filename, size });
      }),
    },
    agenda: {
      getShow: vi.fn(async (id: string) => shows.get(id) ?? null),
      update: vi.fn(async () => {}),
      resolveGenres: vi.fn(async (names: string[]) => names.map((n) => `genre-${n}`)),
      listStrands: vi.fn(async () => opts.strands ?? [{ id: 'strand-cs', name: 'coming soon', isDefault: true }, { id: 'strand-bos', name: 'De Bosbar', isDefault: false }]),
      listDrafts: vi.fn(async () => [...shows.values()]),
      createDraft: vi.fn(async (input: { title: string; date: string; startTime: string; endTime: string; strandId: string | null }) => ({
        id: 'new-show', title: input.title, description: '', date: input.date, startTime: input.startTime, endTime: input.endTime,
        imageUrl: null, tags: null, mediaLinks: [], showDescription: null, strand: null, updated: '',
      }) as AgendaShow),
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
    recordings: {
      list: vi.fn(async () => (opts.recordings === undefined ? [] : opts.recordings)),
      rescan: vi.fn(async () => (opts.recordings === undefined ? [] : opts.recordings)),
      health: vi.fn(async () => (opts.health === undefined ? { ok: true, protocol: 2, build: 'abc1234', ready: 1, preparing: 0, failed: 0, recordingActive: false } : opts.health) as AgentHealth | null),
      getDraft: vi.fn(async (_ref: string) => (opts.draft ?? { kind: 'ok', draft: null }) as DraftResult),
      saveDraft: vi.fn(async (_ref: string, segments: DraftSegment[]) => (opts.saveDraft ?? { kind: 'ok', draft: { segments, savedAtMs: 1 } }) as DraftResult),
      peaks: vi.fn(async (_ref: string) => [0.1] as number[] | null),
      preview: vi.fn(async (_ref: string, _range: string | undefined, _signal?: AbortSignal) => null as Response | null),
    },
    cuts: {
      enqueue: vi.fn(async (payload: unknown) => void queued.push({ kind: 'cut', payload })),
      job: vi.fn(async (_cutId: string) => null as import('../src/ports').CutJobView),
    },
    presence: { broadcastClaims: vi.fn() },
    config: { jingleS3Key: opts.jingleS3Key ?? null, recordingsSecret: opts.recordingsSecret === undefined ? 's'.repeat(24) : opts.recordingsSecret },
  } satisfies ApiDeps;

  return { ...deps, rows: uploads, queued, sessionRows, staged };
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
