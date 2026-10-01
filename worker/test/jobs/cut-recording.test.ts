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

  describe('polling', () => {
    const uploading = () => cut({ state: 'uploading' });

    it('a failed poll does not end the wait: it keeps polling and completes', async () => {
      const deps = fakeDeps();
      deps.agent.upload.mockResolvedValueOnce(uploading());
      deps.agent.cut
        .mockResolvedValueOnce(null) // the initial lookup: no cut yet
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(cut({ state: 'done' }));
      await expect(run(deps)).resolves.toBe(payload.filename);
      expect(deps.sessions.complete).toHaveBeenCalledTimes(1);
    });

    it('polls that keep failing for minutes fail the attempt, aborting nothing before the last one', async () => {
      const deps = fakeDeps();
      deps.config.cutPoll.uploadTimeoutMs = 10 * 60 * 60_000;
      deps.agent.upload.mockResolvedValueOnce(uploading());
      deps.agent.cut.mockResolvedValueOnce(null).mockRejectedValue(new Error('fetch failed'));
      let t = 0;
      await expect(run(deps, fakeJob(payload, 'bull-1', { attempts: 3, attemptsMade: 0 }), () => (t += 60_000))).rejects.toThrow('fetch failed');
      expect(deps.sessions.abort).not.toHaveBeenCalled();
      expect(deps.agent.drop).not.toHaveBeenCalled();
    });

    it('a success resets the failure run', async () => {
      const deps = fakeDeps();
      deps.config.cutPoll.uploadTimeoutMs = 10 * 60 * 60_000;
      deps.agent.upload.mockResolvedValueOnce(uploading());
      const fail = new Error('fetch failed');
      deps.agent.cut
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(fail).mockRejectedValueOnce(fail).mockRejectedValueOnce(fail)
        .mockResolvedValueOnce(uploading())
        .mockRejectedValueOnce(fail).mockRejectedValueOnce(fail).mockRejectedValueOnce(fail)
        .mockResolvedValueOnce(cut({ state: 'done' }));
      let t = 0;
      await expect(run(deps, fakeJob(payload), () => (t += 60_000))).resolves.toBe(payload.filename);
    });

    it('a PC that forgot it was uploading (state cut) is asked to upload again with the same parts', async () => {
      const deps = fakeDeps();
      deps.agent.upload.mockResolvedValueOnce(uploading()).mockResolvedValueOnce(uploading());
      deps.agent.cut
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cut({ state: 'cut' }))
        .mockResolvedValueOnce(cut({ state: 'done' }));
      await expect(run(deps)).resolves.toBe(payload.filename);
      expect(deps.agent.upload).toHaveBeenCalledTimes(2);
      expect(deps.agent.upload.mock.calls[1]).toEqual(deps.agent.upload.mock.calls[0]);
    });
  });
});
