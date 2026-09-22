import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let workDir: string;

// The remux writes a real file so the fake bucket stores real bytes; the
// size check the job relies on then answers from what actually landed.
vi.mock('../../src/services/ffmpeg', () => ({
  remuxToMp4: vi.fn(async (_input: string, output: string) => {
    fs.writeFileSync(output, Buffer.alloc(4242));
  }),
  cleanup: vi.fn(),
}));

vi.mock('../../src/services/workspace', () => ({
  createWorkspace: vi.fn(() => ({ path: (n: string) => path.join(workDir, n), cleanup: vi.fn() })),
}));

import { remuxToMp4 } from '../../src/services/ffmpeg';
import { processPreview } from '../../src/jobs/preview';
import { fakeDeps } from '../fakes';

let deps: ReturnType<typeof fakeDeps>;

const makeJob = (videoS3Key: string) =>
  ({ data: { videoS3Key }, updateProgress: vi.fn(async () => {}) }) as any;

describe('processPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
    deps = fakeDeps({
      objects: { 'uploads/1785-rec.mkv': 10, 'uploads/rec.mkv': 10, 'uploads/rec.mp4': 10 },
    });
  });

  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('rewraps an mkv, repoints the row, then drops the original', async () => {
    const key = await processPreview(makeJob('uploads/1785-rec.mkv'), deps);

    expect(key).toBe('uploads/1785-rec.mp4');
    expect(vi.mocked(remuxToMp4)).toHaveBeenCalledTimes(1);
    expect(deps.store.upload).toHaveBeenCalledWith(expect.any(String), 'uploads/1785-rec.mp4', 'video/mp4');
    expect(deps.records.repointPreview).toHaveBeenCalledWith(
      'uploads/1785-rec.mkv',
      'uploads/1785-rec.mp4',
      '1785-rec.mp4',
      4242
    );
    expect(deps.store.delete).toHaveBeenCalledWith('uploads/1785-rec.mkv');
    expect([...deps.bucket.keys()]).toContain('uploads/1785-rec.mp4');
    expect([...deps.bucket.keys()]).not.toContain('uploads/1785-rec.mkv');
  });

  // The remux is untrimmed on purpose: the operator previews in order to decide
  // where to cut, and the archive job applies the trim later.
  it('does not pass any trim to the remux', async () => {
    await processPreview(makeJob('uploads/rec.mkv'), deps);

    const opts = vi.mocked(remuxToMp4).mock.calls[0][2];
    expect(opts).not.toHaveProperty('trimStart');
    expect(opts).not.toHaveProperty('trimEnd');
  });

  // A stale queued job must never rewrap-and-delete a file that is already the
  // MP4 — that would delete the only copy.
  it('is a no-op for a source that is already mp4', async () => {
    const key = await processPreview(makeJob('uploads/rec.mp4'), deps);

    expect(key).toBe('uploads/rec.mp4');
    expect(vi.mocked(remuxToMp4)).not.toHaveBeenCalled();
    expect(deps.store.delete).not.toHaveBeenCalled();
    expect(deps.records.repointPreview).not.toHaveBeenCalled();
  });

  // Verify-before-repoint is what makes this safe to run on the only copy.
  it('fails without repointing or deleting when the upload did not land', async () => {
    deps.store.size.mockResolvedValue(null);

    await expect(processPreview(makeJob('uploads/rec.mkv'), deps)).rejects.toThrow(/missing or empty/i);

    expect(deps.records.repointPreview).not.toHaveBeenCalled();
    expect(deps.store.delete).not.toHaveBeenCalled();
  });

  // A job queued before its record was replaced or removed would otherwise
  // delete a recording that nothing points at any more.
  it('keeps the source when no record was repointed', async () => {
    deps.records.repointPreview.mockResolvedValue(0);

    await expect(processPreview(makeJob('uploads/rec.mkv'), deps)).rejects.toThrow(/no pre-publish record/i);

    expect(deps.store.delete).not.toHaveBeenCalled();
  });
});
