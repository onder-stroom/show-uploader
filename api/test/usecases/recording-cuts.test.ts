import { describe, it, expect } from 'vitest';
import type { AgentRecording } from '@show-uploader/domain';
import { verifyPreview } from '../../src/services/preview-signature';
import { UseCaseError } from '../../src/usecases/errors';
import {
  cutIdFor, cutStatuses, deriveCutStatus, listRecordings, openCutSession, recordingPeaks, rescanRecordings, signPreviewPath, startCuts,
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

describe('rescanRecordings', () => {
  it('asks the PC to rescan and answers like the list, reachable or not', async () => {
    const deps = fakeDeps({ recordings: [rec()] });
    expect(await rescanRecordings(deps)).toEqual({ reachable: true, recordings: [rec()] });
    expect(deps.recordings.rescan).toHaveBeenCalledTimes(1);
    expect(deps.recordings.list).not.toHaveBeenCalled();
    expect(await rescanRecordings(fakeDeps({ recordings: null }))).toEqual({ reachable: false });
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
    expect(await verifyPreview(url.searchParams.get('t')!, 'r1', 's'.repeat(24), 1_800_000_000_000)).toBe(true);

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
