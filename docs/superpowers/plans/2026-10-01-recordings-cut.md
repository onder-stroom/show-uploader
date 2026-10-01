# Cut Recordings Into Per-Artist Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator opens a recording from the OBS PC in the uploader, marks one segment per artist, matches each to a show, and confirms. Each segment is cut losslessly on the PC, uploaded to S3 as that show's staged recording, and published through the normal pipeline.

**Architecture:** A Node/TS Windows service on the OBS PC (the `watcher/` package, rewritten) owns files and ffmpeg and answers a bearer-token HTTP API over Tailscale. A new worker job `cut-recording` orchestrates one cut at a time: cut on the PC, open an S3 multipart session through the api, have the PC upload parts to presigned URLs, complete through the api. The api reuses `multipart_uploads` and `staged_uploads`, so no new video-state table exists. Pure rules (segment validation, agenda-time suggestions, the agent contract types) live in `packages/domain`.

**Tech Stack:** Node 20, TypeScript, pnpm workspace, vitest, Express (api + PC service), tRPC, BullMQ, Postgres (`postgres` tag client), React + MUI + TanStack Query, ffmpeg/ffprobe.

**Spec:** `docs/superpowers/specs/2026-10-01-recordings-cut-design.md`

## Global Constraints

- Node 20, TypeScript strict, CommonJS output (`"module": "commonjs"`) in api, worker, watcher and domain.
- Audio is AAC, never MP3. OBS records AAC on tracks 1, 3, 4; **track 1 is the mix** and is the only audio stream a cut carries.
- OBS video is HEVC. Cuts and remuxes copy video (`-c copy`) and tag `hvc1`. The editor plays an H.264 preview, never the full-quality file.
- Cuts are stream copy, never re-encoded. The start is exact via an MP4 edit list (`-ss` before `-i`).
- Config comes from env vars documented in `.env.example`. No hardcoded endpoints or credentials.
- No endpoint returns a signed URL in a polled response. Signed preview paths come from a query keyed by recording, not from a list.
- The PC service holds no credentials for the api, S3 or PocketBase. It only receives presigned part URLs.
- Jobs and use cases take a `deps` argument and never import `db`, the queue, `s3`, `shows-api`, a platform client or `env`.
- Routers stay thin: validate input, call a use case, map `UseCaseError` (`NOT_FOUND`, `CONFLICT`, `PRECONDITION_FAILED`) to a tRPC code.
- Agenda times are draft markers only. They suggest, never decide. The operator confirms every segment.
- Deleting a recording by hand must never be an error or an alert anywhere.
- Commits: Conventional Commits, one-line subject, body of a few lines at most, **no AI/Claude attribution lines**. Commit on `feat/recordings-cut`, never on `master`.
- Run tests and typecheck for every package touched before committing. After changing jobs, use cases or adapters, run `pnpm e2e`.

## Review Focus

1. **Recording deleted between listing and cutting** → that segment ends `source_gone` with a plain message, is never retried, and already-uploaded segments are untouched. (Task 7 PC, Task 12 api refusal, Task 14 worker, Task 17 e2e)
2. **OBS still recording while a prepare job wants ffmpeg** → prepare is deferred until no file in the folder is still growing. (Task 5 detection, Task 9 scheduler)
3. **Multi-audio-track MKV** → the cut and the master contain exactly one audio stream, track 1, never the default-picked stream. (Task 4 real ffmpeg, Task 6 verification, Task 17 e2e)
4. **Double confirm / retried request** → one job per `cutId`, one multipart session, no duplicate staged video. (Task 12 deterministic ids and session reuse, Task 14 completed-session handling)
5. **Presigned part upload fails mid-way or the PC restarts** → parts already on S3 are not re-sent; the session is aborted only when the job finally gives up. (Task 7 PC resume, Task 14 worker retry policy)

---

## File Structure

**New**
- `packages/domain/src/recording-segments.ts` — segment validation and agenda-time suggestions (pure).
- `packages/domain/src/recordings-contract.ts` — agent protocol types shared by api, worker, PC.
- `watcher/src/config.ts` — env parsing for the PC service.
- `watcher/src/ffmpeg.ts` — ffmpeg/ffprobe argument builders and runner.
- `watcher/src/library.ts` — folder scan, readiness, refs, sidecar state.
- `watcher/src/prepare.ts` — remux + verify + preview + peaks for one recording.
- `watcher/src/cuts.ts` — cut state machine, staging, part upload.
- `watcher/src/prune.ts` — retention pruner.
- `watcher/src/scheduler.ts` — one background pass: sync, prepare at most one recording while OBS is idle, prune.
- `watcher/src/server.ts` — Express app implementing the v1 contract.
- `watcher/src/index.ts` — composition root (rewritten).
- `watcher/service/show-uploader-recordings.xml` — WinSW service definition.
- `watcher/README.md` — install and operate.
- `api/src/db/migrations/012_multipart_cut_source.sql` — provenance columns.
- `api/src/usecases/uploads.ts` — `openUploadSession`, `completeUpload`, `abortUpload` (extracted).
- `api/src/routes/respond.ts` — maps a `UseCaseError` to an HTTP status for REST routes.
- `scripts/e2e/recordings.mjs` — end-to-end on the real built service, api and worker.
- `api/src/usecases/recording-cuts.ts` — `listRecordings`, `startCuts`, `openCutSession`.
- `api/src/services/recordings-agent.ts` — HTTP adapter to the PC.
- `api/src/services/preview-signature.ts` — sign/verify preview paths.
- `api/src/trpc/routers/recordings.ts` — tRPC router.
- `api/src/routes/recordings.ts` — preview proxy + internal worker endpoints.
- `worker/src/jobs/cut-recording.ts` — the orchestration job.
- `worker/src/services/recordings-agent.ts`, `worker/src/services/upload-sessions.ts` — adapters.
- `ui/src/upload/resolveSegment.ts` (+ test), `ui/src/pages/Recordings.tsx`, `ui/src/components/RecordingTimeline.tsx`.
- `docs/architecture/recordings-cut.md`.

**Modified**
- `packages/domain/src/index.ts`; `api/src/ports.ts`, `adapters.ts`, `deps.ts`, `env.ts`, `app.ts`, `queue/index.ts`, `trpc/root.ts`, `routes/multipart.ts`, `test/fakes.ts`; `worker/src/ports.ts`, `adapters.ts`, `queue.ts`, `types.ts`, `index.ts`, `env.ts`, `test/fakes.ts`; `ui/src/api/hooks.ts`, `router.tsx`, `dev/mock-backend.ts`, `dev/fixtures.ts`; `scripts/e2e/*`; `.env.example`; `docker-compose.prod.yml`; `AGENTS.md`; `watcher/package.json`, `tsconfig.json`; the spec (Task 0).

---

### Task 0: Amend the spec for two decisions found while planning

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-recordings-cut-design.md`

**Interfaces:**
- Produces: the spec text the other tasks cite (retention rule, preview auth).

Two spec statements cannot be built as written. The PC has no credentials and so cannot know when a segment is *archived*; and a `<video>` element cannot send an `Authorization` header, so the preview route cannot sit under `requireAuth`.

- [ ] **Step 1: Replace the Retention section**

Replace the whole `## Retention` section body with:

```markdown
The PC prunes a recording once at least one segment cut from it has uploaded
successfully **and** the retention period (default 14 days, `RETENTION_DAYS`) has
passed since the most recent successful cut upload. The PC has no credentials for the
api, so it cannot observe archival; "uploaded plus a grace period" is the rule it can
enforce. A recording that was never cut is never pruned automatically. Pruning is an
optimisation, not a guarantee: the operator may delete earlier, and the system never
depends on a file still existing.
```

- [ ] **Step 2: Replace the preview/peaks REST bullet in the api section**

Replace the bullet starting `- **REST** (streaming, which tRPC cannot do)` with:

```markdown
- **REST** (streaming, which tRPC cannot do): `GET /api/recordings/preview/:ref` proxies
  the agent's preview with Range support. A `<video>` element cannot send an
  `Authorization` header, so the route is authenticated by a short-lived HMAC signature
  in the query (`exp`, `sig`), not by `requireAuth`. The signature is issued by the tRPC
  query `recordings.signPreview({ref})`, keyed by recording like `storage.signObject`, so
  it is fetched once per viewing session and the `<video src>` never swaps. Waveform peaks
  are a plain tRPC query, `recordings.peaks({ref})`.
```

- [ ] **Step 3: Replace the provenance bullet in the Data section**

Replace the bullet starting `- \`multipart_uploads\` (existing, already bound to \`show_id\`) gains` with:

```markdown
- `multipart_uploads` (existing, already bound to `show_id`) gains nullable provenance
  columns: `source_ref`, `cut_id`, `cut_start_s`, `cut_end_s`. Audit and retry only. A
  partial unique index on `cut_id` (where the session is not aborted) gives one live
  session per cut, so a retried request reuses it instead of opening a second S3 upload.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-recordings-cut-design.md
git commit -m "docs: amend recordings-cut spec for retention, preview auth and cut ids

The PC cannot observe archival, and <video> cannot send auth headers."
```

---

### Task 1: Domain — segment validation and agenda suggestions

**Files:**
- Create: `packages/domain/src/recording-segments.ts`
- Create: `packages/domain/test/recording-segments.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces:
  - `type Segment = { startS: number; endS: number }`
  - `type SegmentProblem = { index: number; code: 'EMPTY' | 'TOO_SHORT' | 'OUT_OF_RANGE' | 'OVERLAP'; message: string }`
  - `MIN_SEGMENT_SECONDS = 30`
  - `validateSegments(segments: Segment[], durationS: number): SegmentProblem[]`
  - `type AgendaSlot = { showId: string; startMs: number; endMs: number }`
  - `type SegmentSuggestion = { startS: number; endS: number; showId: string }`
  - `suggestSegments(recordingStartMs: number, durationS: number, slots: AgendaSlot[]): SegmentSuggestion[]`
  - `matchShowForSegment(recordingStartMs: number, segment: Segment, slots: AgendaSlot[]): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/test/recording-segments.test.ts
import { describe, it, expect } from 'vitest';
import { validateSegments, suggestSegments, matchShowForSegment, MIN_SEGMENT_SECONDS } from '../src/recording-segments';

describe('validateSegments', () => {
  it('accepts ordered, non-overlapping segments inside the recording', () => {
    expect(validateSegments([{ startS: 0, endS: 3600 }, { startS: 3600, endS: 7200 }], 7200)).toEqual([]);
  });

  it('rejects an empty or reversed segment', () => {
    const problems = validateSegments([{ startS: 100, endS: 100 }, { startS: 500, endS: 400 }], 7200);
    expect(problems.map((p) => [p.index, p.code])).toEqual([[0, 'EMPTY'], [1, 'EMPTY']]);
  });

  it('rejects a segment shorter than the minimum', () => {
    const problems = validateSegments([{ startS: 0, endS: MIN_SEGMENT_SECONDS - 1 }], 7200);
    expect(problems[0].code).toBe('TOO_SHORT');
  });

  it('rejects negative starts and ends past the duration', () => {
    const problems = validateSegments([{ startS: -1, endS: 100 }, { startS: 7000, endS: 7300 }], 7200);
    expect(problems.map((p) => p.code)).toEqual(['OUT_OF_RANGE', 'OUT_OF_RANGE']);
  });

  it('rejects overlap regardless of input order and flags the later segment', () => {
    const problems = validateSegments([{ startS: 1000, endS: 2000 }, { startS: 0, endS: 1500 }], 7200);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 0, code: 'OVERLAP' });
  });

  it('allows segments that touch end-to-start', () => {
    expect(validateSegments([{ startS: 0, endS: 100 }, { startS: 100, endS: 200 }], 7200)).toEqual([]);
  });

  it('rejects a non-finite number', () => {
    expect(validateSegments([{ startS: 0, endS: Number.NaN }], 7200)[0].code).toBe('EMPTY');
  });
});

describe('suggestSegments / matchShowForSegment', () => {
  const t0 = Date.parse('2026-10-01T20:00:00Z');
  const slots = [
    { showId: 'a', startMs: t0, endMs: t0 + 3600_000 },
    { showId: 'b', startMs: t0 + 3600_000, endMs: t0 + 7200_000 },
  ];

  it('turns agenda slots into recording-relative segments', () => {
    expect(suggestSegments(t0, 7200, slots)).toEqual([
      { startS: 0, endS: 3600, showId: 'a' },
      { startS: 3600, endS: 7200, showId: 'b' },
    ]);
  });

  it('clamps a slot that starts before or ends after the recording', () => {
    const early = [{ showId: 'x', startMs: t0 - 600_000, endMs: t0 + 1800_000 }];
    expect(suggestSegments(t0, 3600, early)).toEqual([{ startS: 0, endS: 1800, showId: 'x' }]);
  });

  it('drops slots entirely outside the recording', () => {
    const outside = [{ showId: 'x', startMs: t0 + 9000_000, endMs: t0 + 9900_000 }];
    expect(suggestSegments(t0, 3600, outside)).toEqual([]);
  });

  it('matches a segment to the slot it overlaps most', () => {
    expect(matchShowForSegment(t0, { startS: 3000, endS: 5400 }, slots)).toBe('b');
  });

  it('returns null when nothing overlaps, so bad agenda times never force a match', () => {
    expect(matchShowForSegment(t0, { startS: 20000, endS: 21000 }, slots)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/domain test -- recording-segments`
Expected: FAIL, `Cannot find module '../src/recording-segments'`.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/recording-segments.ts
/**
 * Rules for cutting one recording into per-artist segments. Pure: no I/O.
 *
 * Agenda times only SUGGEST. Real nights run over and under, so a suggestion is a
 * draft marker the operator drags into place, never a decision.
 */

export type Segment = { startS: number; endS: number };

export type SegmentProblem = {
  index: number;
  code: 'EMPTY' | 'TOO_SHORT' | 'OUT_OF_RANGE' | 'OVERLAP';
  message: string;
};

/** Shorter than this is a mis-click, not a set. */
export const MIN_SEGMENT_SECONDS = 30;

export function validateSegments(segments: Segment[], durationS: number): SegmentProblem[] {
  const problems: SegmentProblem[] = [];
  const clean: { index: number; seg: Segment }[] = [];

  segments.forEach((seg, index) => {
    const { startS, endS } = seg;
    if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
      problems.push({ index, code: 'EMPTY', message: 'Segment has no length' });
      return;
    }
    if (startS < 0 || endS > durationS) {
      problems.push({ index, code: 'OUT_OF_RANGE', message: 'Segment is outside the recording' });
      return;
    }
    if (endS - startS < MIN_SEGMENT_SECONDS) {
      problems.push({ index, code: 'TOO_SHORT', message: `Segment is shorter than ${MIN_SEGMENT_SECONDS}s` });
      return;
    }
    clean.push({ index, seg });
  });

  // Overlap is judged in time order but reported against the caller's own index,
  // so the UI can highlight the segment the operator actually dragged.
  const byTime = [...clean].sort((a, b) => a.seg.startS - b.seg.startS);
  for (let i = 1; i < byTime.length; i++) {
    if (byTime[i].seg.startS < byTime[i - 1].seg.endS) {
      problems.push({ index: byTime[i - 1].index, code: 'OVERLAP', message: 'Segments overlap' });
    }
  }
  return problems.sort((a, b) => a.index - b.index);
}

export type AgendaSlot = { showId: string; startMs: number; endMs: number };
export type SegmentSuggestion = Segment & { showId: string };

export function suggestSegments(recordingStartMs: number, durationS: number, slots: AgendaSlot[]): SegmentSuggestion[] {
  const out: SegmentSuggestion[] = [];
  for (const slot of slots) {
    const startS = Math.max(0, (slot.startMs - recordingStartMs) / 1000);
    const endS = Math.min(durationS, (slot.endMs - recordingStartMs) / 1000);
    if (endS > startS) out.push({ startS, endS, showId: slot.showId });
  }
  return out.sort((a, b) => a.startS - b.startS);
}

/** The slot a segment overlaps most, or null — never a forced guess. */
export function matchShowForSegment(recordingStartMs: number, segment: Segment, slots: AgendaSlot[]): string | null {
  let best: { showId: string; overlap: number } | null = null;
  for (const slot of slots) {
    const s = (slot.startMs - recordingStartMs) / 1000;
    const e = (slot.endMs - recordingStartMs) / 1000;
    const overlap = Math.min(segment.endS, e) - Math.max(segment.startS, s);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { showId: slot.showId, overlap };
  }
  return best?.showId ?? null;
}
```

- [ ] **Step 4: Export from the package**

Append to `packages/domain/src/index.ts`:

```ts
export * from './recording-segments';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @show-uploader/domain test`
Expected: all domain tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): segment validation and agenda suggestions"
```

---

### Task 2: Domain — agent contract types

**Files:**
- Create: `packages/domain/src/recordings-contract.ts`
- Create: `packages/domain/test/recordings-contract.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces (used by api, worker and the PC service — copy these names exactly):
  - `type RecordingState = 'preparing' | 'ready' | 'failed'`
  - `type AgentRecording = { ref: string; filename: string; sizeBytes: number; mtimeMs: number; durationS: number | null; state: RecordingState; hasPreview: boolean; recordedAtMs: number }`
  - `type CutState = 'cutting' | 'cut' | 'uploading' | 'done' | 'failed' | 'source_gone'`
  - `type AgentCut = { cutId: string; state: CutState; sizeBytes: number | null; etags: { n: number; etag: string }[] | null; reason: string | null }`
  - `type CutRequest = { cutId: string; ref: string; startS: number; endS: number }`
  - `type UploadRequest = { partSize: number; parts: { n: number; url: string }[] }`
  - `type UnreachableAgent = { reachable: false }`
  - `isTerminalCutState(s: CutState): boolean`
  - `cutFilename(recordingFilename: string, startS: number, endS: number): string`
  - `AGENT_API_PREFIX = '/v1'`
  - `RECORDING_CUTS_QUEUE = 'recording-cuts'`
  - `type CutStep = 'cutting' | 'uploading' | 'finishing'`
  - `type CutJobPayload = { cutId: string; ref: string; filename: string; showId: string; startS: number; endS: number }` — the BullMQ payload the api enqueues and the worker consumes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/recordings-contract.test.ts
import { describe, it, expect } from 'vitest';
import { cutFilename, isTerminalCutState } from '../src/recordings-contract';

describe('isTerminalCutState', () => {
  it('treats done, failed and source_gone as final, the rest as in flight', () => {
    expect(['done', 'failed', 'source_gone'].every((s) => isTerminalCutState(s as never))).toBe(true);
    expect(['cutting', 'cut', 'uploading'].some((s) => isTerminalCutState(s as never))).toBe(false);
  });
});

describe('cutFilename', () => {
  it('keeps the recording identity and adds the in/out so two cuts never collide', () => {
    expect(cutFilename('2026-10-01_20-00-00.mkv', 3600, 7260)).toBe('2026-10-01_20-00-00__1h00m00s-2h01m00s.mp4');
  });

  it('drops any extension and unsafe characters', () => {
    expect(cutFilename('night one.mp4', 0, 90)).toBe('night_one__0h00m00s-0h01m30s.mp4');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/domain test -- recordings-contract`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/recordings-contract.ts
/**
 * The protocol between the uploader (api + worker) and the recordings service on
 * the OBS PC. One copy, imported by all three, so they cannot drift. Types and
 * tiny pure helpers only — no I/O.
 */

export const AGENT_API_PREFIX = '/v1';

export type RecordingState = 'preparing' | 'ready' | 'failed';

export type AgentRecording = {
  /** Opaque and stable once the file is ready. */
  ref: string;
  filename: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Null until ffprobe has run. */
  durationS: number | null;
  state: RecordingState;
  hasPreview: boolean;
  /** When OBS started writing the file, from its filename or birth time. */
  recordedAtMs: number;
};

export type CutState = 'cutting' | 'cut' | 'uploading' | 'done' | 'failed' | 'source_gone';

export type AgentCut = {
  cutId: string;
  state: CutState;
  /** Known once the cut file exists. */
  sizeBytes: number | null;
  /** Present when state is 'done'. */
  etags: { n: number; etag: string }[] | null;
  reason: string | null;
};

export type CutRequest = { cutId: string; ref: string; startS: number; endS: number };

/** The queue the api produces to and the worker consumes. One name, shared, so they cannot drift. */
export const RECORDING_CUTS_QUEUE = 'recording-cuts';

export type CutStep = 'cutting' | 'uploading' | 'finishing';

/** One segment to cut and upload as `showId`'s staged recording. */
export type CutJobPayload = {
  /** Deterministic from (ref, showId, startS, endS); doubles as the BullMQ job id. */
  cutId: string;
  ref: string;
  /** The staged video's filename, already built with `cutFilename`. */
  filename: string;
  showId: string;
  startS: number;
  endS: number;
};

export type UploadRequest = { partSize: number; parts: { n: number; url: string }[] };

/** What the api reports when the PC cannot be reached. A normal state, not an error. */
export type UnreachableAgent = { reachable: false };

export function isTerminalCutState(s: CutState): boolean {
  return s === 'done' || s === 'failed' || s === 'source_gone';
}

const hms = (s: number) => {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
};

/** `<recording>__<in>-<out>.mp4`: the recording's identity plus the cut, filesystem-safe. */
export function cutFilename(recordingFilename: string, startS: number, endS: number): string {
  const dot = recordingFilename.lastIndexOf('.');
  const base = dot > 0 ? recordingFilename.slice(0, dot) : recordingFilename;
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safe}__${hms(startS)}-${hms(endS)}.mp4`;
}
```

- [ ] **Step 4: Export and run**

Append `export * from './recordings-contract';` to `packages/domain/src/index.ts`, then run
`pnpm --filter @show-uploader/domain test` → all PASS. Then `pnpm --filter @show-uploader/domain build` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): recordings agent contract types"
```

### Task 3: PC service scaffold and config

Replaces the undeployed `watcher/` (single-PUT upload, no retry) with the recordings service. Nothing in the repo imports it, so this is a clean swap.

**Files:**
- Modify: `watcher/package.json`, `watcher/tsconfig.json` (unchanged content kept), `pnpm-lock.yaml`
- Replace: `watcher/src/index.ts`
- Create: `watcher/src/config.ts`, `watcher/test/config.test.ts`

**Interfaces:**
- Produces:
  - `type Config = { recordingsDir: string; workDir: string; token: string; listenHost: string; listenPort: number; tools: { ffmpeg: string; ffprobe: string }; stableWindowMs: number; scanIntervalMs: number; retentionDays: number; mixAudioStream: number }`
  - `loadConfig(env?: NodeJS.ProcessEnv): Config` (throws a readable zod error)

- [ ] **Step 1: Write the failing test**

```ts
// watcher/test/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const base = { RECORDINGS_DIR: 'C:/Users/koray/Videos/OBS recordings', AGENT_TOKEN: 'x'.repeat(24) };

describe('loadConfig', () => {
  it('applies safe defaults: loopback only, track 1 is the mix', () => {
    const c = loadConfig(base);
    expect(c.listenHost).toBe('127.0.0.1');
    expect(c.listenPort).toBe(8787);
    expect(c.mixAudioStream).toBe(0);
    expect(c.retentionDays).toBe(14);
    expect(c.tools).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  });

  it('keeps derived files in a hidden folder inside the recordings folder by default', () => {
    expect(loadConfig(base).workDir.replace(/\\/g, '/')).toBe('C:/Users/koray/Videos/OBS recordings/.show-uploader');
  });

  it('refuses a missing or short token, because the service serves video', () => {
    expect(() => loadConfig({ RECORDINGS_DIR: 'x' })).toThrow();
    expect(() => loadConfig({ ...base, AGENT_TOKEN: 'short' })).toThrow(/16/);
  });
});
```

- [ ] **Step 2: Rewrite `watcher/package.json`, install, run the test to see it fail**

```json
{
  "name": "@show-uploader/watcher",
  "version": "2.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "pnpm --filter @show-uploader/domain build && tsc",
    "dev": "pnpm --filter @show-uploader/domain build && tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "pnpm --filter @show-uploader/domain build && vitest run"
  },
  "dependencies": {
    "@show-uploader/domain": "workspace:*",
    "dotenv": "^16.6.1",
    "express": "^4.22.2",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^4.17.25",
    "@types/node": "^20.19.43",
    "tsx": "^4.23.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.10"
  }
}
```

Run: `pnpm install && pnpm --filter @show-uploader/watcher test`
Expected: FAIL, `Cannot find module '../src/config'`.

- [ ] **Step 3: Implement config and a boot stub**

```ts
// watcher/src/config.ts
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  RECORDINGS_DIR: z.string().min(1),
  // Derived files (MP4, preview, peaks, sidecars, cut staging). Default: a hidden
  // folder next to the recordings so the OBS folder itself stays as OBS left it.
  WORK_DIR: z.string().min(1).optional(),
  AGENT_TOKEN: z.string().min(16, 'AGENT_TOKEN must be at least 16 characters'),
  // Loopback by default. In production set this to the PC's Tailscale IP so the
  // service is reachable over the tailnet and nowhere else.
  LISTEN_HOST: z.string().default('127.0.0.1'),
  LISTEN_PORT: z.coerce.number().int().positive().default(8787),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  // A file whose mtime is this old has stopped growing, so OBS is done with it.
  STABLE_WINDOW_MS: z.coerce.number().int().positive().default(20_000),
  SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RETENTION_DAYS: z.coerce.number().positive().default(14),
  // Index among the file's AUDIO streams that holds the mix. OBS records tracks
  // 1, 3 and 4, which appear in that order, so track 1 is stream 0.
  MIX_AUDIO_STREAM: z.coerce.number().int().min(0).default(0),
});

export type Config = {
  recordingsDir: string;
  workDir: string;
  token: string;
  listenHost: string;
  listenPort: number;
  tools: { ffmpeg: string; ffprobe: string };
  stableWindowMs: number;
  scanIntervalMs: number;
  retentionDays: number;
  mixAudioStream: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  return {
    recordingsDir: e.RECORDINGS_DIR,
    workDir: e.WORK_DIR ?? path.join(e.RECORDINGS_DIR, '.show-uploader'),
    token: e.AGENT_TOKEN,
    listenHost: e.LISTEN_HOST,
    listenPort: e.LISTEN_PORT,
    tools: { ffmpeg: e.FFMPEG_PATH, ffprobe: e.FFPROBE_PATH },
    stableWindowMs: e.STABLE_WINDOW_MS,
    scanIntervalMs: e.SCAN_INTERVAL_MS,
    retentionDays: e.RETENTION_DAYS,
    mixAudioStream: e.MIX_AUDIO_STREAM,
  };
}
```

```ts
// watcher/src/index.ts — replaced in Task 9; a stub keeps `build` green until then.
import 'dotenv/config';
import { loadConfig } from './config';

const config = loadConfig();
console.log(`recordings service configured for ${config.recordingsDir}`);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @show-uploader/watcher test && pnpm --filter @show-uploader/watcher exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add watcher pnpm-lock.yaml
git commit -m "feat(watcher): recordings service scaffold and config

Replaces the undeployed single-PUT watcher. Loopback by default."
```

---

### Task 4: ffmpeg wrappers and the lossless cut

This task pins Review Focus 3 and the spec's first verification item (cut end accuracy) with a real ffmpeg.

**Files:**
- Create: `watcher/src/ffmpeg.ts`, `watcher/test/fixtures.ts`, `watcher/test/ffmpeg.test.ts`

**Interfaces:**
- Produces:
  - `type Tools = { ffmpeg: string; ffprobe: string }`
  - `type ProbeResult = { durationS: number; videoCodec: string | null; audioStreams: number }`
  - `buildRemuxArgs(o: { input: string; output: string; audioStream: number; videoCodec: string | null }): string[]`
  - `buildCutArgs(o: { input: string; output: string; startS: number; endS: number; audioStream: number; videoCodec: string | null }): string[]`
  - `buildPreviewArgs(o: { input: string; output: string; audioStream: number }): string[]`
  - `buildPeaksArgs(o: { input: string; audioStream: number; rate: number }): string[]`
  - `class PeakAccumulator { constructor(samplesPerBucket: number); push(chunk: Buffer): void; finish(): number[] }`
  - `runFfmpeg(bin: string, args: string[]): Promise<void>` (below-normal priority)
  - `probe(tools: Tools, file: string): Promise<ProbeResult>`
  - `computePeaks(tools: Tools, file: string, audioStream: number): Promise<number[]>` (1 value per second, 0..1)

- [ ] **Step 1: Write the fixture helper and the failing tests**

```ts
// watcher/test/fixtures.ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A 12 s MKV shaped like what OBS writes here: three AAC tracks (the mix first),
 * keyframes every 2 s. Track 1 is the only mono / 44.1 kHz one so a test can tell
 * it apart from tracks 3 and 4 by stream properties alone.
 */
export function makeFixture(dir: string): string {
  const out = path.join(dir, 'night.mkv');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=1320:sample_rate=48000',
      '-t', '12',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
      '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac:a:0', '1', '-ac:a:1', '2', '-ac:a:2', '2',
      out,
    ],
    { stdio: 'ignore' }
  );
  return out;
}

export function ffprobeStreams(file: string): { codec_type: string; channels?: number; sample_rate?: string }[] {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,channels,sample_rate', '-of', 'json', file],
    { encoding: 'utf8' }
  );
  return JSON.parse(raw).streams;
}
```

```ts
// watcher/test/ffmpeg.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PeakAccumulator, buildCutArgs, buildPeaksArgs, buildPreviewArgs, buildRemuxArgs, computePeaks, probe, runFfmpeg,
} from '../src/ffmpeg';
import { ffprobeStreams, hasFfmpeg, makeFixture } from './fixtures';

describe('argument builders', () => {
  it('maps video and exactly one audio stream, never ffmpeg\'s own pick', () => {
    const args = buildRemuxArgs({ input: 'a.mkv', output: 'a.mp4', audioStream: 0, videoCodec: 'h264' });
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '0:a:0', '-c', 'copy']));
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
  });

  it('tags HEVC as hvc1 so QuickTime and Safari accept it, and leaves H.264 alone', () => {
    expect(buildRemuxArgs({ input: 'a', output: 'b', audioStream: 0, videoCodec: 'hevc' })).toContain('hvc1');
    expect(buildRemuxArgs({ input: 'a', output: 'b', audioStream: 0, videoCodec: 'h264' })).not.toContain('hvc1');
  });

  it('puts -ss and -t BEFORE -i, so the start is exact (edit list) and the end counts from the in-point', () => {
    const args = buildCutArgs({ input: 'in.mp4', output: 'out.mp4', startS: 3, endS: 7, audioStream: 0, videoCodec: 'h264' });
    const i = args.indexOf('-i');
    expect(args.indexOf('-ss')).toBeLessThan(i);
    expect(args.indexOf('-t')).toBeLessThan(i);
    expect(args[args.indexOf('-ss') + 1]).toBe('3.000');
    expect(args[args.indexOf('-t') + 1]).toBe('4.000');
  });

  it('makes a small H.264 preview and a mono s16 stream for peaks', () => {
    expect(buildPreviewArgs({ input: 'a', output: 'b', audioStream: 0 })).toEqual(expect.arrayContaining(['libx264', 'scale=-2:480']));
    expect(buildPeaksArgs({ input: 'a', audioStream: 0, rate: 4000 })).toEqual(expect.arrayContaining(['s16le', '4000', '-']));
  });
});

describe('PeakAccumulator', () => {
  const s16 = (...v: number[]) => Buffer.from(Int16Array.from(v).buffer);

  it('reports the loudest absolute sample per bucket, normalised to 0..1', () => {
    const acc = new PeakAccumulator(2);
    acc.push(s16(100, -16384, 0, 8192));
    expect(acc.finish()).toEqual([0.5, 0.25]);
  });

  it('copes with chunks that split a sample or a bucket', () => {
    const acc = new PeakAccumulator(2);
    const whole = s16(100, -16384, 0, 8192);
    acc.push(whole.subarray(0, 3));
    acc.push(whole.subarray(3));
    expect(acc.finish()).toEqual([0.5, 0.25]);
  });

  it('flushes a partial last bucket', () => {
    const acc = new PeakAccumulator(4);
    acc.push(s16(0, 32767));
    expect(acc.finish()).toEqual([1]);
  });
});

describe.skipIf(!hasFfmpeg())('real ffmpeg', () => {
  const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  let dir: string;
  let mkv: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-ffmpeg-'));
    mkv = makeFixture(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('probe reads duration, codec and audio stream count', async () => {
    const p = await probe(tools, mkv);
    expect(p.durationS).toBeGreaterThan(11.5);
    expect(p.videoCodec).toBe('h264');
    expect(p.audioStreams).toBe(3);
  });

  it('remux keeps exactly one audio stream and it is track 1 (the mono 44.1 kHz one)', async () => {
    const out = path.join(dir, 'full.mp4');
    await runFfmpeg(tools.ffmpeg, buildRemuxArgs({ input: mkv, output: out, audioStream: 0, videoCodec: 'h264' }));
    const audio = ffprobeStreams(out).filter((s) => s.codec_type === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0].channels).toBe(1);
    expect(audio[0].sample_rate).toBe('44100');
  });

  // Keyframes are every 2 s, so a start of 3 s is mid-GOP. Without the edit list the
  // clip would run ~5 s (keyframe at 2 s). Equal-to-request proves start AND end are
  // exact. If this fails, the end is short or the start is not trimmed: STOP and report
  // it as a design finding (spec verification item 1) instead of loosening the bounds.
  it('a mid-GOP cut lasts what was asked, so the start is exact and the end is not short', async () => {
    const out = path.join(dir, 'cut.mp4');
    await runFfmpeg(tools.ffmpeg, buildCutArgs({ input: mkv, output: out, startS: 3, endS: 7, audioStream: 0, videoCodec: 'h264' }));
    const { durationS, audioStreams } = await probe(tools, out);
    expect(audioStreams).toBe(1);
    expect(durationS).toBeGreaterThan(3.85);
    expect(durationS).toBeLessThan(4.15);
  });

  it('computes about one peak per second', async () => {
    const peaks = await computePeaks(tools, mkv, 0);
    expect(peaks.length).toBeGreaterThanOrEqual(11);
    expect(peaks.length).toBeLessThanOrEqual(13);
    expect(Math.max(...peaks)).toBeGreaterThan(0.1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- ffmpeg`
Expected: FAIL, `Cannot find module '../src/ffmpeg'`.

- [ ] **Step 3: Implement**

```ts
// watcher/src/ffmpeg.ts
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Tools = { ffmpeg: string; ffprobe: string };
export type ProbeResult = { durationS: number; videoCodec: string | null; audioStreams: number };

const COMMON = ['-hide_banner', '-nostdin', '-y'];

// QuickTime/Safari only open HEVC in MP4 when it is tagged hvc1; ffmpeg's default
// hev1 plays nowhere on Apple devices.
const tagFor = (videoCodec: string | null) => (videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []);

const secs = (n: number) => n.toFixed(3);

// OBS records three audio tracks. Without an explicit -map ffmpeg keeps one audio
// stream of its own choosing, so every command here names the stream it wants.
export function buildRemuxArgs(o: { input: string; output: string; audioStream: number; videoCodec: string | null }): string[] {
  return [
    ...COMMON, '-i', o.input,
    '-map', '0:v:0', '-map', `0:a:${o.audioStream}`,
    '-c', 'copy', ...tagFor(o.videoCodec),
    '-movflags', '+faststart', o.output,
  ];
}

/**
 * Lossless cut. -ss before -i seeks to the keyframe before the in-point and makes
 * the MP4 muxer write an edit list, so playback still begins exactly at the
 * in-point. -t as an INPUT option counts from the in-point (not from that keyframe),
 * so the end is exact too. The same technique as the Coming Soon Clipper, plus the
 * stream mapping the clipper does not need.
 */
export function buildCutArgs(o: {
  input: string; output: string; startS: number; endS: number; audioStream: number; videoCodec: string | null;
}): string[] {
  return [
    ...COMMON,
    '-ss', secs(o.startS), '-t', secs(o.endS - o.startS), '-i', o.input,
    '-map', '0:v:0', '-map', `0:a:${o.audioStream}`,
    '-c', 'copy', ...tagFor(o.videoCodec),
    '-movflags', '+faststart', o.output,
  ];
}

// Small H.264 for the editor: the full file is HEVC, which most browsers cannot play.
export function buildPreviewArgs(o: { input: string; output: string; audioStream: number }): string[] {
  return [
    ...COMMON, '-i', o.input,
    '-map', '0:v:0', '-map', `0:a:${o.audioStream}`,
    '-vf', 'scale=-2:480',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '50', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-movflags', '+faststart', o.output,
  ];
}

export function buildPeaksArgs(o: { input: string; audioStream: number; rate: number }): string[] {
  return [
    ...COMMON, '-i', o.input,
    '-map', `0:a:${o.audioStream}`, '-ac', '1', '-ar', String(o.rate), '-f', 's16le', '-',
  ];
}

/** Loudest absolute sample per bucket, streamed so a 4 h recording never sits in memory. */
export class PeakAccumulator {
  private peaks: number[] = [];
  private max = 0;
  private count = 0;
  private carry: Buffer | null = null;

  constructor(private readonly samplesPerBucket: number) {}

  push(chunk: Buffer): void {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    this.carry = usable < buf.length ? buf.subarray(usable) : null;
    buf = buf.subarray(0, usable);
    for (let i = 0; i < buf.length; i += 2) {
      const v = Math.abs(buf.readInt16LE(i));
      if (v > this.max) this.max = v;
      if (++this.count === this.samplesPerBucket) this.flush();
    }
  }

  finish(): number[] {
    if (this.count > 0) this.flush();
    return this.peaks;
  }

  private flush(): void {
    this.peaks.push(Math.round((this.max / 32768) * 1000) / 1000);
    this.max = 0;
    this.count = 0;
  }
}

/** Runs ffmpeg below normal priority: OBS must always win the CPU. */
export function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Best effort: lowering priority must never fail the job.
    }
    let tail = '';
    child.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${tail}`))));
  });
}

export async function probe(tools: Tools, file: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    tools.ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  );
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string }[];
  };
  const durationS = Number(json.format?.duration);
  if (!Number.isFinite(durationS)) throw new Error('ffprobe returned no duration');
  const streams = json.streams ?? [];
  return {
    durationS,
    videoCodec: streams.find((s) => s.codec_type === 'video')?.codec_name ?? null,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
  };
}

const PEAK_RATE = 4000; // Hz of the analysis stream; one peak per second.

export function computePeaks(tools: Tools, file: string, audioStream: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, buildPeaksArgs({ input: file, audioStream, rate: PEAK_RATE }), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Best effort.
    }
    const acc = new PeakAccumulator(PEAK_RATE);
    let tail = '';
    child.stdout.on('data', (d: Buffer) => acc.push(d));
    child.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(acc.finish()) : reject(new Error(`peaks failed (${code}): ${tail}`))));
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/watcher test -- ffmpeg`
Expected: PASS (the `real ffmpeg` block is skipped only when ffmpeg is not installed; on a dev machine it must run and pass).

- [ ] **Step 5: Commit**

```bash
git add watcher
git commit -m "feat(watcher): lossless cut, remux, preview and peaks via ffmpeg

Maps track 1 explicitly; tags HEVC hvc1; mid-GOP cut verified against real ffmpeg."
```

---

### Task 5: Recording library — scan, refs, sidecars

Pins Review Focus 2: while any file is still growing, the service reports a recording as active.

**Files:**
- Create: `watcher/src/library.ts`, `watcher/test/library.test.ts`

**Interfaces:**
- Produces:
  - `type Original = { ref: string; filename: string; path: string; sizeBytes: number; mtimeMs: number; birthMs: number }`
  - `type Sidecar = { ref: string; filename: string; originalPath: string; recordedAtMs: number; sizeBytes: number; mtimeMs: number; state: RecordingState; error: string | null; durationS: number | null; videoCodec: string | null; hasMaster: boolean; hasPreview: boolean; hasPeaks: boolean; cuts: { cutId: string; uploadedAtMs: number }[] }`
  - `type WorkPaths = { dir: string; master: string; preview: string; peaks: string; state: string }`
  - `recordingRef(filename: string, sizeBytes: number, mtimeMs: number): string`
  - `parseRecordedAt(filename: string, fallbackMs: number): number`
  - `class Library { constructor(o: { recordingsDir: string; workDir: string; stableWindowMs: number }); paths(ref: string): WorkPaths; sync(nowMs: number): { recordingActive: boolean }; list(): Sidecar[]; get(ref: string): Sidecar | null; save(s: Sidecar): void; sourceFor(ref: string): string | null; recordUpload(ref: string, cutId: string, atMs: number): void; remove(ref: string): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// watcher/test/library.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library, parseRecordedAt, recordingRef } from '../src/library';

let root: string;
let lib: Library;
const NOW = 1_800_000_000_000;

const touch = (name: string, ageMs: number, content = 'x') => {
  const p = path.join(root, name);
  fs.writeFileSync(p, content);
  const t = new Date(NOW - ageMs);
  fs.utimesSync(p, t, t);
  return p;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-lib-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.show-uploader'), stableWindowMs: 20_000 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('refs and names', () => {
  it('derives a stable ref from name, size and mtime', () => {
    expect(recordingRef('a.mkv', 10, 5)).toBe(recordingRef('a.mkv', 10, 5));
    expect(recordingRef('a.mkv', 10, 5)).not.toBe(recordingRef('a.mkv', 11, 5));
  });

  it('reads OBS\'s timestamp from both filename styles, falling back to the birth time', () => {
    const local = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).getTime();
    expect(parseRecordedAt('2026-10-01 20-05-09.mkv', 0)).toBe(local(2026, 10, 1, 20, 5, 9));
    expect(parseRecordedAt('2026-10-01_20-05-09.mkv', 0)).toBe(local(2026, 10, 1, 20, 5, 9));
    expect(parseRecordedAt('mystery.mkv', 42)).toBe(42);
  });
});

describe('sync', () => {
  it('registers files that stopped growing as preparing, and ignores other file types and the work folder', () => {
    touch('night.mkv', 60_000);
    touch('notes.txt', 60_000);
    lib.sync(NOW);
    const list = lib.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ filename: 'night.mkv', state: 'preparing' });
  });

  it('reports a recording as active while a file is still growing, and does not register it yet', () => {
    touch('live.mkv', 1_000);
    expect(lib.sync(NOW)).toEqual({ recordingActive: true });
    expect(lib.list()).toEqual([]);
  });

  it('is idempotent: a second sync does not duplicate or reset state', () => {
    touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    lib.save({ ...s, state: 'ready', durationS: 100 });
    lib.sync(NOW + 10_000);
    expect(lib.list()).toHaveLength(1);
    expect(lib.list()[0].state).toBe('ready');
  });

  it('a missing recordings folder is an empty library, not an error', () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(() => lib.sync(NOW)).not.toThrow();
    expect(lib.list()).toEqual([]);
  });
});

describe('deleting files by hand', () => {
  it('drops a recording whose original and master are both gone', () => {
    const p = touch('night.mkv', 60_000);
    lib.sync(NOW);
    fs.rmSync(p);
    lib.sync(NOW + 10_000);
    expect(lib.list()).toEqual([]);
  });

  it('keeps a recording whose MKV was deleted but whose MP4 master survives, and cuts from the MP4', () => {
    const p = touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    fs.mkdirSync(lib.paths(s.ref).dir, { recursive: true });
    fs.writeFileSync(lib.paths(s.ref).master, 'mp4');
    lib.save({ ...s, hasMaster: true, state: 'ready' });
    fs.rmSync(p);
    lib.sync(NOW + 10_000);
    expect(lib.list()).toHaveLength(1);
    expect(lib.sourceFor(s.ref)).toBe(lib.paths(s.ref).master);
  });

  it('sourceFor is null once nothing is left, so a cut fails as source_gone', () => {
    const p = touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    fs.rmSync(p);
    expect(lib.sourceFor(s.ref)).toBeNull();
  });
});

describe('upload ledger', () => {
  it('records a finished cut upload on the sidecar so retention can use it', () => {
    touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    lib.recordUpload(s.ref, 'cut-1', NOW);
    expect(lib.get(s.ref)?.cuts).toEqual([{ cutId: 'cut-1', uploadedAtMs: NOW }]);
  });

  it('recording the same cut twice does not duplicate it', () => {
    touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    lib.recordUpload(s.ref, 'cut-1', NOW);
    lib.recordUpload(s.ref, 'cut-1', NOW + 5);
    expect(lib.get(s.ref)?.cuts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- library`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// watcher/src/library.ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RecordingState } from '@show-uploader/domain';

/**
 * The recordings on disk, as the service sees them. The folder is the source of
 * truth: there is no database. A recording is whatever file OBS left behind, plus
 * a disposable sidecar of derived state. The operator may delete the MKV or the
 * derived MP4 at any time, and nothing here treats that as an error.
 */

const VIDEO_EXT = new Set(['.mkv', '.mp4']);

export type Original = {
  ref: string;
  filename: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  birthMs: number;
};

export type Sidecar = {
  ref: string;
  filename: string;
  originalPath: string;
  recordedAtMs: number;
  sizeBytes: number;
  mtimeMs: number;
  state: RecordingState;
  error: string | null;
  durationS: number | null;
  videoCodec: string | null;
  hasMaster: boolean;
  hasPreview: boolean;
  hasPeaks: boolean;
  cuts: { cutId: string; uploadedAtMs: number }[];
};

export type WorkPaths = { dir: string; master: string; preview: string; peaks: string; state: string };

export function recordingRef(filename: string, sizeBytes: number, mtimeMs: number): string {
  return createHash('sha1').update(`${filename}\0${sizeBytes}\0${Math.floor(mtimeMs)}`).digest('hex').slice(0, 16);
}

/**
 * OBS names files "2026-10-01 20-05-09" or, with "Generate file name without space",
 * "2026-10-01_20-05-09", in the PC's local time. That is when recording started.
 */
export function parseRecordedAt(filename: string, fallbackMs: number): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/.exec(filename);
  if (!m) return fallbackMs;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export class Library {
  constructor(private readonly o: { recordingsDir: string; workDir: string; stableWindowMs: number }) {}

  paths(ref: string): WorkPaths {
    const dir = path.join(this.o.workDir, 'recordings', ref);
    return {
      dir,
      master: path.join(dir, 'master.mp4'),
      preview: path.join(dir, 'preview.mp4'),
      peaks: path.join(dir, 'peaks.json'),
      state: path.join(dir, 'state.json'),
    };
  }

  /** Scan the folder, register new stable files, forget recordings with nothing left on disk. */
  sync(nowMs: number): { recordingActive: boolean } {
    const { ready, growing } = this.scan(nowMs);
    const known = new Set(this.list().map((s) => s.ref));

    for (const o of ready) {
      if (known.has(o.ref)) continue;
      this.save({
        ref: o.ref,
        filename: o.filename,
        originalPath: o.path,
        recordedAtMs: parseRecordedAt(o.filename, o.birthMs),
        sizeBytes: o.sizeBytes,
        mtimeMs: o.mtimeMs,
        state: 'preparing',
        error: null,
        durationS: null,
        videoCodec: null,
        hasMaster: false,
        hasPreview: false,
        hasPeaks: false,
        cuts: [],
      });
    }

    for (const s of this.list()) {
      if (!fs.existsSync(s.originalPath) && !fs.existsSync(this.paths(s.ref).master)) this.remove(s.ref);
    }
    return { recordingActive: growing.length > 0 };
  }

  list(): Sidecar[] {
    const root = path.join(this.o.workDir, 'recordings');
    let refs: string[];
    try {
      refs = fs.readdirSync(root);
    } catch {
      return [];
    }
    const out: Sidecar[] = [];
    for (const ref of refs) {
      const s = this.get(ref);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.recordedAtMs - a.recordedAtMs);
  }

  get(ref: string): Sidecar | null {
    try {
      return JSON.parse(fs.readFileSync(this.paths(ref).state, 'utf8')) as Sidecar;
    } catch {
      return null;
    }
  }

  save(s: Sidecar): void {
    const p = this.paths(s.ref);
    fs.mkdirSync(p.dir, { recursive: true });
    // Write-then-rename so a crash never leaves a half-written sidecar.
    const tmp = `${p.state}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p.state);
  }

  /** The file a cut reads: the MP4 master if there is one, else the original, else nothing. */
  sourceFor(ref: string): string | null {
    const s = this.get(ref);
    if (!s) return null;
    const master = this.paths(ref).master;
    if (s.hasMaster && fs.existsSync(master)) return master;
    return fs.existsSync(s.originalPath) ? s.originalPath : null;
  }

  recordUpload(ref: string, cutId: string, atMs: number): void {
    const s = this.get(ref);
    if (!s || s.cuts.some((c) => c.cutId === cutId)) return;
    this.save({ ...s, cuts: [...s.cuts, { cutId, uploadedAtMs: atMs }] });
  }

  remove(ref: string): void {
    fs.rmSync(this.paths(ref).dir, { recursive: true, force: true });
  }

  private scan(nowMs: number): { ready: Original[]; growing: Original[] } {
    const ready: Original[] = [];
    const growing: Original[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.o.recordingsDir);
    } catch {
      return { ready, growing };
    }
    for (const filename of names) {
      if (filename.startsWith('.')) continue;
      if (!VIDEO_EXT.has(path.extname(filename).toLowerCase())) continue;
      const full = path.join(this.o.recordingsDir, filename);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (!st.isFile()) continue;
      const o: Original = {
        ref: recordingRef(filename, st.size, st.mtimeMs),
        filename,
        path: full,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        birthMs: st.birthtimeMs || st.mtimeMs,
      };
      (nowMs - st.mtimeMs >= this.o.stableWindowMs ? ready : growing).push(o);
    }
    return { ready, growing };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/watcher test && pnpm --filter @show-uploader/watcher exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add watcher
git commit -m "feat(watcher): recording library with disposable sidecars

The folder is the source of truth; hand-deleted files are never an error."
```

### Task 6: Prepare a recording (remux, verify, preview, peaks)

**Files:**
- Create: `watcher/src/prepare.ts`, `watcher/test/prepare.test.ts`

**Interfaces:**
- Consumes: `Library`, `Sidecar` (Task 5); `ProbeResult` (Task 4).
- Produces:
  - `type Media = { probe(file: string): Promise<ProbeResult>; remux(o: { input: string; output: string; audioStream: number; videoCodec: string | null }): Promise<void>; preview(o: { input: string; output: string; audioStream: number }): Promise<void>; peaks(file: string, audioStream: number): Promise<number[]> }`
  - `prepareRecording(deps: { library: Library; media: Media; mixAudioStream: number }, ref: string): Promise<Sidecar | null>` — never throws for a media failure; the sidecar ends `failed` with `error`. Idempotent: finished stages are skipped, so a crash resumes.

- [ ] **Step 1: Write the failing tests**

```ts
// watcher/test/prepare.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Library } from '../src/library';
import { prepareRecording, type Media } from '../src/prepare';

let root: string;
let lib: Library;
const NOW = 1_800_000_000_000;

function register(name: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, 'src');
  const t = new Date(NOW - 60_000);
  fs.utimesSync(p, t, t);
  lib.sync(NOW);
  return lib.list()[0].ref;
}

function fakeMedia(over: Partial<Media> = {}): Media {
  return {
    probe: vi.fn(async (f: string) =>
      f.endsWith('master.part.mp4')
        ? { durationS: 100, videoCodec: 'hevc', audioStreams: 1 }
        : { durationS: 100, videoCodec: 'hevc', audioStreams: 3 }
    ),
    remux: vi.fn(async (o) => void fs.writeFileSync(o.output, 'mp4')),
    preview: vi.fn(async (o) => void fs.writeFileSync(o.output, 'prev')),
    peaks: vi.fn(async () => [0.1, 0.5]),
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-prep-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.show-uploader'), stableWindowMs: 20_000 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('prepareRecording', () => {
  it('remuxes an MKV to a verified master, makes preview and peaks, and ends ready', async () => {
    const ref = register('night.mkv');
    const media = fakeMedia();

    const s = await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);

    expect(s).toMatchObject({ state: 'ready', hasMaster: true, hasPreview: true, hasPeaks: true, durationS: 100, videoCodec: 'hevc' });
    expect(fs.existsSync(lib.paths(ref).master)).toBe(true);
    expect(fs.existsSync(path.join(lib.paths(ref).dir, 'master.part.mp4'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(lib.paths(ref).peaks, 'utf8'))).toEqual([0.1, 0.5]);
    expect(media.remux).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 0, videoCodec: 'hevc' }));
  });

  it('previews from the master, whose single audio stream is index 0, whatever the mix track index is', async () => {
    const ref = register('night.mkv');
    const media = fakeMedia();
    await prepareRecording({ library: lib, media, mixAudioStream: 2 }, ref);
    expect(media.remux).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 2 }));
    expect(media.preview).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 0 }));
  });

  it('a remux whose duration drifts is rejected and leaves no master behind', async () => {
    const ref = register('night.mkv');
    const media = fakeMedia({
      probe: vi.fn(async (f: string) =>
        f.endsWith('master.part.mp4')
          ? { durationS: 60, videoCodec: 'hevc', audioStreams: 1 }
          : { durationS: 100, videoCodec: 'hevc', audioStreams: 3 }
      ),
    });

    const s = await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);

    expect(s?.state).toBe('failed');
    expect(s?.error).toMatch(/verification/i);
    expect(fs.existsSync(lib.paths(ref).master)).toBe(false);
    expect(media.preview).not.toHaveBeenCalled();
  });

  it('a master with more than one audio stream is rejected: track 1 only', async () => {
    const ref = register('night.mkv');
    const media = fakeMedia({ probe: vi.fn(async () => ({ durationS: 100, videoCodec: 'hevc', audioStreams: 3 })) });
    const s = await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    expect(s?.state).toBe('failed');
  });

  it('resumes: stages already finished are not repeated', async () => {
    const ref = register('night.mkv');
    const media = fakeMedia();
    await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    expect(media.remux).toHaveBeenCalledTimes(1);
    expect(media.preview).toHaveBeenCalledTimes(1);
    expect(media.peaks).toHaveBeenCalledTimes(1);
  });

  it('an MP4 original needs no remux and is used as-is', async () => {
    const ref = register('night.mp4');
    const media = fakeMedia({ probe: vi.fn(async () => ({ durationS: 100, videoCodec: 'h264', audioStreams: 3 })) });
    const s = await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    expect(s).toMatchObject({ state: 'ready', hasMaster: false, hasPreview: true });
    expect(media.remux).not.toHaveBeenCalled();
    expect(media.preview).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 0 }));
  });

  it('a recording deleted before the work starts is left alone, not marked failed', async () => {
    const ref = register('night.mkv');
    fs.rmSync(path.join(root, 'night.mkv'));
    const media = fakeMedia();
    const s = await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    expect(s?.state).toBe('preparing');
    expect(media.probe).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- prepare`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// watcher/src/prepare.ts
import fs from 'node:fs';
import path from 'node:path';
import type { ProbeResult } from './ffmpeg';
import type { Library, Sidecar } from './library';

/** What preparing needs from ffmpeg. A seam so the state machine tests without a binary. */
export type Media = {
  probe(file: string): Promise<ProbeResult>;
  remux(o: { input: string; output: string; audioStream: number; videoCodec: string | null }): Promise<void>;
  preview(o: { input: string; output: string; audioStream: number }): Promise<void>;
  peaks(file: string, audioStream: number): Promise<number[]>;
};

// A frame at 25 fps is 0.04 s; a remux that drifts further than this lost something.
const DURATION_TOLERANCE_S = 0.25;

/**
 * Make one recording usable by the editor: a verified MP4 master (MKV only), a small
 * H.264 preview, and waveform peaks. Each stage writes to a `.part` file and renames
 * once it is whole, and each is skipped when its flag is set, so a crash or restart
 * resumes where it stopped. A media failure never throws: the sidecar ends `failed`
 * with the reason, so one bad file cannot stall the others.
 */
export async function prepareRecording(
  deps: { library: Library; media: Media; mixAudioStream: number },
  ref: string
): Promise<Sidecar | null> {
  const { library, media, mixAudioStream } = deps;
  const initial = library.get(ref);
  if (!initial) return null;
  let s: Sidecar = initial;
  const p = library.paths(ref);

  const first = library.sourceFor(ref);
  if (!first) return s; // deleted meanwhile; the next sync forgets it

  const save = (patch: Partial<Sidecar>) => {
    s = { ...s, ...patch };
    library.save(s);
  };

  try {
    if (s.durationS === null || s.videoCodec === null) {
      const info = await media.probe(first);
      save({ durationS: info.durationS, videoCodec: info.videoCodec });
    }

    const isMp4 = path.extname(s.originalPath).toLowerCase() === '.mp4';
    if (!isMp4 && !s.hasMaster) {
      const part = path.join(p.dir, 'master.part.mp4');
      await media.remux({ input: s.originalPath, output: part, audioStream: mixAudioStream, videoCodec: s.videoCodec });
      const check = await media.probe(part);
      if (Math.abs(check.durationS - (s.durationS ?? 0)) > DURATION_TOLERANCE_S || check.audioStreams !== 1) {
        fs.rmSync(part, { force: true });
        throw new Error(
          `Remux verification failed (${check.durationS}s vs ${s.durationS}s, ${check.audioStreams} audio streams)`
        );
      }
      fs.renameSync(part, p.master);
      save({ hasMaster: true });
    }

    const playable = library.sourceFor(ref);
    if (!playable) return s;
    // The master carries exactly one audio stream; an original MP4 still has all tracks.
    const audioStream = s.hasMaster ? 0 : isMp4 ? mixAudioStream : 0;

    if (!s.hasPreview) {
      const part = path.join(p.dir, 'preview.part.mp4');
      await media.preview({ input: playable, output: part, audioStream });
      fs.renameSync(part, p.preview);
      save({ hasPreview: true });
    }

    if (!s.hasPeaks) {
      fs.writeFileSync(p.peaks, JSON.stringify(await media.peaks(playable, audioStream)));
      save({ hasPeaks: true });
    }

    save({ state: 'ready', error: null });
  } catch (err) {
    save({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
  return s;
}
```

Note for the implementer: the "an MP4 original" test expects the preview to use audio stream `0`, because `mixAudioStream` is `0` there; the `isMp4 ? mixAudioStream : 0` branch is what makes a multi-track MP4 original pick the mix.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/watcher test -- prepare && pnpm --filter @show-uploader/watcher exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add watcher
git commit -m "feat(watcher): prepare recordings with verified remux, preview and peaks"
```

---

### Task 7: Cut manager — cut, stage, upload parts, resume

Pins Review Focus 1 (`source_gone`), 4 (idempotent `cutId`) and 5 (no re-sent parts).

**Files:**
- Create: `watcher/src/cuts.ts`, `watcher/test/cuts.test.ts`

**Interfaces:**
- Consumes: `Library` (`get`, `sourceFor`, `recordUpload`); `AgentCut`, `CutRequest`, `UploadRequest` from `@show-uploader/domain`.
- Produces:
  - `type CutDeps = { library: Pick<Library, 'get' | 'sourceFor' | 'recordUpload'>; cutFile(o: { input: string; output: string; startS: number; endS: number; audioStream: number; videoCodec: string | null }): Promise<void>; putPart(url: string, body: Buffer): Promise<string>; stagingDir: string; mixAudioStream: number; now(): number; sleep(ms: number): Promise<void> }`
  - `class CutManager { constructor(deps: CutDeps); load(): void; start(req: CutRequest): AgentCut; get(cutId: string): AgentCut | null; upload(cutId: string, req: UploadRequest): AgentCut; drop(cutId: string): void; idle(): Promise<void> }`
  - `class CutError extends Error { code: 'UNKNOWN_RECORDING' | 'NOT_CUT_YET' | 'UNKNOWN_CUT' | 'BAD_ID' }`
  - `putPartViaFetch(url: string, body: Buffer): Promise<string>` — PUTs, returns the `ETag` header, throws on a non-2xx.
  - `PART_ATTEMPTS = 5`

- [ ] **Step 1: Write the failing tests**

```ts
// watcher/test/cuts.test.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutError, CutManager, PART_ATTEMPTS, putPartViaFetch, type CutDeps } from '../src/cuts';

let dir: string;
let source: string | null;
let uploaded: { cutId: string; at: number }[];

function make(over: Partial<CutDeps> = {}) {
  const deps: CutDeps = {
    library: {
      get: vi.fn((ref: string) => (ref === 'known' ? ({ ref: 'known', videoCodec: 'hevc' } as never) : null)),
      sourceFor: vi.fn(() => source),
      recordUpload: vi.fn((_ref: string, cutId: string, at: number) => void uploaded.push({ cutId, at })),
    },
    cutFile: vi.fn(async (o) => void fs.writeFileSync(o.output, Buffer.alloc(40, 7))),
    putPart: vi.fn(async (_url: string, body: Buffer) => `"etag-${body.length}"`),
    stagingDir: dir,
    mixAudioStream: 0,
    now: () => 1000,
    sleep: async () => {},
    ...over,
  };
  return { deps, manager: new CutManager(deps) };
}

const req = { cutId: 'cut1', ref: 'known', startS: 3, endS: 7 };
const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, url: `https://s3/part/${i + 1}` }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-cuts-'));
  source = '/rec/master.mp4';
  uploaded = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('start', () => {
  it('cuts to a staging file and reports its size', async () => {
    const { manager, deps } = make();
    expect(manager.start(req).state).toBe('cutting');
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'cut', sizeBytes: 40 });
    expect(deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ input: '/rec/master.mp4', startS: 3, endS: 7, videoCodec: 'hevc' }));
  });

  it('uses audio stream 0 for an MP4 master and the configured mix track for an original', async () => {
    const a = make();
    a.manager.start(req);
    await a.manager.idle();
    expect(a.deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 0 }));

    source = '/rec/night.mkv';
    const b = make({ mixAudioStream: 2 });
    b.manager.start({ ...req, cutId: 'cut2' });
    await b.manager.idle();
    expect(b.deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 2 }));
  });

  it('a recording deleted by hand ends source_gone and never starts ffmpeg', async () => {
    source = null;
    const { manager, deps } = make();
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'source_gone' });
    expect(deps.cutFile).not.toHaveBeenCalled();
  });

  it('a file that vanishes while ffmpeg runs is source_gone, not a generic failure', async () => {
    const { manager } = make({
      cutFile: vi.fn(async () => {
        source = null;
        throw new Error('No such file');
      }),
    });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('source_gone');
  });

  it('is idempotent per cutId: a second start does not cut again', async () => {
    const { manager, deps } = make();
    manager.start(req);
    await manager.idle();
    manager.start(req);
    await manager.idle();
    expect(deps.cutFile).toHaveBeenCalledTimes(1);
  });

  it('a failed cut is retried when started again', async () => {
    let calls = 0;
    const { manager } = make({
      cutFile: vi.fn(async (o) => {
        if (++calls === 1) throw new Error('disk full');
        fs.writeFileSync(o.output, Buffer.alloc(40));
      }),
    });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: 'disk full' });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('cut');
  });

  it('refuses an unknown recording and an id that is not filesystem-safe', () => {
    const { manager } = make();
    expect(() => manager.start({ ...req, ref: 'nope' })).toThrow(CutError);
    expect(() => manager.start({ ...req, cutId: '../evil' })).toThrow(/BAD_ID|id/i);
  });
});

describe('upload', () => {
  async function cutReady() {
    const ctx = make();
    ctx.manager.start(req);
    await ctx.manager.idle();
    return ctx;
  }

  it('slices the staged file into the requested parts, collects ETags and records the upload', async () => {
    const { manager, deps } = await cutReady();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();

    expect(vi.mocked(deps.putPart).mock.calls.map(([, body]) => body.length)).toEqual([16, 16, 8]);
    expect(manager.get('cut1')).toMatchObject({
      state: 'done',
      etags: [{ n: 1, etag: '"etag-16"' }, { n: 2, etag: '"etag-16"' }, { n: 3, etag: '"etag-8"' }],
    });
    expect(uploaded).toEqual([{ cutId: 'cut1', at: 1000 }]);
  });

  it('retries a failing part with backoff, then succeeds', async () => {
    let n = 0;
    const { manager, deps } = make({
      putPart: vi.fn(async (_u: string, body: Buffer) => {
        if (++n <= 2) throw new Error('reset');
        return `"e${body.length}"`;
      }),
    });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('done');
    expect(deps.putPart).toHaveBeenCalledTimes(3);
  });

  it('gives up after PART_ATTEMPTS and reports failed, keeping the staged file for a retry', async () => {
    const { manager, deps } = make({ putPart: vi.fn(async () => { throw new Error('offline'); }) });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringContaining('offline') });
    expect(deps.putPart).toHaveBeenCalledTimes(PART_ATTEMPTS);
    expect(fs.existsSync(path.join(dir, 'cut1.mp4'))).toBe(true);
  });

  it('on retry, parts that already landed are not sent again', async () => {
    let fail = true;
    const { manager, deps } = make({
      putPart: vi.fn(async (url: string, body: Buffer) => {
        if (url.endsWith('/3') && fail) throw new Error('reset');
        return `"e${body.length}"`;
      }),
    });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('failed');

    fail = false;
    vi.mocked(deps.putPart).mockClear();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('done');
    expect(vi.mocked(deps.putPart).mock.calls.map(([u]) => u)).toEqual(['https://s3/part/3']);
  });

  it('rejects a part list that does not match the staged size', async () => {
    const { manager } = await cutReady();
    manager.upload('cut1', { partSize: 16, parts: parts(2) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/part/i) });
  });

  it('refuses to upload before the cut finished, and for an unknown cut', () => {
    const { manager } = make({ cutFile: vi.fn(() => new Promise(() => {})) });
    manager.start(req);
    expect(() => manager.upload('cut1', { partSize: 16, parts: parts(3) })).toThrow(CutError);
    expect(() => manager.upload('ghost', { partSize: 16, parts: parts(3) })).toThrow(CutError);
  });

  it('a staged file deleted by hand fails the upload cleanly', async () => {
    const { manager } = await cutReady();
    fs.rmSync(path.join(dir, 'cut1.mp4'));
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('failed');
  });
});

describe('restart and cleanup', () => {
  // The records a process leaves behind if it dies mid-cut and mid-upload, written by hand
  // so the test is deterministic rather than racing a real upload.
  const record = (over: object) => ({
    ref: 'known', startS: 0, endS: 10, sizeBytes: null, etags: null, reason: null,
    audioStream: 0, videoCodec: 'hevc', parts: [], ...over,
  });

  it('after a restart an interrupted cut is failed, and an interrupted upload is resumable with its finished parts', () => {
    fs.writeFileSync(path.join(dir, 'cut1.json'), JSON.stringify(record({ cutId: 'cut1', state: 'cutting' })));
    fs.writeFileSync(path.join(dir, 'cut2.mp4'), Buffer.alloc(40));
    fs.writeFileSync(
      path.join(dir, 'cut2.json'),
      JSON.stringify(record({ cutId: 'cut2', state: 'uploading', sizeBytes: 40, parts: [{ n: 1, etag: '"e1"' }] }))
    );

    const { manager } = make();
    manager.load();

    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/restart/) });
    expect(manager.get('cut2')).toMatchObject({ state: 'cut', sizeBytes: 40 });
  });

  it('a reloaded upload skips the part that already landed', async () => {
    fs.writeFileSync(path.join(dir, 'cut2.mp4'), Buffer.alloc(40));
    fs.writeFileSync(
      path.join(dir, 'cut2.json'),
      JSON.stringify(record({ cutId: 'cut2', state: 'uploading', sizeBytes: 40, parts: [{ n: 1, etag: '"e1"' }] }))
    );
    const { manager, deps } = make();
    manager.load();
    manager.upload('cut2', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(vi.mocked(deps.putPart).mock.calls.map(([u]) => u)).toEqual(['https://s3/part/2', 'https://s3/part/3']);
    expect(manager.get('cut2')?.state).toBe('done');
  });

  it('drop removes the staging file and the record', async () => {
    const { manager } = make();
    manager.start(req);
    await manager.idle();
    manager.drop('cut1');
    expect(manager.get('cut1')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('drop on something already gone is fine', () => {
    expect(() => make().manager.drop('ghost')).not.toThrow();
  });
});

describe('putPartViaFetch', () => {
  it('PUTs the bytes and returns the ETag', async () => {
    let seen = 0;
    const server = http.createServer((req, res) => {
      req.on('data', (c: Buffer) => (seen += c.length));
      req.on('end', () => {
        res.setHeader('ETag', '"abc"');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    expect(await putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(100))).toBe('"abc"');
    expect(seen).toBe(100);
    server.close();
  });

  it('throws on a non-2xx so the retry loop sees it', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    await expect(putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(1))).rejects.toThrow(/403/);
    server.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- cuts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// watcher/src/cuts.ts
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCut, CutRequest, UploadRequest } from '@show-uploader/domain';
import type { Library } from './library';

/**
 * Cuts one segment out of a recording and uploads it, part by part, to presigned
 * URLs it was handed. It holds no credentials: every URL is scoped to one object.
 *
 * One record per cutId on disk, so a restart can say what happened. A cut that was
 * running is reported failed (the worker re-requests it); an upload that was running
 * is resumable, because the staged file and the ETags of finished parts survive.
 */

export const PART_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export class CutError extends Error {
  constructor(
    readonly code: 'UNKNOWN_RECORDING' | 'NOT_CUT_YET' | 'UNKNOWN_CUT' | 'BAD_ID',
    message: string
  ) {
    super(message);
    this.name = 'CutError';
  }
}

export type CutDeps = {
  library: Pick<Library, 'get' | 'sourceFor' | 'recordUpload'>;
  cutFile(o: {
    input: string; output: string; startS: number; endS: number; audioStream: number; videoCodec: string | null;
  }): Promise<void>;
  /** PUT one part, return its ETag. Throws on failure. */
  putPart(url: string, body: Buffer): Promise<string>;
  stagingDir: string;
  mixAudioStream: number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type Record_ = AgentCut & {
  ref: string;
  startS: number;
  endS: number;
  audioStream: number;
  videoCodec: string | null;
  parts: { n: number; etag: string }[];
};

export async function putPartViaFetch(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body });
  if (!res.ok) throw new Error(`part upload failed: ${res.status}`);
  return res.headers.get('etag') ?? '';
}

export class CutManager {
  private readonly cuts = new Map<string, Record_>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly d: CutDeps) {}

  /** Reload records after a restart. */
  load(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.d.stagingDir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.d.stagingDir, name), 'utf8')) as Record_;
        // A running cut is gone with the process. A running upload resumes: its staged
        // file and finished parts are still here.
        if (rec.state === 'cutting') {
          rec.state = 'failed';
          rec.reason = 'interrupted by a restart';
        } else if (rec.state === 'uploading') {
          rec.state = 'cut';
        }
        this.cuts.set(rec.cutId, rec);
      } catch {
        // An unreadable record is simply not resumable.
      }
    }
  }

  start(req: CutRequest): AgentCut {
    if (!ID.test(req.cutId)) throw new CutError('BAD_ID', 'cutId must be 1-80 of A-Z a-z 0-9 _ -');
    if (!this.d.library.get(req.ref)) throw new CutError('UNKNOWN_RECORDING', `Unknown recording ${req.ref}`);

    const existing = this.cuts.get(req.cutId);
    if (existing && existing.state !== 'failed' && existing.state !== 'source_gone') return view(existing);

    const sidecar = this.d.library.get(req.ref)!;
    const rec: Record_ = {
      cutId: req.cutId, ref: req.ref, startS: req.startS, endS: req.endS,
      state: 'cutting', sizeBytes: null, etags: null, reason: null,
      audioStream: 0, videoCodec: sidecar.videoCodec, parts: [],
    };
    this.cuts.set(rec.cutId, rec);
    this.persist(rec);
    this.track(this.runCut(rec));
    return view(rec);
  }

  get(cutId: string): AgentCut | null {
    const rec = this.cuts.get(cutId);
    return rec ? view(rec) : null;
  }

  upload(cutId: string, req: UploadRequest): AgentCut {
    const rec = this.cuts.get(cutId);
    if (!rec) throw new CutError('UNKNOWN_CUT', `Unknown cut ${cutId}`);
    if (rec.state === 'done') return view(rec);
    if (rec.state === 'uploading') return view(rec);
    if (rec.state !== 'cut' && rec.state !== 'failed') throw new CutError('NOT_CUT_YET', 'The cut has not finished');
    if (rec.state === 'failed' && !fs.existsSync(this.stagedPath(rec))) {
      throw new CutError('NOT_CUT_YET', 'Nothing staged to upload; start the cut again');
    }
    rec.state = 'uploading';
    rec.reason = null;
    this.persist(rec);
    this.track(this.runUpload(rec, req));
    return view(rec);
  }

  drop(cutId: string): void {
    const rec = this.cuts.get(cutId);
    this.cuts.delete(cutId);
    if (!ID.test(cutId)) return;
    fs.rmSync(path.join(this.d.stagingDir, `${cutId}.mp4`), { force: true });
    fs.rmSync(path.join(this.d.stagingDir, `${cutId}.json`), { force: true });
    void rec;
  }

  /** Resolves when no cut or upload is running. For tests and a clean shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async runCut(rec: Record_): Promise<void> {
    const source = this.d.library.sourceFor(rec.ref);
    if (!source) return this.finish(rec, { state: 'source_gone', reason: 'The recording was deleted from the PC' });

    // The master has one audio stream; an original still has every OBS track.
    rec.audioStream = path.basename(source) === 'master.mp4' ? 0 : this.d.mixAudioStream;
    fs.mkdirSync(this.d.stagingDir, { recursive: true });
    const out = this.stagedPath(rec);
    try {
      await this.d.cutFile({
        input: source, output: out, startS: rec.startS, endS: rec.endS,
        audioStream: rec.audioStream, videoCodec: rec.videoCodec,
      });
      this.finish(rec, { state: 'cut', sizeBytes: fs.statSync(out).size });
    } catch (err) {
      fs.rmSync(out, { force: true });
      // ffmpeg failing because its input disappeared is not a bug to chase.
      if (!this.d.library.sourceFor(rec.ref)) {
        this.finish(rec, { state: 'source_gone', reason: 'The recording was deleted from the PC' });
      } else {
        this.finish(rec, { state: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async runUpload(rec: Record_, req: UploadRequest): Promise<void> {
    const file = this.stagedPath(rec);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return this.finish(rec, { state: 'failed', reason: 'The staged cut is gone; start the cut again' });
    }
    if (req.parts.length !== Math.max(1, Math.ceil(size / req.partSize))) {
      return this.finish(rec, { state: 'failed', reason: `Part list (${req.parts.length}) does not match the file size` });
    }

    const handle = await fs.promises.open(file, 'r');
    try {
      for (const part of [...req.parts].sort((a, b) => a.n - b.n)) {
        if (rec.parts.some((p) => p.n === part.n)) continue; // landed on an earlier attempt
        const offset = (part.n - 1) * req.partSize;
        const length = Math.min(req.partSize, size - offset);
        const body = Buffer.alloc(length);
        await handle.read(body, 0, length, offset);
        const etag = await this.putWithRetry(part.url, body);
        rec.parts.push({ n: part.n, etag });
        this.persist(rec);
      }
      const etags = [...rec.parts].sort((a, b) => a.n - b.n).map((p) => ({ n: p.n, etag: p.etag }));
      this.d.library.recordUpload(rec.ref, rec.cutId, this.d.now());
      this.finish(rec, { state: 'done', etags });
    } catch (err) {
      this.finish(rec, { state: 'failed', reason: err instanceof Error ? err.message : String(err) });
    } finally {
      await handle.close();
    }
  }

  private async putWithRetry(url: string, body: Buffer): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      try {
        return await this.d.putPart(url, body);
      } catch (err) {
        last = err;
        if (attempt < PART_ATTEMPTS) await this.d.sleep(Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
    throw new Error(`part upload gave up after ${PART_ATTEMPTS} attempts: ${last instanceof Error ? last.message : last}`);
  }

  private finish(rec: Record_, patch: Partial<AgentCut>): void {
    Object.assign(rec, patch);
    this.persist(rec);
  }

  private track(p: Promise<void>): void {
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  private stagedPath(rec: Pick<Record_, 'cutId'>): string {
    return path.join(this.d.stagingDir, `${rec.cutId}.mp4`);
  }

  private persist(rec: Record_): void {
    fs.mkdirSync(this.d.stagingDir, { recursive: true });
    const file = path.join(this.d.stagingDir, `${rec.cutId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec));
    fs.renameSync(`${file}.tmp`, file);
  }
}

function view(r: Record_): AgentCut {
  return { cutId: r.cutId, state: r.state, sizeBytes: r.sizeBytes, etags: r.etags, reason: r.reason };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/watcher test -- cuts && pnpm --filter @show-uploader/watcher exec tsc --noEmit`
Expected: PASS. If the restart test is flaky because the in-flight `cut2` upload finished before `load()`, it asserts `['cut','done']` on purpose.

- [ ] **Step 5: Commit**

```bash
git add watcher
git commit -m "feat(watcher): cut manager with resumable part upload

Idempotent per cutId; deleted sources end source_gone; no re-sent parts."
```

---

### Task 8: HTTP server implementing the v1 contract

**Files:**
- Create: `watcher/src/server.ts`, `watcher/test/server.test.ts`

**Interfaces:**
- Consumes: `Library`, `CutManager`, `CutError`, contract types.
- Produces: `createServer(deps: { token: string; library: Library; cuts: CutManager; status(): { recordingActive: boolean } }): express.Express`

Routes (all but none are public; all need `Authorization: Bearer <token>`):
`GET /v1/health`, `GET /v1/recordings`, `GET /v1/recordings/:ref/preview`, `GET /v1/recordings/:ref/peaks`, `POST /v1/cuts`, `GET /v1/cuts/:cutId`, `POST /v1/cuts/:cutId/upload`, `DELETE /v1/cuts/:cutId`.

- [ ] **Step 1: Write the failing tests**

```ts
// watcher/test/server.test.ts
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutManager } from '../src/cuts';
import { Library } from '../src/library';
import { createServer } from '../src/server';

const TOKEN = 't'.repeat(24);
let root: string;
let lib: Library;
let cuts: CutManager;
let base: string;
let close: () => void;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-srv-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.w'), stableWindowMs: 20_000 });
  const p = path.join(root, '2026-10-01_20-00-00.mkv');
  fs.writeFileSync(p, 'src');
  fs.utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
  lib.sync(NOW);
  const [s] = lib.list();
  fs.mkdirSync(lib.paths(s.ref).dir, { recursive: true });
  fs.writeFileSync(lib.paths(s.ref).preview, Buffer.alloc(1000, 1));
  fs.writeFileSync(lib.paths(s.ref).peaks, JSON.stringify([0.1, 0.2]));
  lib.save({ ...s, state: 'ready', hasPreview: true, hasPeaks: true, durationS: 3600 });

  cuts = new CutManager({
    library: lib, cutFile: vi.fn(() => new Promise(() => {})), putPart: vi.fn(),
    stagingDir: path.join(root, '.w', 'cuts'), mixAudioStream: 0, now: () => NOW, sleep: async () => {},
  });
  const app = createServer({ token: TOKEN, library: lib, cuts, status: () => ({ recordingActive: false }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => {
  close();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'Content-Type': 'application/json' };

describe('auth', () => {
  it('rejects a missing and a wrong token', async () => {
    expect((await fetch(`${base}/v1/recordings`)).status).toBe(401);
    expect((await fetch(`${base}/v1/recordings`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });
});

describe('recordings', () => {
  it('lists recordings with the contract fields', async () => {
    const res = await fetch(`${base}/v1/recordings`, { headers: auth });
    const [r] = (await res.json()) as Record<string, unknown>[];
    expect(r).toMatchObject({ filename: '2026-10-01_20-00-00.mkv', state: 'ready', hasPreview: true, durationS: 3600 });
    expect(typeof r.ref).toBe('string');
    expect(r.recordedAtMs).toBe(new Date(2026, 9, 1, 20, 0, 0).getTime());
  });

  it('serves the preview with Range support so scrubbing works', async () => {
    const [s] = lib.list();
    const res = await fetch(`${base}/v1/recordings/${s.ref}/preview`, { headers: { ...auth, Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('serves peaks, and 404s for an unknown or unprepared recording', async () => {
    const [s] = lib.list();
    expect(await (await fetch(`${base}/v1/recordings/${s.ref}/peaks`, { headers: auth })).json()).toEqual([0.1, 0.2]);
    expect((await fetch(`${base}/v1/recordings/ghost/preview`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v1/recordings/ghost/peaks`, { headers: auth })).status).toBe(404);
  });

  it('reports health with whether OBS is recording', async () => {
    expect(await (await fetch(`${base}/v1/health`, { headers: auth })).json()).toMatchObject({ ok: true, ready: 1, recordingActive: false });
  });
});

describe('cuts', () => {
  it('validates the body', async () => {
    const [s] = lib.list();
    const bad = (body: unknown) => fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await bad({ cutId: '../x', ref: s.ref, startS: 0, endS: 10 })).status).toBe(400);
    expect((await bad({ cutId: 'c1', ref: s.ref, startS: 10, endS: 5 })).status).toBe(400);
    expect((await bad({ cutId: 'c1', ref: s.ref, startS: 'a', endS: 5 })).status).toBe(400);
  });

  it('404s an unknown recording, accepts a good cut with 202, and 404s an unknown cut', async () => {
    const [s] = lib.list();
    const post = (ref: string) =>
      fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify({ cutId: 'c1', ref, startS: 0, endS: 60 }) });
    expect((await post('ghost')).status).toBe(404);
    const ok = await post(s.ref);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ cutId: 'c1', state: 'cutting' });
    expect((await fetch(`${base}/v1/cuts/c1`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/v1/cuts/ghost`, { headers: auth })).status).toBe(404);
  });

  it('answers 409 to an upload request while the cut is still running', async () => {
    const [s] = lib.list();
    await fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify({ cutId: 'c1', ref: s.ref, startS: 0, endS: 60 }) });
    const res = await fetch(`${base}/v1/cuts/c1/upload`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ partSize: 16, parts: [{ n: 1, url: 'https://s3/x' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('deleting a cut that is already gone is fine', async () => {
    expect((await fetch(`${base}/v1/cuts/ghost`, { method: 'DELETE', headers: auth })).status).toBe(204);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- server`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// watcher/src/server.ts
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AgentRecording } from '@show-uploader/domain';
import { CutError, type CutManager } from './cuts';
import type { Library, Sidecar } from './library';

const CutBody = z
  .object({
    cutId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    ref: z.string().min(1),
    startS: z.number().finite().min(0),
    endS: z.number().finite(),
  })
  .refine((b) => b.endS > b.startS, { message: 'endS must be after startS' });

const UploadBody = z.object({
  partSize: z.number().int().positive(),
  parts: z.array(z.object({ n: z.number().int().min(1), url: z.string().url() })).min(1),
});

function toRecording(s: Sidecar): AgentRecording {
  return {
    ref: s.ref, filename: s.filename, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs,
    durationS: s.durationS, state: s.state, hasPreview: s.hasPreview, recordedAtMs: s.recordedAtMs,
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createServer(deps: {
  token: string;
  library: Library;
  cuts: CutManager;
  status(): { recordingActive: boolean };
}): express.Express {
  const app = express();
  // Part lists carry ~200 presigned URLs for a multi-GB cut.
  app.use(express.json({ limit: '2mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7), deps.token)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/v1/health', (_req, res) => {
    const all = deps.library.list();
    res.json({
      ok: true,
      ready: all.filter((s) => s.state === 'ready').length,
      preparing: all.filter((s) => s.state === 'preparing').length,
      failed: all.filter((s) => s.state === 'failed').length,
      ...deps.status(),
    });
  });

  app.get('/v1/recordings', (_req, res) => {
    res.json(deps.library.list().map(toRecording));
  });

  app.get('/v1/recordings/:ref/preview', (req, res) => {
    const s = deps.library.get(req.params.ref);
    const file = s?.hasPreview ? path.resolve(deps.library.paths(s.ref).preview) : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no preview' });
    // sendFile handles Range, If-Range and conditional requests itself. `dotfiles: 'allow'`
    // is essential: the work folder is `.show-uploader`, and send answers 404 for any path
    // containing a dot-segment by default.
    res.type('video/mp4').sendFile(file, { acceptRanges: true, dotfiles: 'allow' });
  });

  app.get('/v1/recordings/:ref/peaks', (req, res) => {
    const s = deps.library.get(req.params.ref);
    const file = s?.hasPeaks ? deps.library.paths(s.ref).peaks : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no peaks' });
    res.type('application/json').send(fs.readFileSync(file));
  });

  app.post('/v1/cuts', (req, res) => {
    const body = CutBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    try {
      res.status(202).json(deps.cuts.start(body.data));
    } catch (err) {
      sendCutError(res, err);
    }
  });

  app.get('/v1/cuts/:cutId', (req, res) => {
    const cut = deps.cuts.get(req.params.cutId);
    if (!cut) return res.status(404).json({ error: 'unknown cut' });
    res.json(cut);
  });

  app.post('/v1/cuts/:cutId/upload', (req, res) => {
    const body = UploadBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    try {
      res.status(202).json(deps.cuts.upload(req.params.cutId, body.data));
    } catch (err) {
      sendCutError(res, err);
    }
  });

  app.delete('/v1/cuts/:cutId', (req, res) => {
    deps.cuts.drop(req.params.cutId);
    res.status(204).end();
  });

  return app;
}

function sendCutError(res: Response, err: unknown): void {
  if (err instanceof CutError) {
    const status = err.code === 'NOT_CUT_YET' ? 409 : err.code === 'BAD_ID' ? 400 : 404;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('cut request failed:', err);
  res.status(500).json({ error: 'internal error' });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/watcher test && pnpm --filter @show-uploader/watcher exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add watcher
git commit -m "feat(watcher): bearer-authenticated v1 HTTP API with ranged preview"
```

---

### Task 9: Retention, scheduler, composition root, Windows service

Pins Review Focus 2 at the loop level: no prepare while OBS is recording.

**Files:**
- Create: `watcher/src/prune.ts`, `watcher/src/scheduler.ts`, `watcher/test/prune.test.ts`, `watcher/test/scheduler.test.ts`, `watcher/.env.example`, `watcher/service/show-uploader-recordings.xml`, `watcher/README.md`
- Replace: `watcher/src/index.ts`

**Interfaces:**
- Produces:
  - `pruneOnce(deps: { library: Library; retentionMs: number }, nowMs: number): { pruned: string[] }`
  - `tick(deps: { library: Library; media: Media; mixAudioStream: number; retentionMs: number }, nowMs: number): Promise<{ recordingActive: boolean }>`

- [ ] **Step 1: Write the failing tests**

```ts
// watcher/test/prune.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Library } from '../src/library';
import { pruneOnce } from '../src/prune';

let root: string;
let lib: Library;
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function recording(name: string): { ref: string; file: string } {
  const file = path.join(root, name);
  fs.writeFileSync(file, 'x');
  fs.utimesSync(file, new Date(NOW - 60_000), new Date(NOW - 60_000));
  lib.sync(NOW);
  return { ref: lib.list().find((s) => s.filename === name)!.ref, file };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-prune-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.w'), stableWindowMs: 20_000 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('pruneOnce', () => {
  it('removes the original and derived files once the last cut upload is older than the retention', () => {
    const { ref, file } = recording('a.mkv');
    lib.recordUpload(ref, 'c1', NOW - 15 * DAY);
    expect(pruneOnce({ library: lib, retentionMs: 14 * DAY }, NOW).pruned).toEqual([ref]);
    expect(fs.existsSync(file)).toBe(false);
    expect(lib.get(ref)).toBeNull();
  });

  it('keeps a recording inside the retention window', () => {
    const { ref, file } = recording('a.mkv');
    lib.recordUpload(ref, 'c1', NOW - 2 * DAY);
    expect(pruneOnce({ library: lib, retentionMs: 14 * DAY }, NOW).pruned).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    expect(lib.get(ref)).not.toBeNull();
  });

  it('uses the NEWEST cut upload, so a late second cut extends the window', () => {
    const { ref } = recording('a.mkv');
    lib.recordUpload(ref, 'c1', NOW - 30 * DAY);
    lib.recordUpload(ref, 'c2', NOW - 1 * DAY);
    expect(pruneOnce({ library: lib, retentionMs: 14 * DAY }, NOW).pruned).toEqual([]);
  });

  it('never prunes a recording that was never cut', () => {
    const { ref, file } = recording('a.mkv');
    expect(pruneOnce({ library: lib, retentionMs: 1 }, NOW + 365 * DAY).pruned).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    expect(lib.get(ref)).not.toBeNull();
  });

  it('treats a file the operator already deleted as success', () => {
    const { ref, file } = recording('a.mkv');
    lib.recordUpload(ref, 'c1', NOW - 20 * DAY);
    fs.rmSync(file);
    expect(() => pruneOnce({ library: lib, retentionMs: 14 * DAY }, NOW)).not.toThrow();
  });
});
```

```ts
// watcher/test/scheduler.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Library } from '../src/library';
import type { Media } from '../src/prepare';
import { tick } from '../src/scheduler';

let root: string;
let lib: Library;
const NOW = 1_800_000_000_000;

const media = (): Media => ({
  probe: vi.fn(async () => ({ durationS: 10, videoCodec: 'h264', audioStreams: 1 })),
  remux: vi.fn(async (o) => void fs.writeFileSync(o.output, 'm')),
  preview: vi.fn(async (o) => void fs.writeFileSync(o.output, 'p')),
  peaks: vi.fn(async () => [0.1]),
});

const age = (name: string, ms: number) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, 'x');
  fs.utimesSync(p, new Date(NOW - ms), new Date(NOW - ms));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-tick-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.w'), stableWindowMs: 20_000 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('tick', () => {
  it('prepares one waiting recording when OBS is idle', async () => {
    age('a.mkv', 60_000);
    const m = media();
    const r = await tick({ library: lib, media: m, mixAudioStream: 0, retentionMs: 1e12 }, NOW);
    expect(r.recordingActive).toBe(false);
    expect(m.probe).toHaveBeenCalled();
    expect(lib.list()[0].state).toBe('ready');
  });

  it('does NOT start ffmpeg work while a file is still growing: OBS must keep its CPU', async () => {
    age('done.mkv', 60_000);
    age('live.mkv', 1_000);
    const m = media();
    const r = await tick({ library: lib, media: m, mixAudioStream: 0, retentionMs: 1e12 }, NOW);
    expect(r.recordingActive).toBe(true);
    expect(m.probe).not.toHaveBeenCalled();
    expect(lib.list()[0].state).toBe('preparing');
  });

  it('prepares at most one recording per tick, so a backlog never monopolises the box', async () => {
    age('a.mkv', 60_000);
    age('b.mkv', 61_000);
    const m = media();
    await tick({ library: lib, media: m, mixAudioStream: 0, retentionMs: 1e12 }, NOW);
    expect(lib.list().filter((s) => s.state === 'ready')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/watcher test -- prune scheduler`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement prune, scheduler and the composition root**

```ts
// watcher/src/prune.ts
import fs from 'node:fs';
import type { Library } from './library';

/**
 * Remove recordings whose cuts are safely uploaded and old enough. The service has no
 * credentials for the api, so it cannot see archival; "last cut uploaded, plus the
 * retention period" is the rule it can enforce. A recording that was never cut is
 * never pruned. A file the operator already removed is success, not an error.
 */
export function pruneOnce(deps: { library: Library; retentionMs: number }, nowMs: number): { pruned: string[] } {
  const pruned: string[] = [];
  for (const s of deps.library.list()) {
    if (s.cuts.length === 0) continue;
    const newest = Math.max(...s.cuts.map((c) => c.uploadedAtMs));
    if (nowMs - newest < deps.retentionMs) continue;
    try {
      fs.rmSync(s.originalPath, { force: true });
      deps.library.remove(s.ref);
      pruned.push(s.ref);
    } catch (err) {
      // A locked file (OBS, a player) is tried again next tick.
      console.warn(`could not prune ${s.filename}:`, err instanceof Error ? err.message : err);
    }
  }
  return { pruned };
}
```

```ts
// watcher/src/scheduler.ts
import type { Library } from './library';
import { prepareRecording, type Media } from './prepare';
import { pruneOnce } from './prune';

/**
 * One pass of the service's background work. Preparing runs ffmpeg for minutes, so it
 * only starts while no file in the folder is still growing, and at most one recording
 * per pass. Everything else here is cheap file bookkeeping.
 */
export async function tick(
  deps: { library: Library; media: Media; mixAudioStream: number; retentionMs: number },
  nowMs: number
): Promise<{ recordingActive: boolean }> {
  const { recordingActive } = deps.library.sync(nowMs);

  if (!recordingActive) {
    const next = deps.library.list().find((s) => s.state === 'preparing');
    if (next) await prepareRecording({ library: deps.library, media: deps.media, mixAudioStream: deps.mixAudioStream }, next.ref);
  }

  pruneOnce({ library: deps.library, retentionMs: deps.retentionMs }, nowMs);
  return { recordingActive };
}
```

```ts
// watcher/src/index.ts
import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config';
import { CutManager, putPartViaFetch } from './cuts';
import { buildCutArgs, buildPreviewArgs, buildRemuxArgs, computePeaks, probe, runFfmpeg } from './ffmpeg';
import { Library } from './library';
import type { Media } from './prepare';
import { tick } from './scheduler';
import { createServer } from './server';

const config = loadConfig();
const { tools } = config;

const library = new Library({
  recordingsDir: config.recordingsDir,
  workDir: config.workDir,
  stableWindowMs: config.stableWindowMs,
});

const media: Media = {
  probe: (file) => probe(tools, file),
  remux: (o) => runFfmpeg(tools.ffmpeg, buildRemuxArgs(o)),
  preview: (o) => runFfmpeg(tools.ffmpeg, buildPreviewArgs(o)),
  peaks: (file, audioStream) => computePeaks(tools, file, audioStream),
};

const cuts = new CutManager({
  library,
  cutFile: (o) => runFfmpeg(tools.ffmpeg, buildCutArgs(o)),
  putPart: putPartViaFetch,
  stagingDir: path.join(config.workDir, 'cuts'),
  mixAudioStream: config.mixAudioStream,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
cuts.load();

// A recording that failed last run gets another go after a restart; nothing retries it
// on its own, so one bad file cannot loop forever.
for (const s of library.list()) {
  if (s.state === 'failed') library.save({ ...s, state: 'preparing', error: null });
}

let recordingActive = false;
let busy = false;

async function loop(): Promise<void> {
  if (busy) return; // a long prepare must not overlap the next tick
  busy = true;
  try {
    recordingActive = (
      await tick(
        { library, media, mixAudioStream: config.mixAudioStream, retentionMs: config.retentionDays * 86_400_000 },
        Date.now()
      )
    ).recordingActive;
  } catch (err) {
    console.error('background pass failed:', err);
  } finally {
    busy = false;
  }
}

const app = createServer({ token: config.token, library, cuts, status: () => ({ recordingActive }) });
app.listen(config.listenPort, config.listenHost, () => {
  console.log(`recordings service on http://${config.listenHost}:${config.listenPort} watching ${config.recordingsDir}`);
});

void loop();
setInterval(() => void loop(), config.scanIntervalMs);
```

- [ ] **Step 4: Add the service definition, env example and README**

```xml
<!-- watcher/service/show-uploader-recordings.xml
     WinSW (https://github.com/winsw/winsw) service definition. Rename the WinSW exe to
     show-uploader-recordings.exe and keep this file next to it. Edit the two paths. -->
<service>
  <id>ShowUploaderRecordings</id>
  <name>Show Uploader Recordings</name>
  <description>Prepares OBS recordings and cuts per-artist segments for the uploader.</description>
  <executable>C:\Program Files\nodejs\node.exe</executable>
  <arguments>dist\index.js</arguments>
  <workingdirectory>C:\show-uploader\watcher</workingdirectory>
  <startmode>Automatic</startmode>
  <priority>BelowNormal</priority>
  <onfailure action="restart" delay="10 sec"/>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
```

```bash
# watcher/.env.example — copy to .env next to dist/ on the OBS PC
RECORDINGS_DIR=C:/Users/koray/Videos/OBS recordings
# At least 16 characters. The same value goes in the uploader's RECORDINGS_AGENT_TOKEN.
AGENT_TOKEN=generate-a-long-random-secret
# The PC's Tailscale IP (tailscale ip -4), so the service is reachable on the tailnet only.
LISTEN_HOST=100.64.0.10
LISTEN_PORT=8787
FFMPEG_PATH=C:/show-uploader/tools/ffmpeg.exe
FFPROBE_PATH=C:/show-uploader/tools/ffprobe.exe
# RETENTION_DAYS=14
# MIX_AUDIO_STREAM=0   # OBS tracks 1,3,4 appear in order, so track 1 is stream 0
```

```markdown
<!-- watcher/README.md -->
# Recordings service (OBS PC)

Runs on the Windows OBS machine, next to (not inside) the OBS agent. It watches the OBS
recordings folder, prepares each finished recording (verified MP4 master, small H.264
preview, waveform peaks), cuts segments losslessly on request and uploads only those to
S3. It never talks to the api itself: the uploader's worker drives it over Tailscale.

## Install

1. Node 20 and `ffmpeg.exe` + `ffprobe.exe` (a full build with libx264) in `C:\show-uploader\tools`.
2. `pnpm install && pnpm --filter @show-uploader/watcher build`, copy `watcher/` (with `dist/` and `node_modules`) to `C:\show-uploader\watcher`.
3. Copy `.env.example` to `.env` and fill it in. Set `LISTEN_HOST` to the PC's Tailscale IP.
4. Install the service with WinSW (`show-uploader-recordings.xml` here): `show-uploader-recordings.exe install`, then `start`.
5. In the Tailscale admin, allow only the uploader host to reach port 8787 on this machine.

## Operate

- Logs: next to the WinSW exe. Status: the uploader's Recordings page.
- Updating: stop the service, replace `dist/`, start it.
- Deleting recordings by hand is fine at any time. The service forgets a recording once
  neither its MKV nor its MP4 master is left.
- Derived files live in `RECORDINGS_DIR\.show-uploader`. They are disposable.
- Retention: a recording is removed `RETENTION_DAYS` after its newest successful cut
  upload. A recording that was never cut is never removed automatically.
```

- [ ] **Step 5: Run everything and commit**

Run: `pnpm --filter @show-uploader/watcher test && pnpm --filter @show-uploader/watcher build`
Expected: all PASS, build succeeds.

```bash
git add watcher
git commit -m "feat(watcher): scheduler, retention and Windows service definition

No ffmpeg work while OBS is recording; prune only after a cut was uploaded."
```

### Task 10: Extract upload-session rules into a use case, and add cut provenance

The completion rule (finish the S3 object **and** stage the video for the show, atomically) currently lives in `routes/multipart.ts`. The worker will need the same rule, so it becomes one use case that both callers share. This is the lifecycle rule in `docs/architecture/video-lifecycle.md`: bind at creation, record on completion, server-side.

**Files:**
- Create: `api/src/db/migrations/012_multipart_cut_source.sql`, `api/src/usecases/uploads.ts`, `api/src/routes/respond.ts`, `api/test/usecases/uploads.test.ts`
- Modify: `api/src/ports.ts`, `api/src/adapters.ts`, `api/src/db/queries.ts`, `api/src/routes/multipart.ts`, `api/test/fakes.ts`

**Interfaces:**
- Produces:
  - `PART_SIZE = 16 * 1024 * 1024`
  - `type UploadSession = { id: string; show_id: string | null; s3_key: string; s3_upload_id: string; filename: string; size_bytes: string; content_type: string; part_size: number; status: string; cut_id: string | null }`
  - `type NewSession = { showId: string | null; key: string; s3UploadId: string; filename: string; size: number; contentType: string; partSize: number; cut: { cutId: string; ref: string; startS: number; endS: number } | null }`
  - port `UploadSessions { create(d: NewSession): Promise<string>; get(id: string): Promise<UploadSession | null>; findByCutId(cutId: string): Promise<UploadSession | null>; setStatus(id: string, status: 'completed' | 'aborted'): Promise<void>; stage(showId: string, key: string, filename: string, sizeBytes: number): Promise<void> }`
  - `ObjectStore` gains `createMultipart(key, contentType): Promise<string>`, `presignPart(key, uploadId, partNumber): Promise<string>`, `completeMultipart(key, uploadId): Promise<void>`, `abortMultipart(key, uploadId): Promise<void>`
  - `ApiDeps` gains `sessions: UploadSessions`
  - `openUploadSession(input: { filename: string; contentType: string; size: number; showId: string | null; cut?: { cutId: string; ref: string; startS: number; endS: number } }, deps: Pick<ApiDeps, 'objects' | 'sessions'>): Promise<{ sessionId: string; key: string; partSize: number; partCount: number }>`
  - `completeUpload(sessionId: string, deps: Pick<ApiDeps, 'objects' | 'sessions'>): Promise<{ key: string }>` (throws `UseCaseError('NOT_FOUND')` for an unknown session; idempotent for a completed one)
  - `abortUpload(sessionId: string, deps): Promise<void>`
  - `sendFailure(res: Response, err: unknown, log: string, publicMessage: string): void` in `routes/respond.ts`

- [ ] **Step 1: Write the failing use-case tests**

```ts
// api/test/usecases/uploads.test.ts
import { describe, it, expect } from 'vitest';
import { UseCaseError } from '../../src/usecases/errors';
import { PART_SIZE, abortUpload, completeUpload, openUploadSession } from '../../src/usecases/uploads';
import { fakeDeps } from '../fakes';

const open = { filename: 'night one.mkv', contentType: 'video/x-matroska', size: 40 * 1024 * 1024, showId: 'show-1' };

describe('openUploadSession', () => {
  it('starts the S3 upload, binds the session to its show and reports the part count', async () => {
    const deps = fakeDeps();
    const out = await openUploadSession(open, deps);

    expect(out.partSize).toBe(PART_SIZE);
    expect(out.partCount).toBe(3);
    expect(out.key).toMatch(/^incoming\/\d+-night_one\.mkv$/);
    expect(deps.sessionRows.get(out.sessionId)).toMatchObject({ show_id: 'show-1', status: 'in_progress', s3_upload_id: 'mpu-1' });
  });

  it('records which cut a session came from', async () => {
    const deps = fakeDeps();
    const cut = { cutId: 'c1', ref: 'r1', startS: 10, endS: 20 };
    const out = await openUploadSession({ ...open, cut }, deps);
    expect(deps.sessionRows.get(out.sessionId)?.cut_id).toBe('c1');
  });

  it('an empty file still needs one part', async () => {
    expect((await openUploadSession({ ...open, size: 1 }, fakeDeps())).partCount).toBe(1);
  });

  it('abandons the S3 upload when the session row cannot be saved, so no orphan accrues', async () => {
    const deps = fakeDeps();
    deps.sessions.create.mockRejectedValueOnce(new Error('db down'));
    await expect(openUploadSession(open, deps)).rejects.toThrow('db down');
    expect(deps.objects.abortMultipart).toHaveBeenCalledWith(expect.stringMatching(/^incoming\//), 'mpu-1');
  });
});

describe('completeUpload', () => {
  it('completes the S3 object, marks the session and stages the video for its show', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);

    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });

    expect(deps.objects.completeMultipart).toHaveBeenCalledWith(key, 'mpu-1');
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
    expect(deps.staged.get('show-1')).toEqual({ key, filename: 'night one.mkv', size: open.size });
  });

  it('stages nothing for a session with no show', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession({ ...open, showId: null }, deps);
    await completeUpload(sessionId, deps);
    expect(deps.sessions.stage).not.toHaveBeenCalled();
  });

  it('is idempotent: completing a finished session answers with its key and does no more work', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    await completeUpload(sessionId, deps);
    deps.objects.completeMultipart.mockClear();

    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });
    expect(deps.objects.completeMultipart).not.toHaveBeenCalled();
  });

  it('refuses an unknown session', async () => {
    const err = await completeUpload('nope', fakeDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UseCaseError);
    expect((err as UseCaseError).code).toBe('NOT_FOUND');
  });

  it('a failed S3 completion leaves the session open and stages nothing', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    deps.objects.completeMultipart.mockRejectedValueOnce(new Error('s3 down'));

    await expect(completeUpload(sessionId, deps)).rejects.toThrow('s3 down');

    expect(deps.sessionRows.get(sessionId)?.status).toBe('in_progress');
    expect(deps.staged.size).toBe(0);
  });
});

describe('abortUpload', () => {
  it('aborts the S3 upload of a session in progress and marks it', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    await abortUpload(sessionId, deps);
    expect(deps.objects.abortMultipart).toHaveBeenCalledWith(key, 'mpu-1');
    expect(deps.sessionRows.get(sessionId)?.status).toBe('aborted');
  });

  it('a late abort leaves a completed session alone: no S3 call and its status is not rewritten', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    await completeUpload(sessionId, deps);
    await abortUpload(sessionId, deps);
    expect(deps.objects.abortMultipart).not.toHaveBeenCalled();
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Extend the api ports**

In `api/src/ports.ts`, replace the `ObjectStore` interface with:

```ts
/** The S3 bucket. */
export interface ObjectStore {
  info(key: string): Promise<{ exists: boolean; size: number | null }>;
  uploadedParts(key: string, uploadId: string): Promise<{ Size?: number }[]>;
  /** The `shows/<folder>/` holding an agenda record's recording, if any. */
  findShowFolder(show: AgendaShow): Promise<string | null>;
  /** Multipart uploads: start one, presign a part, finish it, abandon it. */
  createMultipart(key: string, contentType: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  completeMultipart(key: string, uploadId: string): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export type UploadSession = {
  id: string;
  show_id: string | null;
  s3_key: string;
  s3_upload_id: string;
  filename: string;
  size_bytes: string;
  content_type: string;
  part_size: number;
  status: string;
  /** Set when the session uploads a segment cut from an OBS recording. */
  cut_id: string | null;
};

export type NewSession = {
  showId: string | null;
  key: string;
  s3UploadId: string;
  filename: string;
  size: number;
  contentType: string;
  partSize: number;
  cut: { cutId: string; ref: string; startS: number; endS: number } | null;
};

/** Resumable multipart upload sessions, and the staged video they produce. */
export interface UploadSessions {
  /** Returns the new session's id. */
  create(data: NewSession): Promise<string>;
  get(id: string): Promise<UploadSession | null>;
  /** The live (not aborted) session for a cut, so a retried request reuses it. */
  findByCutId(cutId: string): Promise<UploadSession | null>;
  setStatus(id: string, status: 'completed' | 'aborted'): Promise<void>;
  /** Record the video as staged for the show; replaces any earlier one. */
  stage(showId: string, key: string, filename: string, sizeBytes: number): Promise<void>;
}
```

and add `sessions: UploadSessions;` to `ApiDeps` (after `objects: ObjectStore;`).

- [ ] **Step 3: Migration and queries**

```sql
-- api/src/db/migrations/012_multipart_cut_source.sql
-- Provenance of an upload session that carries a segment cut from an OBS recording on
-- the recordings PC. Audit and retry only: video state still lives in staged_uploads.
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_id TEXT;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_start_s DOUBLE PRECISION;
ALTER TABLE multipart_uploads ADD COLUMN IF NOT EXISTS cut_end_s DOUBLE PRECISION;
-- One live session per cut: a retried request finds it instead of opening a second
-- S3 upload. An aborted session frees the id so the cut can be redone.
CREATE UNIQUE INDEX IF NOT EXISTS multipart_uploads_live_cut
  ON multipart_uploads (cut_id) WHERE cut_id IS NOT NULL AND status <> 'aborted';
```

Append to `api/src/db/queries.ts` (it already imports the `Sql` type):

```ts
export type MultipartSession = {
  id: string;
  show_id: string | null;
  s3_key: string;
  s3_upload_id: string;
  filename: string;
  size_bytes: string;
  content_type: string;
  part_size: number;
  status: string;
  cut_id: string | null;
};

export async function createMultipartSession(
  db: Sql,
  d: {
    showId: string | null; key: string; s3UploadId: string; filename: string; size: number;
    contentType: string; partSize: number;
    cut: { cutId: string; ref: string; startS: number; endS: number } | null;
  }
): Promise<string> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO multipart_uploads
      (show_id, s3_key, s3_upload_id, filename, size_bytes, content_type, part_size,
       source_ref, cut_id, cut_start_s, cut_end_s)
    VALUES
      (${d.showId}, ${d.key}, ${d.s3UploadId}, ${d.filename}, ${d.size}, ${d.contentType}, ${d.partSize},
       ${d.cut?.ref ?? null}, ${d.cut?.cutId ?? null}, ${d.cut?.startS ?? null}, ${d.cut?.endS ?? null})
    RETURNING id
  `;
  return rows[0].id;
}

export async function getMultipartSession(db: Sql, id: string): Promise<MultipartSession | null> {
  const rows = await db<MultipartSession[]>`SELECT * FROM multipart_uploads WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function findMultipartSessionByCutId(db: Sql, cutId: string): Promise<MultipartSession | null> {
  const rows = await db<MultipartSession[]>`
    SELECT * FROM multipart_uploads
    WHERE cut_id = ${cutId} AND status <> 'aborted'
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function setMultipartStatus(db: Sql, id: string, status: 'completed' | 'aborted'): Promise<void> {
  if (status === 'completed') {
    await db`UPDATE multipart_uploads SET status = 'completed', completed_at = now() WHERE id = ${id}`;
  } else {
    await db`UPDATE multipart_uploads SET status = 'aborted' WHERE id = ${id}`;
  }
}
```

- [ ] **Step 4: Wire the adapters**

In `api/src/adapters.ts`: extend the `./db/queries` import with `createMultipartSession, findMultipartSessionByCutId, getMultipartSession, setMultipartStatus, upsertStagedUpload`; change the s3 import to
`import { abortMultipart, completeMultipart, createMultipart, listUploadedParts, objectInfo, presignUploadPart } from './services/s3';`
and replace the `objects: { ... },` block with:

```ts
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
```

- [ ] **Step 5: Extend the api fakes**

In `api/test/fakes.ts`: add `UploadSession` to the ports import (`import type { ApiDeps, UploadSession, UploadWithJobs } from '../src/ports';`); after `let nextId = 1;` add

```ts
  const sessionRows = new Map<string, UploadSession>();
  const staged = new Map<string, { key: string; filename: string; size: number }>();
```

replace the `findShowFolder: vi.fn(...),\n    },` line pair in `objects` with

```ts
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
```

and change the return to `return { ...deps, rows: uploads, queued, sessionRows, staged };`.

- [ ] **Step 6: Run to verify the new tests fail, then add the use case**

Run: `pnpm --filter @show-uploader/api test -- uploads`
Expected: FAIL, cannot find `../../src/usecases/uploads`.

```ts
// api/src/usecases/uploads.ts
import { incomingKey } from '@show-uploader/domain';
import type { ApiDeps } from '../ports';
import { UseCaseError } from './errors';

// 16 MiB parts: well above S3's 5 MiB minimum, few enough requests for large
// files, small enough that a failed part is cheap to retry.
export const PART_SIZE = 16 * 1024 * 1024;

type SessionDeps = Pick<ApiDeps, 'objects' | 'sessions'>;

export type OpenSessionInput = {
  filename: string;
  contentType: string;
  size: number;
  /** The show this upload belongs to — bound from the start, so completion can stage it. */
  showId: string | null;
  /** Set when the file is a segment cut from an OBS recording. */
  cut?: { cutId: string; ref: string; startS: number; endS: number };
};

// Start a session: create the S3 multipart upload and persist it.
export async function openUploadSession(input: OpenSessionInput, { objects, sessions }: SessionDeps) {
  const key = incomingKey(input.filename);
  const s3UploadId = await objects.createMultipart(key, input.contentType);
  try {
    const sessionId = await sessions.create({
      showId: input.showId,
      key,
      s3UploadId,
      filename: input.filename,
      size: input.size,
      contentType: input.contentType,
      partSize: PART_SIZE,
      cut: input.cut ?? null,
    });
    return { sessionId, key, partSize: PART_SIZE, partCount: Math.max(1, Math.ceil(input.size / PART_SIZE)) };
  } catch (err) {
    // Without its row nothing can ever complete or abort this upload, so it would
    // sit in the bucket accruing parts. Give it up now.
    await objects.abortMultipart(key, s3UploadId).catch(() => {});
    throw err;
  }
}

// Finish: complete the S3 object and — the key robustness point — record the staged
// video against the show ATOMICALLY here. The show record therefore always knows it
// has a video the instant the upload finishes, independent of the client
// (navigation, refresh, a crash) or the worker that drove it.
export async function completeUpload(sessionId: string, { objects, sessions }: SessionDeps): Promise<{ key: string }> {
  const s = await sessions.get(sessionId);
  if (!s) throw new UseCaseError('NOT_FOUND', 'Unknown session');
  if (s.status === 'completed') return { key: s.s3_key };

  await objects.completeMultipart(s.s3_key, s.s3_upload_id);
  await sessions.setStatus(s.id, 'completed');
  if (s.show_id) await sessions.stage(s.show_id, s.s3_key, s.filename, Number(s.size_bytes));
  return { key: s.s3_key };
}

// Cancel: abort the S3 upload and mark the session. Only a session still in progress
// can be cancelled: a completed one has a finished object and a staged video, and a
// late abort (a caller that lost the completion response) must not rewrite that history.
export async function abortUpload(sessionId: string, { objects, sessions }: SessionDeps): Promise<void> {
  const s = await sessions.get(sessionId);
  if (!s) throw new UseCaseError('NOT_FOUND', 'Unknown session');
  if (s.status !== 'in_progress') return;
  await objects.abortMultipart(s.s3_key, s.s3_upload_id);
  await sessions.setStatus(s.id, 'aborted');
}
```

- [ ] **Step 7: Thin the REST route**

```ts
// api/src/routes/respond.ts
import type { Response } from 'express';
import { UseCaseError } from '../usecases/errors';

const STATUS = { NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 } as const;

/** A refused rule keeps its code and message; anything else is logged and becomes a 500. */
export function sendFailure(res: Response, err: unknown, log: string, publicMessage: string): void {
  if (err instanceof UseCaseError) {
    res.status(STATUS[err.code]).json({ error: err.message });
    return;
  }
  console.error(log, err);
  res.status(500).json({ error: publicMessage });
}
```

Replace `api/src/routes/multipart.ts` entirely with:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { getMultipartSession } from '../db/queries';
import { listUploadedParts, presignUploadPart } from '../services/s3';
import { deps } from '../deps';
import { abortUpload, completeUpload, openUploadSession } from '../usecases/uploads';
import { sendFailure } from './respond';

export const multipartRouter = Router();

const CreateSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  // The show this upload belongs to — bound from the start so completion can
  // record the staged video server-side. Optional so a stale (pre-deploy) client
  // that doesn't send it still uploads instead of hard-failing with 400.
  showId: z.string().min(1).optional(),
});

// Start a session: create the S3 multipart upload and persist it.
multipartRouter.post('/create', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  try {
    const { filename, contentType, size, showId } = parsed.data;
    const out = await openUploadSession({ filename, contentType, size, showId: showId ?? null }, deps);
    res.status(201).json(out);
  } catch (err) {
    sendFailure(res, err, 'multipart create failed:', 'Failed to start multipart upload');
  }
});

// Resume info: which part numbers already landed (server is source of truth).
multipartRouter.get('/:sessionId', async (req, res) => {
  const s = await getMultipartSession(db, req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Unknown session' });
  try {
    const parts = s.status === 'in_progress' ? await listUploadedParts(s.s3_key, s.s3_upload_id) : [];
    res.json({
      sessionId: s.id,
      key: s.s3_key,
      filename: s.filename,
      size: Number(s.size_bytes),
      contentType: s.content_type,
      partSize: s.part_size,
      status: s.status,
      uploadedParts: parts.map((p) => ({ partNumber: p.PartNumber, size: p.Size })),
    });
  } catch (err) {
    console.error('multipart status failed:', err);
    res.status(500).json({ error: 'Failed to read session' });
  }
});

// Presigned URL to PUT a single part.
multipartRouter.post('/:sessionId/part/:n', async (req, res) => {
  const partNumber = Number(req.params.n);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return res.status(400).json({ error: 'Invalid part number' });
  }
  const s = await getMultipartSession(db, req.params.sessionId);
  if (!s || s.status !== 'in_progress') return res.status(404).json({ error: 'Session not open' });
  try {
    res.json({ url: await presignUploadPart(s.s3_key, s.s3_upload_id, partNumber) });
  } catch (err) {
    console.error('presign part failed:', err);
    res.status(500).json({ error: 'Failed to presign part' });
  }
});

multipartRouter.post('/:sessionId/complete', async (req, res) => {
  try {
    res.json(await completeUpload(req.params.sessionId, deps));
  } catch (err) {
    sendFailure(res, err, 'multipart complete failed:', 'Failed to complete upload');
  }
});

multipartRouter.post('/:sessionId/abort', async (req, res) => {
  try {
    await abortUpload(req.params.sessionId, deps);
    res.json({ ok: true });
  } catch (err) {
    sendFailure(res, err, 'multipart abort failed:', 'Failed to abort upload');
  }
});
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @show-uploader/api test && pnpm --filter @show-uploader/api exec tsc --noEmit`
Expected: PASS; no type errors (every `fakeDeps` user still satisfies `ApiDeps`).

- [ ] **Step 9: Commit**

```bash
git add api
git commit -m "refactor(api): upload session rules into a use case; add cut provenance

Completion (S3 object + staged video) is one copy the worker can reuse."
```

---

### Task 11: Agent adapter and signed preview paths

**Files:**
- Create: `api/src/services/recordings-agent.ts`, `api/src/services/preview-signature.ts`, `api/test/services/recordings-agent.test.ts`, `api/test/services/preview-signature.test.ts`

**Interfaces:**
- Consumes: `AgentRecording`, `AGENT_API_PREFIX` from `@show-uploader/domain`.
- Produces:
  - `createRecordingsAgent(o: { baseUrl?: string; token?: string; timeoutMs?: number }): RecordingsAgent` where
    `interface RecordingsAgent { list(): Promise<AgentRecording[] | null>; peaks(ref: string): Promise<number[] | null>; preview(ref: string, range: string | undefined, signal?: AbortSignal): Promise<Response | null> }` (the interface is added to `ports.ts` in Task 12; this file declares it structurally and Task 12 re-points the import)
  - `PREVIEW_TTL_MS = 6 * 60 * 60 * 1000`
  - `signPreview(ref: string, secret: string, nowMs: number): { exp: number; sig: string }`
  - `verifyPreview(ref: string, exp: number, sig: string, secret: string, nowMs: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/services/preview-signature.test.ts
import { describe, it, expect } from 'vitest';
import { PREVIEW_TTL_MS, signPreview, verifyPreview } from '../../src/services/preview-signature';

const SECRET = 's'.repeat(24);
const NOW = 1_800_000_000_000;

describe('preview signatures', () => {
  it('accepts a fresh signature for the same recording', () => {
    const { exp, sig } = signPreview('ref1', SECRET, NOW);
    expect(exp).toBe(NOW + PREVIEW_TTL_MS);
    expect(verifyPreview('ref1', exp, sig, SECRET, NOW + 1000)).toBe(true);
  });

  it('rejects an expired one', () => {
    const { exp, sig } = signPreview('ref1', SECRET, NOW);
    expect(verifyPreview('ref1', exp, sig, SECRET, exp + 1)).toBe(false);
  });

  it('rejects a signature reused for another recording, or with a stretched expiry', () => {
    const { exp, sig } = signPreview('ref1', SECRET, NOW);
    expect(verifyPreview('ref2', exp, sig, SECRET, NOW)).toBe(false);
    expect(verifyPreview('ref1', exp + 60_000, sig, SECRET, NOW)).toBe(false);
  });

  it('rejects the wrong secret, a short signature and garbage', () => {
    const { exp, sig } = signPreview('ref1', SECRET, NOW);
    expect(verifyPreview('ref1', exp, sig, 'x'.repeat(24), NOW)).toBe(false);
    expect(verifyPreview('ref1', exp, sig.slice(0, 10), SECRET, NOW)).toBe(false);
    expect(verifyPreview('ref1', Number.NaN, sig, SECRET, NOW)).toBe(false);
  });
});
```

```ts
// api/test/services/recordings-agent.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingsAgent } from '../../src/services/recordings-agent';

let server: http.Server;
let seen: { url?: string; auth?: string; range?: string };

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  seen = {};
  server = http.createServer((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, range: req.headers.range as string | undefined };
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => server?.close());

describe('recordings agent adapter', () => {
  it('lists recordings with the bearer token', async () => {
    const baseUrl = await serve((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify([{ ref: 'r1' }])));
    const agent = createRecordingsAgent({ baseUrl, token: 't'.repeat(20) });
    expect(await agent.list()).toEqual([{ ref: 'r1' }]);
    expect(seen).toMatchObject({ url: '/v1/recordings', auth: `Bearer ${'t'.repeat(20)}` });
  });

  it('treats an unconfigured agent as unreachable, not as an error', async () => {
    expect(await createRecordingsAgent({}).list()).toBeNull();
  });

  it('treats a refused connection, a timeout and a 401 as unreachable', async () => {
    expect(await createRecordingsAgent({ baseUrl: 'http://127.0.0.1:1', token: 't'.repeat(20) }).list()).toBeNull();

    const slow = await serve(() => {});
    expect(await createRecordingsAgent({ baseUrl: slow, token: 't'.repeat(20), timeoutMs: 50 }).list()).toBeNull();
    server.close();

    const denied = await serve((_req, res) => void ((res.statusCode = 401), res.end()));
    expect(await createRecordingsAgent({ baseUrl: denied, token: 't'.repeat(20) }).list()).toBeNull();
  });

  it('reads peaks, and returns null when there are none', async () => {
    const ok = await serve((_req, res) => res.setHeader('content-type', 'application/json').end('[0.1,0.2]'));
    expect(await createRecordingsAgent({ baseUrl: ok, token: 't'.repeat(20) }).peaks('r 1')).toEqual([0.1, 0.2]);
    expect(seen.url).toBe('/v1/recordings/r%201/peaks');
    server.close();

    const none = await serve((_req, res) => void ((res.statusCode = 404), res.end()));
    expect(await createRecordingsAgent({ baseUrl: none, token: 't'.repeat(20) }).peaks('r1')).toBeNull();
  });

  it('forwards the Range header and returns the raw response so the route can stream it', async () => {
    const baseUrl = await serve((_req, res) => void ((res.statusCode = 206), res.end('0123456789')));
    const upstream = await createRecordingsAgent({ baseUrl, token: 't'.repeat(20) }).preview('r1', 'bytes=0-9');
    expect(upstream?.status).toBe(206);
    expect(await upstream?.text()).toBe('0123456789');
    expect(seen.range).toBe('bytes=0-9');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/api test -- preview-signature recordings-agent`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// api/src/services/preview-signature.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A <video> element cannot send an Authorization header, so the preview route is
 * authenticated by a short-lived signature in its query instead. The signature is
 * issued once per viewing session by a query keyed by recording (like
 * storage.signObject), so the <video src> never changes while it plays.
 */
export const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;

const mac = (ref: string, exp: number, secret: string) =>
  createHmac('sha256', secret).update(`preview:${ref}:${exp}`).digest('hex');

export function signPreview(ref: string, secret: string, nowMs: number): { exp: number; sig: string } {
  const exp = nowMs + PREVIEW_TTL_MS;
  return { exp, sig: mac(ref, exp, secret) };
}

export function verifyPreview(ref: string, exp: number, sig: string, secret: string, nowMs: number): boolean {
  if (!Number.isFinite(exp) || exp < nowMs) return false;
  const expected = Buffer.from(mac(ref, exp, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

```ts
// api/src/services/recordings-agent.ts
import { AGENT_API_PREFIX, type AgentRecording } from '@show-uploader/domain';

/** What the use cases need from the recordings service on the OBS PC. */
export interface RecordingsAgent {
  /** Null when the PC cannot be reached: a normal state, not an error. */
  list(): Promise<AgentRecording[] | null>;
  peaks(ref: string): Promise<number[] | null>;
  /** The raw response, so the route can stream it with Range support. Null when unreachable. */
  preview(ref: string, range: string | undefined, signal?: AbortSignal): Promise<Response | null>;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createRecordingsAgent(o: { baseUrl?: string; token?: string; timeoutMs?: number }): RecordingsAgent {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Every failure to reach the PC collapses to null: it is off, off the tailnet, or
  // misconfigured, and the caller shows "not reachable" for all of them.
  async function call(path: string, init: RequestInit, signal: AbortSignal): Promise<Response | null> {
    if (!o.baseUrl || !o.token) return null;
    try {
      return await fetch(`${o.baseUrl.replace(/\/$/, '')}${AGENT_API_PREFIX}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${o.token}` },
        signal,
      });
    } catch {
      return null;
    }
  }

  return {
    async list() {
      const res = await call('/recordings', {}, AbortSignal.timeout(timeoutMs));
      if (!res?.ok) return null;
      return (await res.json()) as AgentRecording[];
    },
    async peaks(ref) {
      const res = await call(`/recordings/${encodeURIComponent(ref)}/peaks`, {}, AbortSignal.timeout(timeoutMs));
      if (!res?.ok) return null;
      return (await res.json()) as number[];
    },
    // No timeout here: it would cut a stream that is merely long. The route aborts it
    // when the viewer goes away.
    preview(ref, range, signal) {
      return call(
        `/recordings/${encodeURIComponent(ref)}/preview`,
        { headers: range ? { Range: range } : {} },
        signal ?? new AbortController().signal
      );
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @show-uploader/api test -- preview-signature recordings-agent && pnpm --filter @show-uploader/api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat(api): recordings agent adapter and signed preview paths"
```

---

### Task 12: Use cases for listing, cutting and opening cut sessions

Pins Review Focus 1 (deleted recording), 4 (double confirm) at the rule level.

**Files:**
- Create: `api/src/usecases/recording-cuts.ts`, `api/test/usecases/recording-cuts.test.ts`
- Modify: `api/src/ports.ts`, `api/src/adapters.ts`, `api/src/env.ts`, `api/src/queue/index.ts`, `api/test/fakes.ts`

**Interfaces:**
- Consumes: `validateSegments`, `cutFilename`, `AgentRecording`, `UnreachableAgent`, `CutJobPayload`, `CutStep`, `RECORDING_CUTS_QUEUE` (domain); `openUploadSession`, `PART_SIZE` (Task 10); `signPreview` (Task 11).
- Produces:
  - ports: `RecordingsAgent` (re-exported from `services/recordings-agent`), `type CutJobView = { status: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'paused' | 'unknown'; step: CutStep | null; failedReason: string | null } | null`, `interface CutQueue { enqueue(p: CutJobPayload): Promise<void>; job(cutId: string): Promise<CutJobView> }`, `ApiConfig.recordingsSecret: string | null`, `ApiDeps.recordings: RecordingsAgent`, `ApiDeps.cuts: CutQueue`
  - `listRecordings(deps: Pick<ApiDeps, 'recordings'>): Promise<{ reachable: true; recordings: AgentRecording[] } | UnreachableAgent>`
  - `cutIdFor(ref: string, showId: string, startS: number, endS: number): string` (40 hex chars)
  - `startCuts(input: { ref: string; segments: { startS: number; endS: number; showId: string }[] }, deps: Pick<ApiDeps, 'recordings' | 'agenda' | 'cuts'>): Promise<{ cuts: { cutId: string; showId: string }[] }>`
  - `type CutStatus = { state: 'queued' | CutStep | 'done' | 'failed' | 'unknown'; error: string | null }`
  - `deriveCutStatus(job: CutJobView): CutStatus`
  - `cutStatuses(cutIds: string[], deps: Pick<ApiDeps, 'cuts'>): Promise<({ cutId: string } & CutStatus)[]>`
  - `recordingPeaks(ref: string, deps: Pick<ApiDeps, 'recordings'>): Promise<number[]>`
  - `signPreviewPath(ref: string, deps: Pick<ApiDeps, 'recordings' | 'config'>, nowMs?: number): Promise<{ path: string }>`
  - `openCutSession(input: { cutId: string; showId: string; filename: string; size: number; ref: string; startS: number; endS: number }, deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>): Promise<{ sessionId: string; key: string; partSize: number; parts: { n: number; url: string }[]; completed: boolean }>`

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/usecases/recording-cuts.test.ts
import { describe, it, expect } from 'vitest';
import type { AgentRecording } from '@show-uploader/domain';
import { verifyPreview } from '../../src/services/preview-signature';
import { UseCaseError } from '../../src/usecases/errors';
import {
  cutIdFor, cutStatuses, deriveCutStatus, listRecordings, openCutSession, recordingPeaks, signPreviewPath, startCuts,
} from '../../src/usecases/recording-cuts';
import { fakeDeps } from '../fakes';

const rec = (over: Partial<AgentRecording> = {}): AgentRecording => ({
  ref: 'r1', filename: '2026-10-01_20-00-00.mkv', sizeBytes: 1, mtimeMs: 1, durationS: 7200,
  state: 'ready', hasPreview: true, recordedAtMs: Date.parse('2026-10-01T18:00:00Z'), ...over,
});

const shows = [{ id: 'show-a' }, { id: 'show-b' }];
const segs = [
  { startS: 0, endS: 3600, showId: 'show-a' },
  { startS: 3600, endS: 7200, showId: 'show-b' },
];

async function refusal(p: Promise<unknown>): Promise<UseCaseError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(UseCaseError);
  return err as UseCaseError;
}

describe('listRecordings', () => {
  it('reports the recordings when the PC answers and "unreachable" when it does not', async () => {
    expect(await listRecordings(fakeDeps({ recordings: [rec()] }))).toEqual({ reachable: true, recordings: [rec()] });
    expect(await listRecordings(fakeDeps({ recordings: null }))).toEqual({ reachable: false });
  });
});

describe('startCuts', () => {
  it('enqueues one job per segment, named after the recording and the cut', async () => {
    const deps = fakeDeps({ recordings: [rec()], shows });
    const out = await startCuts({ ref: 'r1', segments: segs }, deps);

    expect(out.cuts.map((c) => c.showId)).toEqual(['show-a', 'show-b']);
    expect(deps.cuts.enqueue).toHaveBeenCalledTimes(2);
    expect(deps.cuts.enqueue).toHaveBeenCalledWith({
      cutId: out.cuts[0].cutId, ref: 'r1', showId: 'show-a', startS: 0, endS: 3600,
      filename: '2026-10-01_20-00-00__0h00m00s-1h00m00s.mp4',
    });
  });

  it('a double confirm produces the same cut ids, so the queue sees one job each', async () => {
    const deps = fakeDeps({ recordings: [rec()], shows });
    const a = await startCuts({ ref: 'r1', segments: segs }, deps);
    const b = await startCuts({ ref: 'r1', segments: segs }, deps);
    expect(b.cuts).toEqual(a.cuts);
    expect(cutIdFor('r1', 'show-a', 0, 3600)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses when the PC cannot be reached', async () => {
    const deps = fakeDeps({ recordings: null, shows });
    expect((await refusal(startCuts({ ref: 'r1', segments: segs }, deps))).code).toBe('PRECONDITION_FAILED');
    expect(deps.cuts.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a recording that is no longer on the PC, e.g. deleted by hand', async () => {
    const deps = fakeDeps({ recordings: [], shows });
    const err = await refusal(startCuts({ ref: 'r1', segments: segs }, deps));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toMatch(/deleted/i);
  });

  it('refuses a recording that is still being prepared', async () => {
    const deps = fakeDeps({ recordings: [rec({ state: 'preparing', durationS: null })], shows });
    expect((await refusal(startCuts({ ref: 'r1', segments: segs }, deps))).code).toBe('PRECONDITION_FAILED');
  });

  it('refuses overlapping or out-of-range segments before anything is enqueued', async () => {
    const deps = fakeDeps({ recordings: [rec()], shows });
    const overlap = [{ startS: 0, endS: 4000, showId: 'show-a' }, { startS: 3600, endS: 7200, showId: 'show-b' }];
    expect((await refusal(startCuts({ ref: 'r1', segments: overlap }, deps))).message).toMatch(/overlap/i);
    const tooLong = [{ startS: 0, endS: 9000, showId: 'show-a' }];
    expect((await refusal(startCuts({ ref: 'r1', segments: tooLong }, deps))).message).toMatch(/outside/i);
    expect(deps.cuts.enqueue).not.toHaveBeenCalled();
  });

  it('refuses two segments for one show', async () => {
    const deps = fakeDeps({ recordings: [rec()], shows });
    const twice = [{ startS: 0, endS: 3600, showId: 'show-a' }, { startS: 3600, endS: 7200, showId: 'show-a' }];
    expect((await refusal(startCuts({ ref: 'r1', segments: twice }, deps))).code).toBe('CONFLICT');
  });

  it('is all-or-nothing: one unknown show enqueues nothing', async () => {
    const deps = fakeDeps({ recordings: [rec()], shows: [{ id: 'show-a' }] });
    expect((await refusal(startCuts({ ref: 'r1', segments: segs }, deps))).code).toBe('NOT_FOUND');
    expect(deps.cuts.enqueue).not.toHaveBeenCalled();
  });

  it('refuses an empty request', async () => {
    expect((await refusal(startCuts({ ref: 'r1', segments: [] }, fakeDeps({ recordings: [rec()] })))).code).toBe('PRECONDITION_FAILED');
  });
});

describe('deriveCutStatus', () => {
  const job = (status: string, extra: object = {}) => ({ status, step: null, failedReason: null, ...extra }) as never;

  it('maps queue states to what the operator sees', () => {
    expect(deriveCutStatus(null)).toEqual({ state: 'unknown', error: null });
    expect(deriveCutStatus(job('waiting'))).toEqual({ state: 'queued', error: null });
    expect(deriveCutStatus(job('delayed'))).toEqual({ state: 'queued', error: null });
    expect(deriveCutStatus(job('active'))).toEqual({ state: 'cutting', error: null });
    expect(deriveCutStatus(job('active', { step: 'uploading' }))).toEqual({ state: 'uploading', error: null });
    expect(deriveCutStatus(job('completed'))).toEqual({ state: 'done', error: null });
    expect(deriveCutStatus(job('failed', { failedReason: 'The recording was deleted from the PC' }))).toEqual({
      state: 'failed', error: 'The recording was deleted from the PC',
    });
  });

  it('cutStatuses answers per id', async () => {
    const deps = fakeDeps();
    deps.cuts.job.mockResolvedValueOnce(job('completed')).mockResolvedValueOnce(null);
    expect(await cutStatuses(['a', 'b'], deps)).toEqual([
      { cutId: 'a', state: 'done', error: null },
      { cutId: 'b', state: 'unknown', error: null },
    ]);
  });
});

describe('peaks and preview signing', () => {
  it('returns peaks, or refuses when there are none yet', async () => {
    expect(await recordingPeaks('r1', fakeDeps({ recordings: [rec()] }))).toEqual([0.1]);
    const deps = fakeDeps({ recordings: [rec()] });
    deps.recordings.peaks.mockResolvedValueOnce(null);
    expect((await refusal(recordingPeaks('r1', deps))).code).toBe('NOT_FOUND');
  });

  it('signs a preview path only for a recording the PC itself listed', async () => {
    const deps = fakeDeps({ recordings: [rec()], recordingsSecret: 's'.repeat(24) });
    const { path } = await signPreviewPath('r1', deps, 1_800_000_000_000);
    const url = new URL(path, 'https://x.test');
    expect(url.pathname).toBe('/api/recordings/preview/r1');
    expect(verifyPreview('r1', Number(url.searchParams.get('exp')), url.searchParams.get('sig')!, 's'.repeat(24), 1_800_000_000_000)).toBe(true);

    expect((await refusal(signPreviewPath('ghost', deps))).code).toBe('NOT_FOUND');
  });

  it('refuses to sign when recordings are not configured or the PC is unreachable', async () => {
    expect((await refusal(signPreviewPath('r1', fakeDeps({ recordings: [rec()], recordingsSecret: null })))).code).toBe('PRECONDITION_FAILED');
    expect((await refusal(signPreviewPath('r1', fakeDeps({ recordings: null, recordingsSecret: 's'.repeat(24) })))).code).toBe('PRECONDITION_FAILED');
  });
});

describe('openCutSession', () => {
  const input = {
    cutId: 'c'.repeat(40), showId: 'show-a', filename: 'night__0h00m00s-1h00m00s.mp4',
    size: 40 * 1024 * 1024, ref: 'r1', startS: 0, endS: 3600,
  };

  it('opens a session bound to the show with a presigned URL for every part', async () => {
    const deps = fakeDeps({ shows });
    const out = await openCutSession(input, deps);
    expect(out.completed).toBe(false);
    expect(out.parts.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(out.parts[0].url).toContain('part=1');
    expect(deps.sessionRows.get(out.sessionId)).toMatchObject({ show_id: 'show-a', cut_id: input.cutId });
  });

  it('a retried request reuses the open session instead of starting a second S3 upload', async () => {
    const deps = fakeDeps({ shows });
    const a = await openCutSession(input, deps);
    const b = await openCutSession(input, deps);
    expect(b.sessionId).toBe(a.sessionId);
    expect(deps.objects.createMultipart).toHaveBeenCalledTimes(1);
  });

  it('says so when the cut was already completed, so the worker can stop', async () => {
    const deps = fakeDeps({ shows });
    const a = await openCutSession(input, deps);
    deps.sessionRows.get(a.sessionId)!.status = 'completed';
    expect(await openCutSession(input, deps)).toMatchObject({ sessionId: a.sessionId, completed: true, parts: [] });
  });

  it('refuses a show that does not exist', async () => {
    expect((await refusal(openCutSession(input, fakeDeps()))).code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Extend ports, env, queue, adapters and fakes**

`api/src/ports.ts`: add imports `import type { CutJobPayload, CutStep } from '@show-uploader/domain';` and `import type { RecordingsAgent } from './services/recordings-agent';`, then add:

```ts
export type { RecordingsAgent };

/** The queue view of one cut. */
export type CutJobView = {
  status: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'paused' | 'unknown';
  step: CutStep | null;
  failedReason: string | null;
} | null;

/** The queue the worker's cut-recording job runs from. */
export interface CutQueue {
  /** Idempotent per cutId: enqueueing a cut that is waiting or running changes nothing. */
  enqueue(payload: CutJobPayload): Promise<void>;
  /** The cut's job state, or null when there is none. */
  job(cutId: string): Promise<CutJobView>;
}
```

Add `recordingsSecret: string | null;` to `ApiConfig` (doc: "Signs preview paths; the agent token."), and `recordings: RecordingsAgent; cuts: CutQueue;` to `ApiDeps`.

`api/src/env.ts`, inside the zod object, after `JINGLE_S3_KEY`:

```ts
  // The recordings service on the OBS PC, reached over Tailscale. Both unset means the
  // feature is off: the Recordings page shows "OBS PC not reachable".
  RECORDINGS_AGENT_URL: z.string().url().optional(),
  RECORDINGS_AGENT_TOKEN: z.string().min(16).optional(),
```

`api/src/queue/index.ts`: add `import { RECORDING_CUTS_QUEUE, type CutJobPayload } from '@show-uploader/domain';` and

```ts
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
```

`api/src/adapters.ts`: import `recordingCutQueue` with the other queue imports, `createRecordingsAgent` from `./services/recordings-agent`, and add to the returned object (before `config`):

```ts
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
```

and change the `config:` line to `config: { jingleS3Key: env.JINGLE_S3_KEY ?? null, recordingsSecret: env.RECORDINGS_AGENT_TOKEN ?? null },` (import `CutStep` from the domain package and `CutJobView` from `./ports`).

`api/test/fakes.ts`: add `import type { AgentRecording } from '@show-uploader/domain';`; extend the options type with `recordings?: AgentRecording[] | null; recordingsSecret?: string | null;`; add before `presence: { broadcastClaims: vi.fn() },`:

```ts
    recordings: {
      list: vi.fn(async () => (opts.recordings === undefined ? [] : opts.recordings)),
      peaks: vi.fn(async (_ref: string) => [0.1] as number[] | null),
      preview: vi.fn(async (_ref: string, _range: string | undefined, _signal?: AbortSignal) => null as Response | null),
    },
    cuts: {
      enqueue: vi.fn(async (payload: unknown) => void queued.push({ kind: 'cut', payload })),
      job: vi.fn(async (_cutId: string) => null as import('../src/ports').CutJobView),
    },
```

and change the `config` line to `config: { jingleS3Key: opts.jingleS3Key ?? null, recordingsSecret: opts.recordingsSecret === undefined ? 's'.repeat(24) : opts.recordingsSecret },`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @show-uploader/api test -- recording-cuts`
Expected: FAIL, cannot find `../../src/usecases/recording-cuts`.

- [ ] **Step 4: Implement**

```ts
// api/src/usecases/recording-cuts.ts
import { createHash } from 'node:crypto';
import {
  cutFilename, validateSegments,
  type AgentRecording, type CutStep, type UnreachableAgent,
} from '@show-uploader/domain';
import type { ApiDeps, CutJobView } from '../ports';
import { signPreview } from '../services/preview-signature';
import { UseCaseError } from './errors';
import { openUploadSession } from './uploads';

export async function listRecordings({ recordings }: Pick<ApiDeps, 'recordings'>) {
  const list = await recordings.list();
  return list ? ({ reachable: true, recordings: list } as { reachable: true; recordings: AgentRecording[] }) : ({ reachable: false } as UnreachableAgent);
}

/**
 * Deterministic from what is being cut, so a double confirm is the same job. It is also
 * the BullMQ job id (no colons) and the PC's cut id (A-Z a-z 0-9 _ -).
 */
export function cutIdFor(ref: string, showId: string, startS: number, endS: number): string {
  const r = (n: number) => n.toFixed(3);
  return createHash('sha1').update(`${ref}|${showId}|${r(startS)}|${r(endS)}`).digest('hex');
}

type SegmentInput = { startS: number; endS: number; showId: string };

export async function startCuts(
  input: { ref: string; segments: SegmentInput[] },
  { recordings, agenda, cuts }: Pick<ApiDeps, 'recordings' | 'agenda' | 'cuts'>
) {
  if (input.segments.length === 0) throw new UseCaseError('PRECONDITION_FAILED', 'Nothing to cut');

  const list = await recordings.list();
  if (!list) throw new UseCaseError('PRECONDITION_FAILED', 'The OBS PC is not reachable');
  const recording = list.find((r) => r.ref === input.ref);
  // The operator may delete a recording at any time; that is not a bug, just a fact.
  if (!recording) throw new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC (it may have been deleted)');
  if (recording.state !== 'ready' || recording.durationS === null) {
    throw new UseCaseError('PRECONDITION_FAILED', 'The recording is still being prepared');
  }

  const problems = validateSegments(input.segments, recording.durationS);
  if (problems.length > 0) {
    throw new UseCaseError('PRECONDITION_FAILED', `Segment ${problems[0].index + 1}: ${problems[0].message}`);
  }

  const showIds = input.segments.map((s) => s.showId);
  if (new Set(showIds).size !== showIds.length) {
    throw new UseCaseError('CONFLICT', 'Each show can only receive one segment');
  }
  for (const showId of showIds) {
    if (!(await agenda.getShow(showId))) throw new UseCaseError('NOT_FOUND', `Show ${showId} was not found`);
  }

  // Everything is validated above, so either every segment is queued or none is.
  const out: { cutId: string; showId: string }[] = [];
  for (const seg of input.segments) {
    const cutId = cutIdFor(input.ref, seg.showId, seg.startS, seg.endS);
    await cuts.enqueue({
      cutId, ref: input.ref, showId: seg.showId, startS: seg.startS, endS: seg.endS,
      filename: cutFilename(recording.filename, seg.startS, seg.endS),
    });
    out.push({ cutId, showId: seg.showId });
  }
  return { cuts: out };
}

export type CutStatus = { state: 'queued' | CutStep | 'done' | 'failed' | 'unknown'; error: string | null };

/** What the operator sees for a cut, from the queue's view of it. Pure so it tests without Redis. */
export function deriveCutStatus(job: CutJobView): CutStatus {
  if (!job) return { state: 'unknown', error: null };
  switch (job.status) {
    case 'completed':
      return { state: 'done', error: null };
    case 'failed':
      return { state: 'failed', error: job.failedReason ?? 'The cut failed' };
    case 'active':
      return { state: job.step ?? 'cutting', error: null };
    default:
      return { state: 'queued', error: null };
  }
}

export async function cutStatuses(cutIds: string[], { cuts }: Pick<ApiDeps, 'cuts'>) {
  return Promise.all(cutIds.map(async (cutId) => ({ cutId, ...deriveCutStatus(await cuts.job(cutId)) })));
}

export async function recordingPeaks(ref: string, { recordings }: Pick<ApiDeps, 'recordings'>): Promise<number[]> {
  const peaks = await recordings.peaks(ref);
  if (!peaks) throw new UseCaseError('NOT_FOUND', 'No waveform for this recording yet');
  return peaks;
}

/**
 * A path the browser can hand to <video>. Only for a recording the PC itself listed, so a
 * caller-supplied ref can never become an arbitrary request to the PC.
 */
export async function signPreviewPath(
  ref: string,
  { recordings, config }: Pick<ApiDeps, 'recordings' | 'config'>,
  nowMs: number = Date.now()
): Promise<{ path: string }> {
  if (!config.recordingsSecret) throw new UseCaseError('PRECONDITION_FAILED', 'Recordings are not configured');
  const list = await recordings.list();
  if (!list) throw new UseCaseError('PRECONDITION_FAILED', 'The OBS PC is not reachable');
  if (!list.some((r) => r.ref === ref)) throw new UseCaseError('NOT_FOUND', 'Recording not found');
  const { exp, sig } = signPreview(ref, config.recordingsSecret, nowMs);
  return { path: `/api/recordings/preview/${encodeURIComponent(ref)}?exp=${exp}&sig=${sig}` };
}

export type OpenCutSessionInput = {
  cutId: string; showId: string; filename: string; size: number; ref: string; startS: number; endS: number;
};

/**
 * The worker's step 2: an upload session for a cut that now exists on the PC, with a
 * presigned URL for every part. Idempotent per cut: a retried job gets the same session
 * back (parts that already landed stay landed), and a cut already completed says so.
 */
export async function openCutSession(input: OpenCutSessionInput, deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>) {
  if (!(await deps.agenda.getShow(input.showId))) throw new UseCaseError('NOT_FOUND', `Show ${input.showId} was not found`);

  const existing = await deps.sessions.findByCutId(input.cutId);
  if (existing?.status === 'completed') {
    return { sessionId: existing.id, key: existing.s3_key, partSize: existing.part_size, parts: [], completed: true };
  }

  const open = existing
    ? { sessionId: existing.id, key: existing.s3_key, partSize: existing.part_size, size: Number(existing.size_bytes), s3UploadId: existing.s3_upload_id }
    : await openUploadSession(
        {
          filename: input.filename, contentType: 'video/mp4', size: input.size, showId: input.showId,
          cut: { cutId: input.cutId, ref: input.ref, startS: input.startS, endS: input.endS },
        },
        deps
      ).then(async (o) => ({ ...o, size: input.size, s3UploadId: (await deps.sessions.get(o.sessionId))!.s3_upload_id }));

  const partCount = Math.max(1, Math.ceil(open.size / open.partSize));
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, i) => ({ n: i + 1, url: await deps.objects.presignPart(open.key, open.s3UploadId, i + 1) }))
  );
  return { sessionId: open.sessionId, key: open.key, partSize: open.partSize, parts, completed: false };
}
```

- [ ] **Step 5: Run to verify pass, then typecheck**

Run: `pnpm --filter @show-uploader/api test && pnpm --filter @show-uploader/api exec tsc --noEmit`
Expected: PASS, no type errors. If the `.then(async …)` branch in `openCutSession` reads awkwardly to you, replace it with two plain statements; behavior and tests are unchanged.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "feat(api): use cases to list, cut and open sessions for OBS recordings

Idempotent per cut; deleted recordings are refused with a plain message."
```

---

### Task 13: API surface — tRPC router, signed preview route, internal worker endpoints

**Files:**
- Create: `api/src/trpc/routers/recordings.ts`, `api/src/routes/recordings.ts`, `api/test/routes/recordings.test.ts`, `api/test/trpc/recordings-router.test.ts`
- Modify: `api/src/trpc/root.ts`, `api/src/app.ts`

**Interfaces:**
- Consumes: Task 12 use cases; `sendFailure` (Task 10); `verifyPreview` (Task 11); `completeUpload`, `abortUpload` (Task 10).
- Produces:
  - tRPC `recordings.list` (query), `recordings.peaks({ref})`, `recordings.signPreview({ref})` (query), `recordings.startCuts({ref, segments})` (mutation), `recordings.cutStatuses({cutIds})` (query)
  - `createPreviewRouter(deps: Pick<ApiDeps, 'recordings' | 'config'>, now?: () => number): Router` → `GET /preview/:ref?exp&sig`
  - `createInternalRecordingsRouter(deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>, apiKey: string): Router` → `POST /cuts/:cutId/session`, `POST /sessions/:sessionId/complete`, `POST /sessions/:sessionId/abort` (bearer `WATCHER_API_KEY`)

- [ ] **Step 1: Write the failing route tests**

```ts
// api/test/routes/recordings.test.ts
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalRecordingsRouter, createPreviewRouter } from '../../src/routes/recordings';
import { signPreview } from '../../src/services/preview-signature';
import { fakeDeps } from '../fakes';

const SECRET = 's'.repeat(24);
const NOW = 1_800_000_000_000;
let server: ReturnType<express.Express['listen']>;

async function serve(mount: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  mount(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => server?.close());

describe('preview route', () => {
  const url = (base: string, ref: string, exp: number, sig: string) => `${base}/preview/${ref}?exp=${exp}&sig=${sig}`;

  it('streams the agent\'s ranged response through, with its headers', async () => {
    const deps = fakeDeps({ recordingsSecret: SECRET });
    deps.recordings.preview.mockResolvedValue(
      new Response('0123456789', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes' } })
    );
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    const { exp, sig } = signPreview('r1', SECRET, NOW);

    const res = await fetch(url(base, 'r1', exp, sig), { headers: { Range: 'bytes=0-9' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
    expect(await res.text()).toBe('0123456789');
    expect(deps.recordings.preview).toHaveBeenCalledWith('r1', 'bytes=0-9', expect.anything());
  });

  it('answers 403 without calling the PC for a missing, expired or tampered signature', async () => {
    const deps = fakeDeps({ recordingsSecret: SECRET });
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    const { exp, sig } = signPreview('r1', SECRET, NOW);

    expect((await fetch(`${base}/preview/r1`)).status).toBe(403);
    expect((await fetch(url(base, 'r1', exp, 'bad'))).status).toBe(403);
    expect((await fetch(url(base, 'r2', exp, sig))).status).toBe(403);
    const old = signPreview('r1', SECRET, NOW - 7 * 3600_000);
    expect((await fetch(url(base, 'r1', old.exp, old.sig))).status).toBe(403);
    expect(deps.recordings.preview).not.toHaveBeenCalled();
  });

  it('answers 403 when recordings are not configured, and 502 when the PC is unreachable', async () => {
    const off = fakeDeps({ recordingsSecret: null });
    const baseOff = await serve((a) => a.use(createPreviewRouter(off, () => NOW)));
    const { exp, sig } = signPreview('r1', SECRET, NOW);
    expect((await fetch(url(baseOff, 'r1', exp, sig))).status).toBe(403);
    server.close();

    const deps = fakeDeps({ recordingsSecret: SECRET }); // preview() resolves null
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    expect((await fetch(url(base, 'r1', exp, sig))).status).toBe(502);
  });
});

describe('internal worker endpoints', () => {
  const KEY = 'internal-key';
  const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const open = { showId: 'show-a', filename: 'night.mp4', size: 40 * 1024 * 1024, ref: 'r1', startS: 0, endS: 60 };

  it('rejects calls without the shared key', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-a' }] });
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));
    const res = await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(open) });
    expect(res.status).toBe(401);
    expect(deps.objects.createMultipart).not.toHaveBeenCalled();
  });

  it('opens, completes and aborts a cut session', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-a' }] });
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));

    const opened = await (await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify(open) })).json();
    expect(opened.parts).toHaveLength(3);

    const done = await fetch(`${base}/internal/sessions/${opened.sessionId}/complete`, { method: 'POST', headers: auth });
    expect(done.status).toBe(200);
    expect(deps.staged.get('show-a')?.filename).toBe('night.mp4');

    const gone = await fetch(`${base}/internal/sessions/nope/complete`, { method: 'POST', headers: auth });
    expect(gone.status).toBe(404);
  });

  it('maps a refused rule to its status and validates the body', async () => {
    const deps = fakeDeps(); // no such show
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));
    expect((await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify(open) })).status).toBe(404);
    expect((await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify({ showId: 'x' }) })).status).toBe(400);
  });
});
```

```ts
// api/test/trpc/recordings-router.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/auth/verify-token', () => ({ verifyToken: vi.fn() }));
vi.mock('../../src/env', () => ({ env: {} }));
vi.mock('../../src/deps', () => ({ deps: {} }));
vi.mock('../../src/usecases/recording-cuts', () => ({
  listRecordings: vi.fn(), recordingPeaks: vi.fn(), signPreviewPath: vi.fn(), startCuts: vi.fn(), cutStatuses: vi.fn(),
}));

import { TRPCError } from '@trpc/server';
import { recordingsRouter } from '../../src/trpc/routers/recordings';
import { UseCaseError } from '../../src/usecases/errors';
import { startCuts } from '../../src/usecases/recording-cuts';

const caller = recordingsRouter.createCaller({ user: { sub: 'u', name: 'Operator' }, authStatus: null, headers: {} });
const input = { ref: 'r1', segments: [{ startS: 0, endS: 60, showId: 's1' }] };

beforeEach(() => vi.clearAllMocks());

describe('recordings router', () => {
  it('maps a refused rule to its tRPC code and keeps the message', async () => {
    vi.mocked(startCuts).mockRejectedValue(new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC'));
    const err = await caller.startCuts(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
    expect((err as TRPCError).message).toMatch(/no longer/);
  });

  it('validates input before reaching the use case', async () => {
    await expect(caller.startCuts({ ref: '', segments: [] })).rejects.toThrow();
    await expect(caller.startCuts({ ref: 'r', segments: [{ startS: Number.NaN, endS: 1, showId: 's' }] })).rejects.toThrow();
    expect(startCuts).not.toHaveBeenCalled();
  });

  it('refuses anonymous callers', async () => {
    const anon = recordingsRouter.createCaller({ user: null, authStatus: 401, headers: {} });
    await expect(anon.list()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @show-uploader/api test -- recordings`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the REST routers**

```ts
// api/src/routes/recordings.ts
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router } from 'express';
import { z } from 'zod';
import type { ApiDeps } from '../ports';
import { verifyPreview } from '../services/preview-signature';
import { openCutSession } from '../usecases/recording-cuts';
import { abortUpload, completeUpload } from '../usecases/uploads';
import { sendFailure } from './respond';

const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Streams a recording's preview from the OBS PC. Authenticated by the signature in the
 * query, not by a session: a <video> element cannot send an Authorization header. The
 * signature is issued by `recordings.signPreview` and bound to one recording.
 */
export function createPreviewRouter(deps: Pick<ApiDeps, 'recordings' | 'config'>, now: () => number = Date.now): Router {
  const router = Router();

  router.get('/preview/:ref', async (req, res) => {
    const secret = deps.config.recordingsSecret;
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    if (!secret || !verifyPreview(req.params.ref, exp, sig, secret, now())) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }

    // Stop pulling from the PC the moment the viewer goes away (seeking cancels requests).
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const upstream = await deps.recordings.preview(req.params.ref, req.headers.range, abort.signal);
    if (!upstream) return res.status(502).json({ error: 'The OBS PC is not reachable' });

    res.status(upstream.status);
    for (const name of PASS_THROUGH) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) return res.end();
    const body = Readable.fromWeb(upstream.body as never);
    body.on('error', () => res.destroy());
    body.pipe(res);
  });

  return router;
}

const OpenBody = z.object({
  showId: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().positive(),
  ref: z.string().min(1),
  startS: z.number().finite(),
  endS: z.number().finite(),
});

function keyMatches(header: string | undefined, key: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * What the worker's cut-recording job calls. Gated by the shared internal key, like the
 * worker's other write-backs, so the PC and the browser never need it.
 */
export function createInternalRecordingsRouter(deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>, apiKey: string): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (keyMatches(req.headers.authorization, apiKey)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  });

  router.post('/cuts/:cutId/session', async (req, res) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await openCutSession({ cutId: req.params.cutId, ...body.data }, deps));
    } catch (err) {
      sendFailure(res, err, 'open cut session failed:', 'Failed to open the upload session');
    }
  });

  router.post('/sessions/:sessionId/complete', async (req, res) => {
    try {
      res.json(await completeUpload(req.params.sessionId, deps));
    } catch (err) {
      sendFailure(res, err, 'complete cut session failed:', 'Failed to complete the upload');
    }
  });

  router.post('/sessions/:sessionId/abort', async (req, res) => {
    try {
      await abortUpload(req.params.sessionId, deps);
      res.json({ ok: true });
    } catch (err) {
      sendFailure(res, err, 'abort cut session failed:', 'Failed to abort the upload');
    }
  });

  return router;
}
```

- [ ] **Step 4: Implement the tRPC router and mount everything**

```ts
// api/src/trpc/routers/recordings.ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { deps } from '../../deps';
import { UseCaseError } from '../../usecases/errors';
import { cutStatuses, listRecordings, recordingPeaks, signPreviewPath, startCuts } from '../../usecases/recording-cuts';
import { protectedProcedure, router } from '../trpc';

// Validation and error mapping only. The rules live in usecases/recording-cuts.ts.
function refuse(err: unknown): never {
  if (err instanceof UseCaseError) throw new TRPCError({ code: err.code, message: err.message });
  throw err;
}

const Ref = z.object({ ref: z.string().min(1) });

const Segment = z.object({
  startS: z.number().finite(),
  endS: z.number().finite(),
  showId: z.string().min(1),
});

export const recordingsRouter = router({
  /** Recordings on the OBS PC, or `{ reachable: false }`. */
  list: protectedProcedure.query(() => listRecordings(deps)),

  peaks: protectedProcedure.input(Ref).query(async ({ input }) => {
    try {
      return await recordingPeaks(input.ref, deps);
    } catch (err) {
      refuse(err);
    }
  }),

  // Keyed by recording, so the client signs once per viewing session and the <video src>
  // never swaps while it plays (see AGENTS.md: no signed URLs in polled responses).
  signPreview: protectedProcedure.input(Ref).query(async ({ input }) => {
    try {
      return await signPreviewPath(input.ref, deps);
    } catch (err) {
      refuse(err);
    }
  }),

  startCuts: protectedProcedure
    .input(z.object({ ref: z.string().min(1), segments: z.array(Segment).min(1).max(20) }))
    .mutation(async ({ input }) => {
      try {
        return await startCuts(input, deps);
      } catch (err) {
        refuse(err);
      }
    }),

  cutStatuses: protectedProcedure
    .input(z.object({ cutIds: z.array(z.string().min(1)).max(50) }))
    .query(({ input }) => cutStatuses(input.cutIds, deps)),
});
```

`api/src/trpc/root.ts`: add `import { recordingsRouter } from './routers/recordings';` and `recordings: recordingsRouter,` inside `appRouter`.

`api/src/app.ts`: add imports `import { deps } from './deps';`, `import { env } from './env';`, `import { createInternalRecordingsRouter, createPreviewRouter } from './routes/recordings';` and, directly after the `app.use('/api/watcher', watcherRouter);` line:

```ts
  // The worker's cut-recording job (shared internal key, like the watcher routes) …
  app.use('/api/internal/recordings', createInternalRecordingsRouter(deps, env.WATCHER_API_KEY));
  // … and the OBS PC preview stream, authenticated by a signature in its query because
  // a <video> element cannot send an Authorization header.
  app.use('/api/recordings', createPreviewRouter(deps));
```

- [ ] **Step 5: Run everything**

Run: `pnpm --filter @show-uploader/api test && pnpm --filter @show-uploader/api exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add api
git commit -m "feat(api): recordings router, signed preview stream, internal worker endpoints"
```

### Task 14: Worker job `cut-recording`

The worker drives one cut at a time through the PC and the api. It owns the long waiting; the PC only answers requests and the api owns completion. Pins Review Focus 1, 4 and 5.

**Files:**
- Create: `worker/src/jobs/cut-recording.ts`, `worker/src/services/recordings-agent.ts`, `worker/src/services/upload-sessions.ts`, `worker/test/jobs/cut-recording.test.ts`, `worker/test/services/agent-clients.test.ts`
- Modify: `worker/src/ports.ts`, `worker/src/adapters.ts`, `worker/src/env.ts`, `worker/src/index.ts`, `worker/test/fakes.ts`

**Interfaces:**
- Consumes: `AgentCut`, `CutRequest`, `UploadRequest`, `CutJobPayload`, `CutStep`, `RECORDING_CUTS_QUEUE`, `AGENT_API_PREFIX` (domain).
- Produces:
  - ports `RecordingsAgent { startCut(req: CutRequest): Promise<AgentCut>; cut(cutId: string): Promise<AgentCut | null>; upload(cutId: string, req: UploadRequest): Promise<AgentCut>; drop(cutId: string): Promise<void> }`
  - ports `UploadSessions { open(input: { cutId: string; showId: string; filename: string; size: number; ref: string; startS: number; endS: number }): Promise<{ sessionId: string; partSize: number; parts: { n: number; url: string }[]; completed: boolean }>; complete(sessionId: string): Promise<void>; abort(sessionId: string): Promise<void> }`
  - `WorkerConfig.cutPoll: { intervalMs: number; cutTimeoutMs: number; uploadTimeoutMs: number }`
  - `WorkerDeps.agent: RecordingsAgent`, `WorkerDeps.sessions: UploadSessions`
  - `processCutRecording(job: Job<CutJobPayload>, deps: Pick<WorkerDeps, 'agent' | 'sessions' | 'config'>, opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<string>` — returns the staged filename.
  - `createRecordingsAgent(o: { baseUrl?: string; token?: string }): RecordingsAgent`, `createUploadSessions(o: { baseUrl: string; apiKey: string }): UploadSessions`

- [ ] **Step 1: Extend the worker ports, env and fakes**

`worker/src/ports.ts`: add `import type { AgentCut, CutRequest, UploadRequest } from '@show-uploader/domain';` and

```ts
/** The recordings service on the OBS PC, reached over Tailscale. */
export interface RecordingsAgent {
  /** Start a cut. Idempotent per cutId; a deleted recording comes back as `source_gone`. */
  startCut(req: CutRequest): Promise<AgentCut>;
  /** The cut's state, or null when the PC has no record of it. */
  cut(cutId: string): Promise<AgentCut | null>;
  /** Have the PC upload the cut to these presigned part URLs (resumes finished parts). */
  upload(cutId: string, req: UploadRequest): Promise<AgentCut>;
  /** Drop the PC's staging file and record. Never throws. */
  drop(cutId: string): Promise<void>;
}

/** The api's upload sessions for cuts. The api owns completion; the worker only asks. */
export interface UploadSessions {
  /** Idempotent per cut: a retried job gets the same session back. */
  open(input: {
    cutId: string; showId: string; filename: string; size: number; ref: string; startS: number; endS: number;
  }): Promise<{ sessionId: string; partSize: number; parts: { n: number; url: string }[]; completed: boolean }>;
  complete(sessionId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}
```

Change `WorkerConfig` to:

```ts
export type WorkerConfig = {
  /** Public origin of this app, for permanent archive links. Null disables them. */
  appPublicUrl: string | null;
  /** How the cut-recording job waits on the PC. */
  cutPoll: { intervalMs: number; cutTimeoutMs: number; uploadTimeoutMs: number };
};
```

and add `agent: RecordingsAgent; sessions: UploadSessions;` to `WorkerDeps`.

`worker/src/env.ts`, inside the zod object after `WATCHER_API_KEY`:

```ts
  // The recordings service on the OBS PC (Tailscale). Unset means cut jobs fail with a
  // clear "not configured" message instead of hanging.
  RECORDINGS_AGENT_URL: z.string().url().optional(),
  RECORDINGS_AGENT_TOKEN: z.string().min(16).optional(),
  CUT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  // A cut is a stream copy (seconds); an upload is bound by the PC's uplink, and its
  // presigned part URLs live six hours.
  CUT_WAIT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  UPLOAD_WAIT_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
```

`worker/test/fakes.ts`: add `import type { AgentCut } from '@show-uploader/domain';`; after `const upload = ...` add `const pcCuts = new Map<string, AgentCut>();`; add to the `deps` object (before `config:`):

```ts
    // A PC that does what it is asked, instantly. Tests script deviations with
    // mockResolvedValueOnce / mockImplementation on these.
    agent: {
      startCut: vi.fn(async (r: { cutId: string }): Promise<AgentCut> => {
        const c: AgentCut = { cutId: r.cutId, state: 'cut', sizeBytes: 40, etags: null, reason: null };
        pcCuts.set(r.cutId, c);
        return c;
      }),
      cut: vi.fn(async (id: string) => pcCuts.get(id) ?? null),
      upload: vi.fn(async (id: string): Promise<AgentCut> => {
        const c: AgentCut = { ...pcCuts.get(id)!, state: 'done', etags: [{ n: 1, etag: '"e"' }] };
        pcCuts.set(id, c);
        return c;
      }),
      drop: vi.fn(async (id: string) => void pcCuts.delete(id)),
    },
    sessions: {
      open: vi.fn(async (_i: { size: number }) => ({
        sessionId: 'sess-1',
        partSize: 16,
        parts: [1, 2, 3].map((n) => ({ n, url: `https://s3.test/part/${n}` })),
        completed: false,
      })),
      complete: vi.fn(async (_id: string) => {}),
      abort: vi.fn(async (_id: string) => {}),
    },
```

change the `config:` line to:

```ts
    config: {
      appPublicUrl: opts.appPublicUrl === undefined ? 'https://uploader.test' : opts.appPublicUrl,
      cutPoll: { intervalMs: 1, cutTimeoutMs: 1000, uploadTimeoutMs: 1000 },
    },
```

and replace `fakeJob` with:

```ts
/** A BullMQ job as the jobs read it: payload, a progress sink, and the retry counters. */
export function fakeJob<T>(data: T, id = 'bull-1', extra: { attempts?: number; attemptsMade?: number } = {}) {
  return {
    id,
    data,
    updateProgress: vi.fn(async () => {}),
    opts: { attempts: extra.attempts ?? 3 },
    attemptsMade: extra.attemptsMade ?? 0,
  } as never;
}
```

- [ ] **Step 2: Write the failing job tests**

```ts
// worker/test/jobs/cut-recording.test.ts
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCut } from '@show-uploader/domain';
import { processCutRecording } from '../../src/jobs/cut-recording';
import { fakeDeps, fakeJob } from '../fakes';

const payload = { cutId: 'c'.repeat(40), ref: 'r1', filename: 'night__0h00m00s-1h00m00s.mp4', showId: 'show-1', startS: 0, endS: 3600 };
const cut = (over: Partial<AgentCut> = {}): AgentCut => ({ cutId: payload.cutId, state: 'cut', sizeBytes: 40, etags: null, reason: null, ...over });
const run = (deps: ReturnType<typeof fakeDeps>, job = fakeJob(payload), now?: () => number) =>
  processCutRecording(job, deps, { sleep: async () => {}, now });
const order = (...fns: { mock: { invocationCallOrder: number[] } }[]) => fns.map((f) => f.mock.invocationCallOrder[0]);

describe('processCutRecording', () => {
  it('cuts on the PC, opens a session with the real size, uploads, completes, then cleans up the PC', async () => {
    const deps = fakeDeps();
    const job = fakeJob(payload);

    await expect(run(deps, job)).resolves.toBe(payload.filename);

    expect(deps.agent.startCut).toHaveBeenCalledWith({ cutId: payload.cutId, ref: 'r1', startS: 0, endS: 3600 });
    expect(deps.sessions.open).toHaveBeenCalledWith(expect.objectContaining({ cutId: payload.cutId, showId: 'show-1', size: 40, ref: 'r1' }));
    expect(deps.agent.upload).toHaveBeenCalledWith(payload.cutId, { partSize: 16, parts: expect.arrayContaining([{ n: 1, url: 'https://s3.test/part/1' }]) });
    const o = order(deps.agent.startCut, deps.sessions.open, deps.agent.upload, deps.sessions.complete, deps.agent.drop);
    expect([...o].sort((a, b) => a - b)).toEqual(o);
    expect(vi.mocked(job.updateProgress).mock.calls.map(([p]) => (p as { step: string }).step)).toEqual(['cutting', 'uploading', 'finishing']);
  });

  it('waits for a cut that is still running', async () => {
    const deps = fakeDeps();
    deps.agent.startCut.mockResolvedValueOnce(cut({ state: 'cutting', sizeBytes: null }));
    deps.agent.cut
      .mockResolvedValueOnce(null) // first lookup: nothing yet, so the job starts it
      .mockResolvedValueOnce(cut()); // after one poll the cut is ready
    const sleep = vi.fn(async () => {});
    await processCutRecording(fakeJob(payload), deps, { sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(deps.sessions.open).toHaveBeenCalledWith(expect.objectContaining({ size: 40 }));
  });

  // Review focus: the operator deleted the recording by hand before the cut ran.
  it('a recording deleted from the PC is permanent: no retry, no session, no abort', async () => {
    const deps = fakeDeps();
    deps.agent.startCut.mockResolvedValueOnce(cut({ state: 'source_gone', sizeBytes: null, reason: 'The recording was deleted from the PC' }));
    const err = await run(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/deleted/);
    expect(deps.sessions.open).not.toHaveBeenCalled();
    expect(deps.sessions.abort).not.toHaveBeenCalled();
  });

  it('a cut that failed on the PC is an ordinary, retryable failure with the PC\'s reason', async () => {
    const deps = fakeDeps();
    deps.agent.startCut.mockResolvedValueOnce(cut({ state: 'failed', sizeBytes: null, reason: 'disk full' }));
    await expect(run(deps)).rejects.toThrow('disk full');
    expect(deps.sessions.open).not.toHaveBeenCalled();
  });

  // Review focus: a retry must not re-cut and re-send parts that already landed.
  it('on a retry the PC\'s finished cut is reused: no new cut, the upload resumes', async () => {
    const deps = fakeDeps();
    deps.agent.cut.mockResolvedValueOnce(cut({ state: 'failed', sizeBytes: 40, reason: 'part upload gave up' }));
    await run(deps, fakeJob(payload, 'bull-1', { attemptsMade: 1 }));
    expect(deps.agent.startCut).not.toHaveBeenCalled();
    expect(deps.agent.upload).toHaveBeenCalledTimes(1);
    expect(deps.sessions.complete).toHaveBeenCalledTimes(1);
  });

  // Review focus: a double confirm / restarted job after the api already completed the cut.
  it('a cut the api already completed uploads nothing and only cleans up', async () => {
    const deps = fakeDeps();
    deps.sessions.open.mockResolvedValueOnce({ sessionId: 'sess-1', partSize: 16, parts: [], completed: true });
    await run(deps);
    expect(deps.agent.upload).not.toHaveBeenCalled();
    expect(deps.sessions.complete).not.toHaveBeenCalled();
    expect(deps.agent.drop).toHaveBeenCalledWith(payload.cutId);
  });

  it('an upload that fails before the last attempt keeps the session and the PC\'s staged cut', async () => {
    const deps = fakeDeps();
    deps.agent.upload.mockResolvedValueOnce(cut({ state: 'failed', reason: 'part upload gave up' }));
    await expect(run(deps, fakeJob(payload, 'bull-1', { attempts: 3, attemptsMade: 0 }))).rejects.toThrow('part upload gave up');
    expect(deps.sessions.abort).not.toHaveBeenCalled();
    expect(deps.agent.drop).not.toHaveBeenCalled();
    expect(deps.sessions.complete).not.toHaveBeenCalled();
  });

  it('an upload that fails on the last attempt aborts the session and drops the PC\'s staged cut, so a redo starts clean', async () => {
    const deps = fakeDeps();
    deps.agent.upload.mockResolvedValueOnce(cut({ state: 'failed', reason: 'part upload gave up' }));
    await expect(run(deps, fakeJob(payload, 'bull-1', { attempts: 3, attemptsMade: 2 }))).rejects.toThrow();
    expect(deps.sessions.abort).toHaveBeenCalledWith('sess-1');
    expect(deps.agent.drop).toHaveBeenCalledWith(payload.cutId);
  });

  it('fails clearly when the PC forgets the cut while the job waits', async () => {
    const deps = fakeDeps();
    deps.agent.startCut.mockResolvedValueOnce(cut({ state: 'cutting', sizeBytes: null }));
    deps.agent.cut.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(run(deps)).rejects.toThrow(/no record/i);
  });

  it('gives up after the timeout instead of waiting forever', async () => {
    const deps = fakeDeps();
    deps.agent.startCut.mockResolvedValue(cut({ state: 'cutting', sizeBytes: null }));
    deps.agent.cut.mockResolvedValue(cut({ state: 'cutting', sizeBytes: null }));
    let t = 0;
    await expect(run(deps, fakeJob(payload), () => (t += 600))).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @show-uploader/worker test -- cut-recording`
Expected: FAIL, cannot find `../../src/jobs/cut-recording`.

- [ ] **Step 4: Implement the job**

```ts
// worker/src/jobs/cut-recording.ts
import { UnrecoverableError, type Job } from 'bullmq';
import type { AgentCut, CutJobPayload, CutStep } from '@show-uploader/domain';
import type { WorkerDeps } from '../ports';

type Deps = Pick<WorkerDeps, 'agent' | 'sessions' | 'config'>;
type Opts = { sleep?: (ms: number) => Promise<void>; now?: () => number };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// BullMQ counts finished attempts in attemptsMade, so this is the last one when one
// more would reach the limit.
const isFinalAttempt = (job: Job) => job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

/**
 * Cut one segment of an OBS recording on the PC and make it that show's staged video.
 *
 * The PC cuts and uploads; the api opens the multipart session and completes it (so the
 * staged video is recorded by the same rule as a browser upload). This job only
 * sequences them and waits, and every step is safe to repeat:
 *  - an existing cut on the PC is reused, never re-cut, so a retry resumes the upload and
 *    parts that already landed are not sent again;
 *  - the api hands the same session back for the same cut;
 *  - a cut the api already completed is recognised and only cleaned up.
 * A recording the operator deleted is permanent (UnrecoverableError): retrying cannot help.
 */
export async function processCutRecording(job: Job<CutJobPayload>, { agent, sessions, config }: Deps, opts: Opts = {}): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const { cutId, ref, filename, showId, startS, endS } = job.data;
  const step = (s: CutStep) => job.updateProgress({ step: s });

  // Poll until `done` holds. A failed upload or a vanished recording ends the wait.
  async function waitFor(first: AgentCut, done: (c: AgentCut) => boolean, timeoutMs: number, what: string): Promise<AgentCut> {
    const deadline = now() + timeoutMs;
    let current = first;
    for (;;) {
      if (current.state === 'source_gone') throw new UnrecoverableError(current.reason ?? 'The recording was deleted from the PC');
      if (done(current)) return current;
      if (current.state === 'failed') throw new Error(current.reason ?? 'The PC reported a failure');
      if (now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(config.cutPoll.intervalMs);
      const next = await agent.cut(cutId);
      if (!next) throw new Error('The recordings service has no record of this cut');
      current = next;
    }
  }

  let sessionId: string | null = null;
  try {
    await step('cutting');
    // Reuse a cut the PC still has (a retry): re-cutting would throw away parts that
    // already landed. A failed cut with no size never produced a file, so it is redone.
    let existing = await agent.cut(cutId);
    if (!existing || existing.state === 'source_gone' || (existing.state === 'failed' && existing.sizeBytes === null)) {
      existing = await agent.startCut({ cutId, ref, startS, endS });
    }
    const ready = await waitFor(
      existing,
      (c) => c.state === 'cut' || c.state === 'uploading' || c.state === 'done' || (c.state === 'failed' && c.sizeBytes !== null),
      config.cutPoll.cutTimeoutMs,
      'the cut'
    );
    if (ready.sizeBytes === null) throw new Error('The PC reported no size for the cut');

    const opened = await sessions.open({ cutId, showId, filename, size: ready.sizeBytes, ref, startS, endS });
    sessionId = opened.sessionId;

    if (!opened.completed) {
      await step('uploading');
      const started = ready.state === 'done' ? ready : await agent.upload(cutId, { partSize: opened.partSize, parts: opened.parts });
      // A failure here is an upload failure, never "resumable": the wait must throw.
      await waitFor(started, (c) => c.state === 'done', config.cutPoll.uploadTimeoutMs, 'the upload');
      await step('finishing');
      await sessions.complete(sessionId);
    }

    await agent.drop(cutId);
    return filename;
  } catch (err) {
    // Give the session and the PC's staged cut up only when nothing more will try: an
    // earlier attempt's finished parts are exactly what a retry resumes from.
    if (err instanceof UnrecoverableError || isFinalAttempt(job)) {
      if (sessionId) await sessions.abort(sessionId).catch((e) => console.warn(`Could not abort session ${sessionId}:`, e));
      await agent.drop(cutId);
    }
    throw err;
  }
}
```

Note for the implementer: `waitFor` treats a `failed` state as resumable only in the "cut is ready" call, where `done` accepts `failed` with a size. In the upload wait, `done` is `state === 'done'`, so any `failed` throws.

- [ ] **Step 5: Write the adapter tests, then the adapters**

```ts
// worker/test/services/agent-clients.test.ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingsAgent } from '../../src/services/recordings-agent';
import { createUploadSessions } from '../../src/services/upload-sessions';

let server: http.Server;
let seen: { method?: string; url?: string; auth?: string; body?: string };

async function serve(status: number, body: unknown = {}): Promise<string> {
  seen = {};
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw };
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => server?.close());

const token = 't'.repeat(20);
const req = { cutId: 'c1', ref: 'r1', startS: 0, endS: 60 };

describe('recordings agent client', () => {
  it('starts a cut with the bearer token', async () => {
    const baseUrl = await serve(202, { cutId: 'c1', state: 'cutting', sizeBytes: null, etags: null, reason: null });
    const out = await createRecordingsAgent({ baseUrl, token }).startCut(req);
    expect(out.state).toBe('cutting');
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/cuts', auth: `Bearer ${token}` });
    expect(JSON.parse(seen.body!)).toEqual(req);
  });

  it('turns "unknown recording" into source_gone, because the operator deleted it', async () => {
    const baseUrl = await serve(404, { error: 'Unknown recording r1', code: 'UNKNOWN_RECORDING' });
    const out = await createRecordingsAgent({ baseUrl, token }).startCut(req);
    expect(out).toMatchObject({ state: 'source_gone', reason: expect.stringMatching(/deleted/) });
  });

  it('reads a cut, null when the PC has no record', async () => {
    expect(await createRecordingsAgent({ baseUrl: await serve(404), token }).cut('c1')).toBeNull();
  });

  it('drop never throws', async () => {
    await expect(createRecordingsAgent({ baseUrl: 'http://127.0.0.1:1', token }).drop('c1')).resolves.toBeUndefined();
  });

  it('says clearly when it is not configured', async () => {
    await expect(createRecordingsAgent({}).startCut(req)).rejects.toThrow(/not configured/i);
  });
});

describe('upload sessions client', () => {
  it('opens a cut session through the api with the internal key', async () => {
    const reply = { sessionId: 's1', partSize: 16, parts: [{ n: 1, url: 'u' }], completed: false };
    const baseUrl = await serve(200, reply);
    const out = await createUploadSessions({ baseUrl: `${baseUrl}/api`, apiKey: 'k' }).open({
      cutId: 'c1', showId: 'show-1', filename: 'a.mp4', size: 10, ref: 'r1', startS: 0, endS: 60,
    });
    expect(out).toEqual(reply);
    expect(seen).toMatchObject({ method: 'POST', url: '/api/internal/recordings/cuts/c1/session', auth: 'Bearer k' });
  });

  it('throws with the api\'s message when it refuses', async () => {
    const baseUrl = await serve(404, { error: 'Show show-1 was not found' });
    await expect(createUploadSessions({ baseUrl: `${baseUrl}/api`, apiKey: 'k' }).complete('s1')).rejects.toThrow(/404/);
  });
});
```

```ts
// worker/src/services/recordings-agent.ts
import { AGENT_API_PREFIX, type AgentCut } from '@show-uploader/domain';
import type { RecordingsAgent } from '../ports';

const TIMEOUT_MS = 15_000;

/** HTTP client for the recordings service on the OBS PC. */
export function createRecordingsAgent(o: { baseUrl?: string; token?: string }): RecordingsAgent {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    if (!o.baseUrl || !o.token) {
      throw new Error('The recordings service is not configured (RECORDINGS_AGENT_URL / RECORDINGS_AGENT_TOKEN)');
    }
    return fetch(`${o.baseUrl.replace(/\/$/, '')}${AGENT_API_PREFIX}${path}`, {
      method,
      headers: { Authorization: `Bearer ${o.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function parse(res: Response, what: string): Promise<AgentCut> {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentCut;
  }

  return {
    async startCut(req) {
      const res = await call('POST', '/cuts', req);
      // The PC does not know this recording any more: the operator deleted it.
      if (res.status === 404) {
        return { cutId: req.cutId, state: 'source_gone', sizeBytes: null, etags: null, reason: 'The recording was deleted from the PC' };
      }
      return parse(res, 'Starting the cut');
    },
    async cut(cutId) {
      const res = await call('GET', `/cuts/${encodeURIComponent(cutId)}`);
      if (res.status === 404) return null;
      return parse(res, 'Reading the cut');
    },
    async upload(cutId, req) {
      return parse(await call('POST', `/cuts/${encodeURIComponent(cutId)}/upload`, req), 'Starting the upload');
    },
    async drop(cutId) {
      try {
        await call('DELETE', `/cuts/${encodeURIComponent(cutId)}`);
      } catch (err) {
        console.warn(`Could not drop cut ${cutId} on the PC:`, err instanceof Error ? err.message : err);
      }
    },
  };
}
```

```ts
// worker/src/services/upload-sessions.ts
import type { UploadSessions } from '../ports';

/**
 * The api's internal endpoints for cut upload sessions. Shared-key gated, like the
 * worker's PocketBase write-back: the api owns completion, so the staged video is
 * recorded by the same rule as a browser upload.
 */
export function createUploadSessions(o: { baseUrl: string; apiKey: string }): UploadSessions {
  async function post(path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${o.baseUrl}/internal/recordings${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`api ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    async open({ cutId, ...body }) {
      return (await (await post(`/cuts/${encodeURIComponent(cutId)}/session`, body)).json()) as Awaited<ReturnType<UploadSessions['open']>>;
    },
    async complete(sessionId) {
      await post(`/sessions/${encodeURIComponent(sessionId)}/complete`);
    },
    async abort(sessionId) {
      await post(`/sessions/${encodeURIComponent(sessionId)}/abort`);
    },
  };
}
```

- [ ] **Step 6: Wire adapters and the queue lane**

`worker/src/adapters.ts`: add imports `import { createRecordingsAgent } from './services/recordings-agent';` and `import { createUploadSessions } from './services/upload-sessions';`; add to the returned object before `config`:

```ts
    agent: createRecordingsAgent({ baseUrl: env.RECORDINGS_AGENT_URL, token: env.RECORDINGS_AGENT_TOKEN }),
    sessions: createUploadSessions({ baseUrl: env.INTERNAL_API_URL, apiKey: env.WATCHER_API_KEY }),
```

and change the `config:` line to:

```ts
    config: {
      appPublicUrl: env.APP_PUBLIC_URL ?? null,
      cutPoll: { intervalMs: env.CUT_POLL_INTERVAL_MS, cutTimeoutMs: env.CUT_WAIT_MS, uploadTimeoutMs: env.UPLOAD_WAIT_MS },
    },
```

`worker/src/index.ts`: add `import { RECORDING_CUTS_QUEUE, type CutJobPayload } from '@show-uploader/domain';` and `import { processCutRecording } from './jobs/cut-recording';`, and before the final `console.log('Worker started');`:

```ts
// Cut lane: the PC does the cutting and uploading; this job only sequences it and waits,
// so it never competes with an archive job for CPU or disk. One at a time: the PC's
// uplink is the shared resource, and parallel uploads only slow each other down.
const cutWorker = new Worker<CutJobPayload>(
  RECORDING_CUTS_QUEUE,
  async (job) => {
    console.log(`Cutting recording ${job.data.ref} for show ${job.data.showId} (${job.id})`);
    return processCutRecording(job, deps);
  },
  { connection: redis, concurrency: 1 }
);

cutWorker.on('completed', (job) => {
  console.log(`Recording cut completed: ${job.id}`);
});

cutWorker.on('failed', (job, err) => {
  console.error(`Recording cut failed: ${job?.id}`, err.message);
});
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @show-uploader/worker test && pnpm --filter @show-uploader/worker exec tsc --noEmit`
Expected: PASS; existing worker tests still pass with the extended fakes.

- [ ] **Step 8: Commit**

```bash
git add worker
git commit -m "feat(worker): cut-recording job sequencing the PC and the api

Reuses the PC's finished cut on retry; a deleted recording is not retried."
```

### Task 15: UI rules and data hooks

The UI derives, it does not store (`docs/architecture/video-lifecycle.md`): a segment's status is a pure function of the cut job, the staged video and the upload progress. The domain's pure rules are shared by aliasing its **source** into the UI build, because the package's compiled `dist` is CommonJS and the UI bundle must not depend on a build step of another package.

**Files:**
- Modify: `ui/vite.config.ts`, `ui/tsconfig.json`, `api/Dockerfile`, `ui/src/api/hooks.ts`
- Create: `ui/src/upload/segments.ts`, `ui/src/upload/resolveSegment.ts`, `ui/test/upload/segments.test.ts`, `ui/test/upload/resolveSegment.test.ts`

**Interfaces:**
- Consumes: `Segment`, `AgendaSlot`, `MIN_SEGMENT_SECONDS` from `@domain/recording-segments`; the tRPC `recordings.*` procedures (Task 13); `StagedVideo` from `ui/src/upload/resolveVideo.ts`.
- Produces:
  - `type Draft = Segment & { id: string; showId: string | null }`
  - `formatTimecode(s: number): string`, `parseTimecode(text: string): number | null`
  - `moveEdge(segments: Draft[], id: string, edge: 'start' | 'end', toS: number, durationS: number): Draft[]`
  - `addSegmentAt(segments: Draft[], atS: number, durationS: number, id: string): Draft[]`
  - `agendaSlot(show: { id: string; date: string; startTime: string; endTime: string }): AgendaSlot | null`
  - `type CutStatusView = { state: 'queued' | 'cutting' | 'uploading' | 'finishing' | 'done' | 'failed' | 'unknown'; error: string | null }`
  - `type SegmentStatus = { state: 'draft' } | { state: 'queued' | 'cutting' | 'finishing' } | { state: 'uploading'; fraction: number | null } | { state: 'ready'; filename: string } | { state: 'failed'; message: string }`
  - `resolveSegment(input: { cut?: CutStatusView | null; staged?: StagedVideo | null; uploadFraction?: number | null }): SegmentStatus`
  - hooks `useRecordings()`, `useRecordingPeaks(ref)`, `usePreviewPath(ref)`, `useStartCuts()`, `useCutStatuses(cutIds)`

- [ ] **Step 1: Alias the domain source into the UI**

`ui/vite.config.ts`: add `import { fileURLToPath } from 'node:url';` and, inside `defineConfig({ ... })` after `plugins: [react()],`:

```ts
  resolve: {
    alias: {
      // The pure domain rules, as source: the package's dist is CommonJS for the api and
      // worker, and the UI build should not need another package built first.
      '@domain': fileURLToPath(new URL('../packages/domain/src', import.meta.url)),
    },
  },
```

`ui/tsconfig.json`: add inside `compilerOptions`: `"paths": { "@domain/*": ["../packages/domain/src/*"] },`.

`api/Dockerfile`: in the `ui-builder` stage, add `COPY packages/domain/src/ packages/domain/src/` on the line before `COPY ui/ ui/`.

- [ ] **Step 2: Write the failing tests**

```ts
// ui/test/upload/segments.test.ts
import { describe, expect, it } from 'vitest';
import { addSegmentAt, agendaSlot, formatTimecode, moveEdge, parseTimecode, type Draft } from '../../src/upload/segments';

const seg = (id: string, startS: number, endS: number): Draft => ({ id, startS, endS, showId: null });

describe('timecodes', () => {
  it('formats with tenths, hours only when needed', () => {
    expect(formatTimecode(0)).toBe('0:00.0');
    expect(formatTimecode(65.25)).toBe('1:05.3');
    expect(formatTimecode(3723.4)).toBe('1:02:03.4');
  });

  it('parses h:mm:ss, m:ss, plain seconds and decimals; rejects nonsense', () => {
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('62:03.5')).toBe(3723.5);
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode(' 1:05 ')).toBe(65);
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:99')).toBeNull();
  });

  it('round-trips what it prints', () => {
    for (const s of [0, 59.9, 3600, 12345.6]) expect(parseTimecode(formatTimecode(s))).toBeCloseTo(s, 1);
  });
});

describe('moveEdge', () => {
  const two = [seg('a', 100, 1000), seg('b', 1000, 2000)];

  it('moves an edge freely inside its room', () => {
    expect(moveEdge(two, 'a', 'end', 800, 5000).find((s) => s.id === 'a')?.endS).toBe(800);
  });

  it('never lets an edge cross its neighbour', () => {
    expect(moveEdge(two, 'a', 'end', 1500, 5000).find((s) => s.id === 'a')?.endS).toBe(1000);
    expect(moveEdge(two, 'b', 'start', 500, 5000).find((s) => s.id === 'b')?.startS).toBe(1000);
  });

  it('keeps the minimum length and stays inside the recording', () => {
    expect(moveEdge(two, 'a', 'start', 990, 5000).find((s) => s.id === 'a')?.startS).toBe(970);
    expect(moveEdge(two, 'b', 'end', 9999, 5000).find((s) => s.id === 'b')?.endS).toBe(5000);
    expect(moveEdge(two, 'a', 'start', -50, 5000).find((s) => s.id === 'a')?.startS).toBe(0);
  });

  it('ignores an unknown id', () => {
    expect(moveEdge(two, 'zzz', 'end', 10, 5000)).toBe(two);
  });
});

describe('addSegmentAt', () => {
  it('adds a segment of up to 30 minutes at the point', () => {
    const out = addSegmentAt([], 100, 7200, 'n');
    expect(out).toEqual([{ id: 'n', startS: 100, endS: 1900, showId: null }]);
  });

  it('stops at the next segment', () => {
    const out = addSegmentAt([seg('a', 600, 1000)], 100, 7200, 'n');
    expect(out.find((s) => s.id === 'n')).toMatchObject({ startS: 100, endS: 600 });
  });

  it('adds nothing where there is no room', () => {
    const existing = [seg('a', 100, 1000)];
    expect(addSegmentAt(existing, 500, 7200, 'n')).toBe(existing);
    expect(addSegmentAt([seg('a', 120, 1000)], 100, 7200, 'n')).toHaveLength(1);
  });
});

describe('agendaSlot', () => {
  it('reads the agenda\'s UTC date and times', () => {
    expect(agendaSlot({ id: 's', date: '2026-10-01', startTime: '20:00', endTime: '22:00' })).toEqual({
      showId: 's', startMs: Date.parse('2026-10-01T20:00:00Z'), endMs: Date.parse('2026-10-01T22:00:00Z'),
    });
  });

  it('a show that ends after midnight ends the next day', () => {
    const slot = agendaSlot({ id: 's', date: '2026-10-01', startTime: '23:00', endTime: '01:00' });
    expect(slot?.endMs).toBe(Date.parse('2026-10-02T01:00:00Z'));
  });

  it('gives null for times it cannot read, so a bad agenda entry is simply not suggested', () => {
    expect(agendaSlot({ id: 's', date: '', startTime: '', endTime: '' })).toBeNull();
  });
});
```

```ts
// ui/test/upload/resolveSegment.test.ts
import { describe, expect, it } from 'vitest';
import { resolveSegment } from '../../src/upload/resolveSegment';

const staged = { s3_key: 'incoming/1-a.mp4', filename: 'a.mp4' };
const cut = (state: string, error: string | null = null) => ({ state, error }) as never;

describe('resolveSegment', () => {
  it('is a draft when nothing has been started and nothing is staged', () => {
    expect(resolveSegment({})).toEqual({ state: 'draft' });
    expect(resolveSegment({ cut: cut('unknown') })).toEqual({ state: 'draft' });
  });

  it('shows the cut\'s own progress while it runs', () => {
    expect(resolveSegment({ cut: cut('queued') })).toEqual({ state: 'queued' });
    expect(resolveSegment({ cut: cut('cutting') })).toEqual({ state: 'cutting' });
    expect(resolveSegment({ cut: cut('finishing') })).toEqual({ state: 'finishing' });
  });

  it('reports the real upload fraction from S3, or null when unknown', () => {
    expect(resolveSegment({ cut: cut('uploading'), uploadFraction: 0.4 })).toEqual({ state: 'uploading', fraction: 0.4 });
    expect(resolveSegment({ cut: cut('uploading') })).toEqual({ state: 'uploading', fraction: null });
  });

  it('is ready once the matching video is staged, even after the job has expired from the queue', () => {
    expect(resolveSegment({ cut: cut('done'), staged })).toEqual({ state: 'ready', filename: 'a.mp4' });
    expect(resolveSegment({ cut: cut('unknown'), staged })).toEqual({ state: 'ready', filename: 'a.mp4' });
  });

  it('a finished job whose staged row has not arrived yet is still finishing, not ready', () => {
    expect(resolveSegment({ cut: cut('done') })).toEqual({ state: 'finishing' });
  });

  it('a failed attempt is shown as failed with its reason, even if an older video is staged', () => {
    expect(resolveSegment({ cut: cut('failed', 'The recording was deleted from the PC'), staged })).toEqual({
      state: 'failed', message: 'The recording was deleted from the PC',
    });
    expect(resolveSegment({ cut: cut('failed') })).toEqual({ state: 'failed', message: 'The cut failed' });
  });

  it('an active cut wins over an older staged video that it is about to replace', () => {
    expect(resolveSegment({ cut: cut('cutting'), staged })).toEqual({ state: 'cutting' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @show-uploader/ui test -- segments resolveSegment`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

```ts
// ui/src/upload/segments.ts
import { MIN_SEGMENT_SECONDS, type AgendaSlot, type Segment } from '@domain/recording-segments';

/**
 * The editor's working copy of a segment. Pure helpers only: the server re-validates
 * everything with the same domain rules, so this exists to make dragging feel right.
 */
export type Draft = Segment & { id: string; showId: string | null };

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function formatTimecode(s: number): string {
  const total = Math.max(0, round1(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total - h * 3600 - m * 60;
  const secText = sec.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secText}` : `${m}:${secText}`;
}

/** h:mm:ss, m:ss, or plain seconds, each with optional decimals. Null when unreadable. */
export function parseTimecode(text: string): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  // Minutes may exceed 59 only when there is no hours part ("62:03" is an hour and two minutes).
  if ((m[1] !== undefined && min >= 60) || sec >= 60) return null;
  return h * 3600 + min * 60 + sec;
}

const EPS = 1e-6;

/** Move one edge, never past a neighbour, below the minimum length, or off the recording. */
export function moveEdge(segments: Draft[], id: string, edge: 'start' | 'end', toS: number, durationS: number): Draft[] {
  const me = segments.find((s) => s.id === id);
  if (!me) return segments;
  const others = segments.filter((s) => s.id !== id);
  const before = others.filter((s) => s.endS <= me.startS + EPS).map((s) => s.endS);
  const after = others.filter((s) => s.startS >= me.endS - EPS).map((s) => s.startS);
  const floor = before.length ? Math.max(...before) : 0;
  const ceil = after.length ? Math.min(...after) : durationS;
  const value = round1(toS);
  const next = edge === 'start' ? clamp(value, floor, me.endS - MIN_SEGMENT_SECONDS) : clamp(value, me.startS + MIN_SEGMENT_SECONDS, ceil);
  return segments.map((s) => (s.id === id ? { ...s, [edge === 'start' ? 'startS' : 'endS']: next } : s));
}

const DEFAULT_LENGTH_S = 30 * 60;

/** A new segment starting at `atS`, up to 30 minutes, stopping at the next one. Unchanged if there is no room. */
export function addSegmentAt(segments: Draft[], atS: number, durationS: number, id: string): Draft[] {
  const startS = round1(atS);
  if (segments.some((s) => startS >= s.startS && startS < s.endS)) return segments;
  const next = segments.filter((s) => s.startS >= startS).map((s) => s.startS);
  const endS = Math.min(startS + DEFAULT_LENGTH_S, durationS, ...next);
  if (endS - startS < MIN_SEGMENT_SECONDS) return segments;
  return [...segments, { id, startS, endS, showId: null }].sort((a, b) => a.startS - b.startS);
}

/**
 * The agenda stores UTC: a date (of the start) and HH:MM times. A show that ends "before"
 * it starts crosses midnight. Only ever a suggestion: real nights run over and under.
 */
export function agendaSlot(show: { id: string; date: string; startTime: string; endTime: string }): AgendaSlot | null {
  const startMs = Date.parse(`${show.date}T${show.startTime}:00Z`);
  let endMs = Date.parse(`${show.date}T${show.endTime}:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs += 24 * 3600_000;
  return { showId: show.id, startMs, endMs };
}
```

```ts
// ui/src/upload/resolveSegment.ts
import type { StagedVideo } from './resolveVideo';

/** What the api reports for a cut (the queue's view). */
export type CutStatusView = {
  state: 'queued' | 'cutting' | 'uploading' | 'finishing' | 'done' | 'failed' | 'unknown';
  error: string | null;
};

export type SegmentStatus =
  | { state: 'draft' }
  | { state: 'queued' | 'cutting' | 'finishing' }
  | { state: 'uploading'; fraction: number | null }
  | { state: 'ready'; filename: string }
  | { state: 'failed'; message: string };

/**
 * The single, pure rule for "where is this segment?". Like resolveVideo it derives from
 * server truth and stores nothing, so navigating away or refreshing cannot lose it.
 *
 * `staged` must already be the video that belongs to THIS segment (its filename matches
 * the cut's), otherwise an unrelated earlier upload would make a draft look ready.
 */
export function resolveSegment(input: {
  cut?: CutStatusView | null;
  staged?: StagedVideo | null;
  uploadFraction?: number | null;
}): SegmentStatus {
  const { cut, staged, uploadFraction } = input;
  const state = cut?.state ?? 'unknown';

  if (state === 'failed') return { state: 'failed', message: cut?.error ?? 'The cut failed' };
  if (state === 'queued' || state === 'cutting' || state === 'finishing') return { state };
  if (state === 'uploading') return { state: 'uploading', fraction: uploadFraction ?? null };

  // done / unknown: the staged video is the durable truth (the job may have aged out).
  if (staged) return { state: 'ready', filename: staged.filename };
  return state === 'done' ? { state: 'finishing' } : { state: 'draft' };
}
```

Append to `ui/src/api/hooks.ts`:

```ts
// OBS PC recordings ------------------------------------------------------------

// The PC is polled gently: it can be off, and "not reachable" is a normal answer.
export function useRecordings() {
  const trpc = useTRPC();
  return useQuery(trpc.recordings.list.queryOptions(undefined, { refetchInterval: 15_000 }));
}

export function useRecordingPeaks(ref: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.recordings.peaks.queryOptions({ ref: ref ?? '' }, { enabled: !!ref, staleTime: Infinity }));
}

// Keyed by recording, like useSignedUrl: signed once per viewing session and served from
// cache, so the <video src> never swaps while it plays (see AGENTS.md).
export function usePreviewPath(ref: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.recordings.signPreview.queryOptions({ ref: ref ?? '' }, { enabled: !!ref, staleTime: 5 * 60 * 60_000 })
  );
}

export function useStartCuts() {
  const trpc = useTRPC();
  return useMutation(trpc.recordings.startCuts.mutationOptions());
}

// Polls while any cut is still running; stops once every one is done or failed.
export function useCutStatuses(cutIds: string[]) {
  const trpc = useTRPC();
  return useQuery(
    trpc.recordings.cutStatuses.queryOptions(
      { cutIds },
      {
        enabled: cutIds.length > 0,
        refetchInterval: (query) =>
          query.state.data?.every((s) => s.state === 'done' || s.state === 'failed') ? false : 3_000,
      }
    )
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @show-uploader/ui test`
Expected: PASS, including the existing UI tests.

- [ ] **Step 6: Commit**

```bash
git add ui api/Dockerfile
git commit -m "feat(ui): segment rules, resolveSegment and recordings hooks

Domain rules reach the UI as source via an alias, so one copy of the rule."
```

---

### Task 16: Recordings page, timeline, mock backend, route

**Files:**
- Create: `ui/src/pages/Recordings.tsx`, `ui/src/components/RecordingTimeline.tsx`
- Modify: `ui/src/router.tsx`, `ui/src/dev/fixtures.ts`, `ui/src/dev/mock-backend.ts`

**Interfaces:**
- Consumes: Task 15 hooks and rules; `useShows`, `useStaged`, `useUploadingProgress` (existing); `humanDuration` (`ui/src/format.ts`); `PageLoading`.
- Produces: a `/recordings` route and a "recordings" nav link. No new exports other than the page and component defaults.

There is no component test harness in `ui/` (its tests are pure functions), so the page is verified in `?mock=1` mode in Step 6, and its logic lives in the pure modules from Task 15.

- [ ] **Step 1: The timeline component**

```tsx
// ui/src/components/RecordingTimeline.tsx
import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import { c, withAlpha } from '../theme';
import type { Draft } from '../upload/segments';

type Props = {
  durationS: number;
  peaks: number[] | undefined;
  segments: Draft[];
  playheadS: number;
  onSeek(s: number): void;
  onMoveEdge(id: string, edge: 'start' | 'end', toS: number): void;
  onAdd(atS: number): void;
};

const HEIGHT = 96;
const HANDLE_PX = 12;

function Handle({ left, onDrag }: { left: string; onDrag(clientX: number): void }) {
  return (
    <Box
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onClick={(e) => e.stopPropagation()}
      sx={{
        position: 'absolute', top: 0, bottom: 0, left, width: HANDLE_PX, ml: `-${HANDLE_PX / 2}px`,
        cursor: 'ew-resize', backgroundColor: c.ink, opacity: 0.85, touchAction: 'none',
      }}
    />
  );
}

/**
 * The whole recording on one line: waveform, draggable segments, playhead. Click seeks,
 * double-click adds a segment, the handles move an edge. All the rules (neighbours, the
 * minimum length) live in moveEdge/addSegmentAt, so this only translates pixels to time.
 */
export default function RecordingTimeline({ durationS, peaks, segments, playheadS, onSeek, onMoveEdge, onAdd }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // One bar per pixel column: the loudest peak in that column's slice of the recording.
  useEffect(() => {
    const el = canvas.current;
    const host = box.current;
    if (!el || !host || !peaks?.length) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.floor(host.clientWidth * dpr);
      el.height = Math.floor(HEIGHT * dpr);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = c.muted;
      for (let x = 0; x < el.width; x++) {
        const from = Math.floor((x / el.width) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((x + 1) / el.width) * peaks.length));
        let max = 0;
        for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
        const h = Math.max(1, max * el.height);
        ctx.fillRect(x, (el.height - h) / 2, 1, h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [peaks]);

  const timeAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(durationS, Math.max(0, ((clientX - r.left) / r.width) * durationS));
  };
  const pct = (s: number) => `${(s / durationS) * 100}%`;

  return (
    <Box
      ref={box}
      onClick={(e) => onSeek(timeAt(e.clientX))}
      onDoubleClick={(e) => onAdd(timeAt(e.clientX))}
      sx={{ position: 'relative', height: HEIGHT, backgroundColor: c.accentSoft, border: `1px solid ${c.border}`, userSelect: 'none', cursor: 'crosshair' }}
    >
      <Box component="canvas" ref={canvas} sx={{ position: 'absolute', inset: 0, width: '100%', height: HEIGHT }} />
      {segments.map((s, i) => (
        <Box key={s.id}>
          <Box
            sx={{
              position: 'absolute', top: 0, bottom: 0, left: pct(s.startS), width: pct(s.endS - s.startS),
              backgroundColor: withAlpha(c.link, 0.22), borderTop: `3px solid ${c.link}`,
              fontSize: 11, color: c.link, pl: 0.5, pointerEvents: 'none',
            }}
          >
            {i + 1}
          </Box>
          <Handle left={pct(s.startS)} onDrag={(x) => onMoveEdge(s.id, 'start', timeAt(x))} />
          <Handle left={pct(s.endS)} onDrag={(x) => onMoveEdge(s.id, 'end', timeAt(x))} />
        </Box>
      ))}
      <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: pct(playheadS), width: '2px', backgroundColor: c.danger, pointerEvents: 'none' }} />
    </Box>
  );
}
```

- [ ] **Step 2: The page**

```tsx
// ui/src/pages/Recordings.tsx
import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { suggestSegments, validateSegments } from '@domain/recording-segments';
import { cutFilename, type AgentRecording } from '@domain/recordings-contract';
import {
  useCutStatuses, usePreviewPath, useRecordingPeaks, useRecordings, useShows, useStaged, useStartCuts, useUploadingProgress,
} from '../api/hooks';
import { humanDuration } from '../format';
import { c } from '../theme';
import { PageLoading } from '../components/Skeleton';
import RecordingTimeline from '../components/RecordingTimeline';
import { resolveSegment, type CutStatusView, type SegmentStatus } from '../upload/resolveSegment';
import { addSegmentAt, agendaSlot, formatTimecode, moveEdge, parseTimecode, type Draft } from '../upload/segments';

// The PC's clock is Brussels, and so is everyone reading this page.
const brussels = new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', dateStyle: 'medium', timeStyle: 'short' });

export default function Recordings() {
  const q = useRecordings();
  const [ref, setRef] = useState<string | null>(null);

  if (q.isPending) return <PageLoading label="asking the OBS PC…" />;
  if (q.isError) {
    return (
      <Typography variant="body2" sx={{ color: c.danger }}>
        could not read recordings: {q.error.message}
      </Typography>
    );
  }

  const header = (
    <Box>
      <Typography variant="h1">recordings</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        cut a night into one upload per artist. cuts are lossless and only the cut parts leave the PC.
      </Typography>
    </Box>
  );

  // Off, or off the tailnet. Normal, not an error: nothing already uploaded is affected.
  if (!q.data.reachable) {
    return (
      <Stack spacing={3}>
        {header}
        <Typography variant="body2" color="text.secondary">
          the OBS PC is not reachable right now. recordings already uploaded are not affected.
        </Typography>
      </Stack>
    );
  }

  const selected = q.data.recordings.find((r) => r.ref === ref) ?? null;
  return (
    <Stack spacing={4}>
      {header}
      {selected ? (
        <Editor key={selected.ref} recording={selected} onClose={() => setRef(null)} />
      ) : (
        <Stack spacing={1.5}>
          {q.data.recordings.length === 0 && (
            <Typography variant="body2" color="text.secondary">no recordings on the OBS PC.</Typography>
          )}
          {q.data.recordings.map((r) => (
            <Stack
              key={r.ref} direction="row" alignItems="center" spacing={2}
              sx={{ p: 1.5, backgroundColor: c.surface, border: `1px solid ${c.border}` }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }} noWrap>{r.filename}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {brussels.format(r.recordedAtMs)} · {r.durationS ? humanDuration(r.durationS) : 'reading…'}
                  {r.state === 'preparing' && ' · preparing the editor view…'}
                  {r.state === 'failed' && ' · could not be prepared'}
                </Typography>
              </Box>
              <Button size="small" variant="outlined" disabled={r.state !== 'ready'} onClick={() => setRef(r.ref)}>
                open
              </Button>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Editor({ recording, onClose }: { recording: AgentRecording; onClose: () => void }) {
  const durationS = recording.durationS ?? 0;
  const preview = usePreviewPath(recording.hasPreview ? recording.ref : null);
  const peaks = useRecordingPeaks(recording.ref);
  const shows = useShows();
  const uploading = useUploadingProgress();
  const startCuts = useStartCuts();

  const [segments, setSegments] = useState<Draft[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [cutByShow, setCutByShow] = useState<Record<string, string>>({});
  const statuses = useCutStatuses(Object.values(cutByShow));
  const video = useRef<HTMLVideoElement>(null);
  const nextId = useRef(1);
  const newId = () => String(nextId.current++);

  // The server computes the real % from S3 (ListParts), so every machine shows the same number.
  const fractionFor = (showId: string | null): number | null => {
    const pct = uploading.data?.find((u) => u.show_id === showId)?.pct;
    return typeof pct === 'number' ? pct / 100 : null;
  };

  const problems = validateSegments(segments, durationS);
  const canCut = segments.length > 0 && segments.every((s) => s.showId) && problems.length === 0 && !startCuts.isPending;

  const seek = (s: number) => {
    if (video.current) video.current.currentTime = s;
    setPlayhead(s);
  };
  const patch = (id: string, change: Partial<Draft>) => setSegments((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

  // Agenda times are DRAFT markers: they fill in a first guess the operator then corrects.
  const suggest = () => {
    const slots = (shows.data ?? []).map(agendaSlot).filter((s): s is NonNullable<typeof s> => s !== null);
    setSegments(suggestSegments(recording.recordedAtMs, durationS, slots).map((s) => ({ ...s, id: newId() })));
  };

  const submit = () =>
    startCuts.mutate(
      { ref: recording.ref, segments: segments.map(({ startS, endS, showId }) => ({ startS, endS, showId: showId! })) },
      { onSuccess: (r) => setCutByShow(Object.fromEntries(r.cuts.map((x) => [x.showId, x.cutId]))) }
    );

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" alignItems="baseline" spacing={2}>
        <Button size="small" onClick={onClose}>← recordings</Button>
        <Typography sx={{ fontWeight: 600 }} noWrap>{recording.filename}</Typography>
        <Typography variant="caption" color="text.secondary">{humanDuration(durationS)}</Typography>
      </Stack>

      {preview.data ? (
        <Box
          component="video" ref={video} src={preview.data.path} controls preload="metadata" playsInline
          onTimeUpdate={(e: React.SyntheticEvent<HTMLVideoElement>) => setPlayhead(e.currentTarget.currentTime)}
          sx={{ width: '100%', maxHeight: '45vh', backgroundColor: '#000', display: 'block' }}
        />
      ) : (
        <Typography variant="caption" color="text.disabled">
          {preview.isError ? `could not open the preview: ${preview.error.message}` : 'loading the preview…'}
        </Typography>
      )}

      <RecordingTimeline
        durationS={durationS} peaks={peaks.data} segments={segments} playheadS={playhead}
        onSeek={seek}
        onMoveEdge={(id, edge, toS) => setSegments((all) => moveEdge(all, id, edge, toS, durationS))}
        onAdd={(at) => setSegments((all) => addSegmentAt(all, at, durationS, newId()))}
      />
      <Typography variant="caption" color="text.disabled">
        click to seek · double-click to add a segment · drag a handle to move an edge. agenda times are only a first guess.
      </Typography>

      <Stack direction="row" spacing={1}>
        <Button size="small" variant="outlined" onClick={suggest} disabled={!shows.data}>suggest from agenda</Button>
        <Button size="small" variant="outlined" onClick={() => setSegments((all) => addSegmentAt(all, playhead, durationS, newId()))}>
          add segment at playhead
        </Button>
      </Stack>

      <Stack spacing={1}>
        {segments.map((s, i) => {
          const cutId = s.showId ? cutByShow[s.showId] : undefined;
          const expected = cutFilename(recording.filename, s.startS, s.endS);
          return (
            <SegmentRow
              key={s.id} index={i} draft={s} playhead={playhead} expectedFilename={expected}
              cut={statuses.data?.find((x) => x.cutId === cutId) as CutStatusView | undefined}
              uploadFraction={fractionFor(s.showId)}
              showOptions={(shows.data ?? []).map((x) => ({ id: x.id, title: x.title, taken: segments.some((o) => o.id !== s.id && o.showId === x.id) }))}
              problem={problems.find((p) => p.index === i)?.message}
              onChange={(change) => patch(s.id, change)}
              onRemove={() => setSegments((all) => all.filter((x) => x.id !== s.id))}
            />
          );
        })}
      </Stack>

      {startCuts.isError && <Typography variant="body2" sx={{ color: c.danger }}>{startCuts.error.message}</Typography>}
      <Box>
        <Button variant="contained" disabled={!canCut} onClick={submit}>
          cut {segments.length || ''} segment{segments.length === 1 ? '' : 's'}
        </Button>
      </Box>
    </Stack>
  );
}

function SegmentRow(props: {
  index: number; draft: Draft; playhead: number; expectedFilename: string;
  cut: CutStatusView | undefined; uploadFraction: number | null;
  showOptions: { id: string; title: string; taken: boolean }[];
  problem: string | undefined;
  onChange(change: Partial<Draft>): void; onRemove(): void;
}) {
  const { draft, cut, index } = props;
  // Only a video whose filename matches THIS cut counts as this segment's result.
  const staged = useStaged(draft.showId ?? undefined).data;
  const matching = staged && staged.filename === props.expectedFilename ? staged : null;
  const status = resolveSegment({ cut, staged: matching, uploadFraction: props.uploadFraction });
  const replaces = staged && !matching && status.state === 'draft';

  return (
    <Stack spacing={0.5} sx={{ p: 1.5, backgroundColor: c.surface, border: `1px solid ${props.problem ? c.danger : c.border}` }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography sx={{ width: 20, fontWeight: 700 }}>{index + 1}</Typography>
        <TimeField label="in" value={draft.startS} onCommit={(s) => props.onChange({ startS: s })} />
        <Button size="small" onClick={() => props.onChange({ startS: props.playhead })}>← playhead</Button>
        <TimeField label="out" value={draft.endS} onCommit={(s) => props.onChange({ endS: s })} />
        <Button size="small" onClick={() => props.onChange({ endS: props.playhead })}>← playhead</Button>
        <Select
          size="small" displayEmpty value={draft.showId ?? ''} sx={{ minWidth: 220, flex: 1 }}
          onChange={(e) => props.onChange({ showId: e.target.value || null })}
        >
          <MenuItem value=""><em>choose the show…</em></MenuItem>
          {props.showOptions.map((o) => (
            <MenuItem key={o.id} value={o.id} disabled={o.taken}>{o.title}</MenuItem>
          ))}
        </Select>
        <Typography variant="caption" sx={{ minWidth: 150, color: status.state === 'failed' ? c.danger : c.muted }}>
          {statusLabel(status)}
        </Typography>
        <Button size="small" onClick={props.onRemove} disabled={['queued', 'cutting', 'uploading', 'finishing'].includes(status.state)}>
          remove
        </Button>
      </Stack>
      {props.problem && <Typography variant="caption" sx={{ color: c.danger }}>{props.problem}</Typography>}
      {replaces && (
        <Typography variant="caption" color="text.secondary">
          this show already has a video staged. cutting replaces it.
        </Typography>
      )}
    </Stack>
  );
}

function statusLabel(s: SegmentStatus): string {
  switch (s.state) {
    case 'draft': return '';
    case 'queued': return 'queued';
    case 'cutting': return 'cutting on the PC…';
    case 'uploading': return s.fraction === null ? 'uploading…' : `uploading ${Math.round(s.fraction * 100)}%`;
    case 'finishing': return 'finishing…';
    case 'ready': return '✓ staged for publishing';
    case 'failed': return s.message;
  }
}

function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit(s: number): void }) {
  const [text, setText] = useState(formatTimecode(value));
  useEffect(() => setText(formatTimecode(value)), [value]);
  return (
    <TextField
      size="small" label={label} value={text} sx={{ width: 130 }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const s = parseTimecode(text);
        if (s === null) setText(formatTimecode(value));
        else onCommit(s);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
```

- [ ] **Step 3: Route and nav**

`ui/src/router.tsx`: add `import Recordings from './pages/Recordings';` next to the other page imports; add `{ to: '/recordings', label: 'recordings' },` to `navLinks` between `archive` and `storage`; add

```tsx
const recordingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/recordings',
  component: Recordings,
});
```

after `storageRoute`, and add `recordingsRoute` to the `authedRoute.addChildren([...])` list.

- [ ] **Step 4: Mock fixtures and backend**

`ui/src/dev/fixtures.ts`, append:

```ts
// A night recorded on the OBS PC: ready, plus one still being prepared.
export const recordings = [
  {
    ref: 'rec-night-1', filename: '2026-07-31_19-55-00.mkv', sizeBytes: 9_400_000_000, mtimeMs: Date.parse('2026-07-31T23:55:00Z'),
    durationS: 14_400, state: 'ready' as const, hasPreview: true, recordedAtMs: Date.parse('2026-07-31T19:55:00Z'),
  },
  {
    ref: 'rec-night-2', filename: '2026-08-07_19-58-00.mkv', sizeBytes: 3_100_000_000, mtimeMs: Date.parse('2026-08-07T22:00:00Z'),
    durationS: null, state: 'preparing' as const, hasPreview: false, recordedAtMs: Date.parse('2026-08-07T19:58:00Z'),
  },
];
```

`ui/src/dev/mock-backend.ts`: add `recordings` to the fixtures import; add `const cutPolls = new Map<string, number>();` next to `previewPolls`; and these cases in `resolve`'s `switch`:

```ts
    case 'recordings.list':
      return { reachable: true, recordings };
    case 'recordings.peaks':
      // A plausible set: quiet gaps between louder stretches, one value per second.
      return Array.from({ length: 14_400 }, (_, i) => Math.round((0.15 + 0.6 * Math.abs(Math.sin(i / 400)) * Math.random()) * 1000) / 1000);
    case 'recordings.signPreview':
      return { path: mockSignedUrl() };
    case 'recordings.startCuts': {
      const segs = (input as { segments: { showId: string }[] }).segments;
      return { cuts: segs.map((s) => ({ cutId: `mock-cut-${s.showId}`, showId: s.showId })) };
    }
    case 'recordings.cutStatuses': {
      // Walk each cut through the real states, one per poll, so the progress UI is reachable.
      const states = ['queued', 'cutting', 'uploading', 'finishing', 'done'] as const;
      return ((input as { cutIds: string[] }).cutIds).map((cutId) => {
        const n = cutPolls.get(cutId) ?? 0;
        cutPolls.set(cutId, n + 1);
        return { cutId, state: states[Math.min(n, states.length - 1)], error: null };
      });
    }
```

- [ ] **Step 5: Typecheck and build**

Run: `pnpm --filter @show-uploader/ui exec tsc --noEmit && pnpm --filter @show-uploader/ui build && pnpm --filter @show-uploader/ui test`
Expected: no type errors, build succeeds, tests PASS. Fix any type error in `Recordings.tsx` by simplifying, never by adding `any`.

- [ ] **Step 6: Verify in mock mode (manual)**

Run `pnpm dev:ui`, open `http://localhost:5173/recordings?mock=1` and confirm each of:
1. Two recordings listed; the second says "preparing the editor view…" and its `open` is disabled.
2. Open the first: the (inert) player area shows, the waveform draws, resizing the window redraws it.
3. "suggest from agenda" adds segments with shows chosen; drag a handle: it stops at a neighbour and at the minimum length; double-click on empty timeline adds a segment; "← playhead" sets an edge.
4. Typing `1:05:00` in an `in` field and pressing Enter commits it; typing `abc` reverts it.
5. Two segments for the same show are not selectable (the second option is disabled).
6. "cut N segments" is disabled until every segment has a show; clicking it walks the rows through queued, cutting, uploading, finishing (the mock cycles per poll). The `dubplate` row shows "this show already has a video staged. cutting replaces it." before cutting.
7. Narrow the window to phone width: nothing overflows horizontally.

- [ ] **Step 7: Commit**

```bash
git add ui
git commit -m "feat(ui): recordings page with waveform timeline and segment editor"
```

### Task 17: End-to-end on the real built pieces

Unit tests pass happily while the wiring is wrong, and production has no safe way to try a job (`AGENTS.md`). This runs the real built recordings service against a real folder and a real 3-audio-track MKV, with the built api routes and use cases, the built worker, and real MinIO, Postgres and Redis. Only PocketBase is stubbed.

**Files:**
- Create: `scripts/e2e/recordings.mjs`
- Modify: `scripts/e2e/lib.mjs`, `scripts/e2e/index.mjs`, `scripts/e2e/README.md`

**Interfaces:**
- Consumes: built `watcher/dist/index.js`, `api/dist/{adapters,usecases/recording-cuts,usecases/publish,routes/recordings}.js`, `worker/dist/index.js`; helpers from `lib.mjs`.
- Produces: `export async function run(): Promise<number>` (failure count) in `recordings.mjs`.

- [ ] **Step 1: Teach the harness about the new service**

`scripts/e2e/lib.mjs`: add to the `env` object (after `JINGLE_S3_KEY`):

```js
  // The recordings service the suite starts itself, on a deliberately odd port.
  RECORDINGS_AGENT_URL: 'http://127.0.0.1:18787',
  RECORDINGS_AGENT_TOKEN: 'e2e-recordings-token-0123456789',
```

`scripts/e2e/index.mjs`: change the usage text to `usage: pnpm e2e [worker|api|recordings] [--keep]`; change the build line's filters to
`['--filter', '@show-uploader/api', '--filter', '@show-uploader/worker', '--filter', '@show-uploader/watcher', 'build']`;
and replace the two suite conditions with:

```js
  if (!only || only === 'worker') {
    const { run } = await import('./worker.mjs');
    failed += await run();
  }
  if (!only || only === 'api') {
    const { run } = await import('./api.mjs');
    failed += await run();
  }
  // Last: it needs the stub api port (13999) the other suites have released by now.
  if (!only || only === 'recordings') {
    const { run } = await import('./recordings.mjs');
    failed += await run();
  }
```

`scripts/e2e/README.md`: add a row to the table: `| \`recordings.mjs\` | The built recordings service prepares a real 3-track MKV, the worker cuts two segments through it, parts land on S3 and are staged per show, the archive keeps the exact length, and a recording deleted by hand is refused. |`.

- [ ] **Step 2: Write the suite**

```js
// scripts/e2e/recordings.mjs
/**
 * The whole recordings feature on the real built pieces: the recordings service
 * (watcher/dist) watching a real folder with a real 3-audio-track MKV, the built api
 * routes and use cases, the built worker, and real MinIO, Postgres and Redis. Only
 * PocketBase (agenda) is stubbed.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ROOT, bucket, database, env, probeSeconds, reporter, requireFrom, scratchDir, startWorker, waitFor,
} from './lib.mjs';

Object.assign(process.env, env);

const PORT = 18787;
const TOKEN = env.RECORDINGS_AGENT_TOKEN;
const NAME = '2026-10-01_20-00-00.mkv';
const SHOWS = ['show-rec-a', 'show-rec-b'];

// OBS here records HEVC; use it when this ffmpeg can, so the hvc1 path is exercised.
function makeNight(file) {
  const hevc = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libx265');
  const video = hevc
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:min-keyint=50:scenecut=0:log-level=none']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0'];
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=1320:sample_rate=48000',
    '-t', '60', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
    ...video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac:a:0', '1', '-ac:a:1', '2', '-ac:a:2', '2', file,
  ]);
  // Old enough that the service sees it as finished at once.
  const t = new Date(Date.now() - 120_000);
  fs.utimesSync(file, t, t);
  return hevc ? 'hevc' : 'h264';
}

const audioStreams = (file) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file])
    .toString().trim().split('\n').filter(Boolean).length;

export async function run() {
  const { check, finish } = reporter('recordings');
  const work = scratchDir('e2e-rec-');
  const recDir = path.join(work, 'obs');
  fs.mkdirSync(recDir);
  const store = await bucket();
  const db = await database();
  const worker = startWorker();
  let watcher;
  let internalApi;

  const agent = (p, init = {}) =>
    fetch(`http://127.0.0.1:${PORT}/v1${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

  try {
    await db`DELETE FROM staged_uploads WHERE show_id = ANY(${SHOWS})`;
    await db`DELETE FROM multipart_uploads WHERE show_id = ANY(${SHOWS})`;

    const codec = makeNight(path.join(recDir, NAME));
    watcher = spawn('node', [path.join(ROOT, 'watcher/dist/index.js')], {
      cwd: work, // so dotenv can never pick up a real .env
      env: {
        ...process.env, RECORDINGS_DIR: recDir, AGENT_TOKEN: TOKEN, LISTEN_HOST: '127.0.0.1', LISTEN_PORT: String(PORT),
        STABLE_WINDOW_MS: '1000', SCAN_INTERVAL_MS: '500', FFMPEG_PATH: 'ffmpeg', FFPROBE_PATH: 'ffprobe',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let watcherLog = '';
    watcher.stdout.on('data', (d) => (watcherLog += d));
    watcher.stderr.on('data', (d) => (watcherLog += d));

    // --- the PC prepares the recording ------------------------------------------
    const unauth = await fetch(`http://127.0.0.1:${PORT}/v1/recordings`).catch(() => null);
    const rec = await waitFor('the service to prepare the recording', async () => {
      const res = await agent('/recordings').catch(() => null);
      const list = res?.ok ? await res.json() : [];
      return list.find((r) => r.state === 'ready') ?? null;
    }, 120000);
    check(`the service prepared the ${codec} recording`, rec.hasPreview && Math.abs(rec.durationS - 60) < 1, JSON.stringify(rec));
    check('the service refuses a call without the token', unauth?.status === 401);
    const ranged = await agent(`/recordings/${rec.ref}/preview`, { headers: { Range: 'bytes=0-99' } });
    check('the preview is served with Range support', ranged.status === 206);

    // --- the api side: internal routes + use cases on real adapters ---------------
    const api = requireFrom('api');
    const { createDeps } = api('./dist/adapters.js');
    const { startCuts } = api('./dist/usecases/recording-cuts.js');
    const { publishUpload } = api('./dist/usecases/publish.js');
    const { createInternalRecordingsRouter } = api('./dist/routes/recordings.js');
    const express = api('express');

    const shows = Object.fromEntries(SHOWS.map((id) => [id, { id, title: id, description: '', tags: [], imageUrl: null, date: '2026-10-01', mediaLinks: [] }]));
    const deps = {
      ...createDeps(),
      agenda: {
        getShow: async (id) => shows[id] ?? null,
        update: async () => {},
        resolveGenres: async (names) => names,
        liveState: async () => ({ isLive: false, resumeAt: null }),
      },
      platforms: { syncYoutube: async () => null, syncMixcloud: async () => null },
    };

    const app = express();
    app.use(express.json());
    app.use('/api/internal/recordings', createInternalRecordingsRouter(deps, env.WATCHER_API_KEY));
    // The worker's archive step writes the agenda links back here.
    app.patch('/api/watcher/shows/:id', (_req, res) => res.json({ ok: true }));
    internalApi = app.listen(13999);

    // --- cut two segments ---------------------------------------------------------
    const segments = [
      { startS: 0, endS: 20, showId: SHOWS[0] },
      { startS: 20, endS: 50, showId: SHOWS[1] },
    ];
    const started = await startCuts({ ref: rec.ref, segments }, deps);
    check('startCuts queues one job per segment', started.cuts.length === 2);

    const staged = await waitFor('both segments staged', async () => {
      const rows = await db`SELECT show_id, s3_key, filename, size_bytes FROM staged_uploads WHERE show_id = ANY(${SHOWS})`;
      return rows.length === 2 ? rows : null;
    }, 300000);
    const byShow = Object.fromEntries(staged.map((r) => [r.show_id, r]));

    for (const [i, show] of SHOWS.entries()) {
      const row = byShow[show];
      const want = segments[i].endS - segments[i].startS;
      check(`${show}: staged under incoming/ with the cut's filename`, row.s3_key.startsWith('incoming/') && row.filename.endsWith('.mp4'), row.filename);
      check(`${show}: object on S3 matches the recorded size`, (await store.size(row.s3_key)) === Number(row.size_bytes));
      const file = path.join(work, `${show}.mp4`);
      fs.writeFileSync(file, await store.get(row.s3_key));
      const seconds = probeSeconds(file);
      // Spec verification item 1: start AND end exact on a mid-GOP cut (keyframes every 2 s).
      check(`${show}: exactly ${want}s long (start and end exact)`, Math.abs(seconds - want) < 0.3, `${seconds}s`);
      check(`${show}: only track 1 survived`, audioStreams(file) === 1);
    }

    const [prov] = await db`SELECT cut_id, source_ref, cut_start_s, cut_end_s, status FROM multipart_uploads WHERE show_id = ${SHOWS[1]}`;
    check('the session records which cut it came from', prov.cut_id === started.cuts[1].cutId && prov.source_ref === rec.ref && prov.cut_start_s === 20 && prov.status === 'completed');

    const cleaned = await waitFor('the PC to drop its staging file', async () => (await agent(`/cuts/${started.cuts[0].cutId}`)).status === 404, 30000);
    check('the PC cleaned up after the upload', !!cleaned);

    // --- the archive keeps the exact length (spec verification item 2) ------------
    const published = await publishUpload(
      {
        showId: SHOWS[0], title: 'Rec A 01.10.2026 @ coming soon', description: '', tags: [], imageUrl: null,
        videoS3Key: byShow[SHOWS[0]].s3_key, platforms: ['youtube'], includeJingle: false, autoTrimSilence: false,
      },
      deps
    );
    const jobs = await waitFor('the publish pipeline', async () => {
      const rows = await db`SELECT platform, status, error FROM platform_jobs WHERE upload_id = ${published.uploadId}`;
      return rows.length >= 2 && rows.every((r) => r.status === 'done' || r.status === 'failed') ? rows : null;
    }, 300000);
    for (const j of jobs) check(`${j.platform} job done on the cut segment`, j.status === 'done', j.error ?? '');
    const [up] = await db`SELECT video_s3_key, duration_seconds FROM show_uploads WHERE id = ${published.uploadId}`;
    check('the archive kept the cut\'s exact length', Math.abs(up.duration_seconds - 20) <= 1, `${up.duration_seconds}s`);

    // --- a recording deleted by hand is a plain refusal, and breaks nothing -------
    fs.rmSync(path.join(recDir, NAME));
    fs.rmSync(path.join(recDir, '.show-uploader'), { recursive: true, force: true });
    await waitFor('the service to forget it', async () => ((await (await agent('/recordings')).json()).length === 0), 30000);
    const refused = await startCuts({ ref: rec.ref, segments: [segments[0]] }, deps).then(() => null, (e) => e);
    check('startCuts refuses a recording deleted by hand with NOT_FOUND', refused?.code === 'NOT_FOUND', refused?.message);
    check('segments already uploaded are untouched', (await store.size(byShow[SHOWS[1]].s3_key)) === Number(byShow[SHOWS[1]].size_bytes));
  } catch (err) {
    check('suite ran to the end', false, err instanceof Error ? err.message : String(err));
  } finally {
    watcher?.kill('SIGTERM');
    internalApi?.close();
    worker.stop();
    await db.end({ timeout: 2 });
    fs.rmSync(work, { recursive: true, force: true });
  }
  return finish(worker.log());
}
```

- [ ] **Step 3: Run the suite**

Run: `pnpm e2e recordings`
Expected: every line `PASS`, ending `recordings: N/N checks passed`. Needs docker and ffmpeg (with ffprobe).

If `exactly …s long` fails, **stop and report it**: it is spec verification item 1 and a design finding (the cut end or start is not exact), not something to loosen. If `the archive kept the cut's exact length` fails, that is verification item 2 (the edit list does not survive the archive remux); report it, and do not weaken the assertion.

- [ ] **Step 4: Run the other suites for regressions, then commit**

Run: `pnpm e2e`
Expected: worker, api and recordings suites all pass.

```bash
git add scripts/e2e
git commit -m "test(e2e): recordings feature on the real built service, api and worker"
```

---

### Task 18: Docs, config, deployment prerequisites and final verification

**Files:**
- Create: `docs/architecture/recordings-cut.md`
- Modify: `.env.example`, `AGENTS.md`, `README.md`, `docs/superpowers/specs/2026-10-01-recordings-cut-design.md`

**Interfaces:**
- Consumes: everything above. Produces: the documentation future agents read first, and the recorded verification outcomes.

- [ ] **Step 1: Configuration**

In `.env.example`, replace the comment above `WATCHER_API_KEY` with:

```
# Shared internal secret: authenticates the worker's write-back to the api and its calls to
# the api's internal recordings endpoints (and the legacy drop-folder notify route).
# Generate any long random string, e.g.
#   openssl rand -hex 32
```

and add after it:

```
# ── Recordings service on the OBS PC (cut a night into per-artist uploads) ───
# Reached over Tailscale from this stack. Leave both unset to turn the feature off: the
# Recordings page then says "OBS PC not reachable". Use the PC's Tailscale IP (container
# DNS does not resolve MagicDNS names). The token is the AGENT_TOKEN in the PC's
# watcher/.env, at least 16 characters; it also signs the editor's preview links.
RECORDINGS_AGENT_URL=http://100.64.0.10:8787
RECORDINGS_AGENT_TOKEN=generate-a-long-random-secret
```

- [ ] **Step 2: Architecture document**

```markdown
<!-- docs/architecture/recordings-cut.md -->
# Recordings cut — architecture

How one night's OBS recording becomes one archive upload per artist, and the rules the
code must keep. Design rationale: `docs/superpowers/specs/2026-10-01-recordings-cut-design.md`.

## The rule

> **The OBS PC's folder is the source of truth for recordings, and the operator may delete
> any file in it at any time. Nothing here stores recording state, and a missing file is
> never an error or an alert.** Video state still lives where
> `docs/architecture/video-lifecycle.md` puts it: the show record.

## The flow

1. **PC** (`watcher/`, a Windows service, not in Docker): watches the OBS recordings
   folder. A file whose mtime has stopped moving is finished. While any file is still
   growing, no ffmpeg work starts. A finished recording gets a verified MP4 master (video
   plus audio track 1 only, HEVC tagged `hvc1`), a small H.264 preview and waveform peaks.
2. **Operator** (`/recordings`): marks one segment per artist on the timeline and picks the
   show for each. Agenda times only *suggest*: they are draft markers, never trusted.
3. **api** `recordings.startCuts`: validates (domain rules), checks every show exists, and
   enqueues one `cut-recording` job per segment. The job id is deterministic from
   (recording, show, in, out), so a double confirm is one job.
4. **worker** `cut-recording`: asks the PC to cut (`ffmpeg -c copy`, exact start via an MP4
   edit list), learns the real size, asks the api to open a multipart session bound to the
   show, hands the PC the presigned part URLs, waits, then asks the api to complete.
5. **api** `completeUpload` (the same use case the browser's multipart route uses) finishes
   the S3 object and writes `staged_uploads[show]` atomically.
6. From there it is an ordinary staged recording: publish, then the archive job (loudness,
   remux, m4a), then the platforms. The archive job is unchanged.

## Who owns what

| Piece | Owns | Never |
|---|---|---|
| PC service | files, ffmpeg, uploading parts | holds credentials for the api, S3 or PocketBase; calls out on its own |
| worker job | sequencing and waiting | decides anything about shows; writes video state itself |
| api | sessions, completion, staged video, validation | trusts a caller-supplied `ref` (it must come from the PC's own list) |
| `packages/domain` | segment rules, the agent protocol types | I/O |

## Rules that must hold

- Only audio track 1 (the mix) is ever cut or remuxed. OBS records tracks 1, 3, 4; without
  an explicit `-map` ffmpeg would pick one silently.
- Cuts are stream copy. A cut's start and end are exact; `watcher/test/ffmpeg.test.ts` and
  `pnpm e2e recordings` pin it. If a change breaks them, fix the cut, never the assertion.
- Retries resume. The PC keeps a finished cut and the ETags of parts that landed; the api
  hands back the same session for the same cut. Only the final attempt (or a deleted
  recording) aborts the session and drops the PC's staged cut.
- The preview route is authenticated by a short-lived HMAC in the query, because a
  `<video>` cannot send a header. The signature comes from a query keyed by recording, so
  the `<video src>` never swaps while it plays.
- Retention (PC): a recording is removed `RETENTION_DAYS` after its newest successful cut
  upload. Never for a recording that was not cut.
- A manual OBS file split just produces more recordings; each is handled on its own.

## Operating it

- **Tailscale** runs on the OBS PC and on the Komodo host. Containers reach the PC's
  Tailscale IP through the host (Docker NATs outbound traffic), so the stack needs no
  sidecar. Allow only the Komodo host to reach TCP 8787 on the PC in the Tailscale ACL. If
  a container cannot reach the PC, add a Tailscale container to `docker-compose.prod.yml`
  and route `RECORDINGS_AGENT_URL` through it; do not widen the PC's listen address.
- Install and update the PC service per `watcher/README.md`.
- If the Recordings page says the PC is not reachable, check, in this order: the service is
  running, `curl -H "Authorization: Bearer <token>" http://<tailscale-ip>:8787/v1/health`
  from the Komodo host, the Tailscale ACL, `RECORDINGS_AGENT_URL`/`TOKEN` on the stack.
```

- [ ] **Step 3: AGENTS.md and README**

`AGENTS.md`:
- In the Layout table replace the `watcher/` row with: `| \`watcher/\` | The recordings service on the OBS PC (Windows service, not Docker): prepares recordings, cuts segments, uploads parts. Node/TS. See \`watcher/README.md\` and \`docs/architecture/recordings-cut.md\`. |`
- In the "Where things live" table add: `| OBS recordings and cuts | \`api/src/usecases/recording-cuts.ts\`, \`worker/src/jobs/cut-recording.ts\`, \`watcher/\` on the PC; the shared rules and agent protocol are in \`@show-uploader/domain\` (\`recording-segments.ts\`, \`recordings-contract.ts\`) |`
- In "Rules that have bitten before" add: `- **Recordings on the OBS PC are not state we own.** The operator deletes MKVs and MP4s by hand. The PC's folder is the truth, there is no recordings table, and a missing file ends a cut as \`source_gone\`, never an alert. Agenda times only suggest cuts; the operator confirms every segment.`
- In the Publish pipeline paragraph add one sentence: `A recording cut on the OBS PC enters the same pipeline as a staged video bound to its show (see \`docs/architecture/recordings-cut.md\`).`

`README.md`: update the intro bullet (line ~12) and the section `## Windows drop-folder watcher` (from its heading to the next `##` heading) to describe the recordings service: what it does, that it runs as a Windows service under WinSW, and a pointer to `watcher/README.md`; change the diagram line mentioning the watcher script to `recordings service (OBS PC) ──Tailscale──► worker`; and replace the `WATCHER_API_KEY` table row text with `Random secret — authenticates the worker's calls to the api`.

- [ ] **Step 4: Full verification**

Run each and expect success:

```bash
pnpm --filter @show-uploader/domain test
pnpm --filter @show-uploader/api test && pnpm --filter @show-uploader/api exec tsc --noEmit
pnpm --filter @show-uploader/worker test && pnpm --filter @show-uploader/worker exec tsc --noEmit
pnpm --filter @show-uploader/watcher test && pnpm --filter @show-uploader/watcher exec tsc --noEmit
pnpm --filter @show-uploader/ui test && pnpm --filter @show-uploader/ui build
pnpm e2e
```

- [ ] **Step 5: Verify on the real OBS PC (manual, before merging)**

None of this can be checked from a laptop; it is the part of the spec marked "cannot be verified from here". Do it with the operator present:

1. Install the service on the OBS PC (`watcher/README.md`), with Tailscale already running. From the Komodo host: `curl -H "Authorization: Bearer <token>" http://<tailscale-ip>:8787/v1/health` returns `{"ok":true,...}`.
2. Set `RECORDINGS_AGENT_URL` and `RECORDINGS_AGENT_TOKEN` in the Komodo stack's `.env`, merge nothing yet; deploy the branch only if the operator agrees (see Step 6). Confirm the Recordings page lists a real recording once it is prepared.
3. Cut two real segments from a real night, publish one to archive only, and record in the spec's "Verification items" section, as a dated line under each item: (1) measured end accuracy on the real HEVC file, (2) whether the archive kept the exact start/length, (3) whether the archive MP4 plays in Chrome on a machine without HEVC hardware decoding, (4) whether the api container reached the PC through the host.
4. Delete the MKV by hand on the PC and confirm the page simply stops listing it and nothing alerts.

If (3) fails, that is a pre-existing archive-playback issue to raise separately, not part of this change.

- [ ] **Step 6: Commit, push and open the PR (do not merge)**

```bash
git add docs AGENTS.md README.md .env.example
git commit -m "docs: recordings cut architecture, config and operations"
git push -u origin feat/recordings-cut
gh pr create --base master --title "feat: cut OBS recordings into per-artist uploads" --body "Adds a recordings service on the OBS PC (replacing the undeployed watcher), a worker cut-recording job, api use cases and a Recordings page. Spec: docs/superpowers/specs/2026-10-01-recordings-cut-design.md. Verified with unit tests, pnpm e2e and the manual checks recorded in the spec."
```

Do **not** merge: a push to `master` deploys within a minute. Merge only when the operator says the change should go live, someone is around to watch it, and no show is due to be published (`AGENTS.md`, Branching). The PR body carries no AI attribution line, per the project's commit rules.






