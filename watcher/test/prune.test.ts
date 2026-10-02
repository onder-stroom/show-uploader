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
