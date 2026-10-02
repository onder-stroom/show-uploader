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

describe('hardening', () => {
  const stateOf = (ref: string) => lib.paths(ref).state;

  it.each([['empty', ''], ['corrupt', '{nope'], ['null', 'null'], ['wrong shape', '{}']])(
    'cleans up a %s sidecar and re-registers the original on the next sync',
    (_n, body) => {
      touch('night.mkv', 60_000);
      lib.sync(NOW);
      const [s] = lib.list();
      fs.writeFileSync(lib.paths(s.ref).master, 'big');
      fs.writeFileSync(stateOf(s.ref), body);
      expect(lib.get(s.ref)).toBeNull();
      lib.sync(NOW + 10_000);
      lib.sync(NOW + 20_000);
      expect(fs.existsSync(lib.paths(s.ref).master)).toBe(false);
      expect(lib.list()).toHaveLength(1);
      expect(lib.list()[0]).toMatchObject({ filename: 'night.mkv', state: 'preparing' });
    },
  );

  it('removes a corrupt sidecar dir even when the original is gone', () => {
    const p = touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [s] = lib.list();
    fs.writeFileSync(stateOf(s.ref), '{nope');
    fs.rmSync(p);
    lib.sync(NOW + 10_000);
    expect(fs.existsSync(lib.paths(s.ref).dir)).toBe(false);
  });

  it('a touched file yields one sidecar and the old ref dir is gone', () => {
    const p = touch('night.mkv', 60_000);
    lib.sync(NOW);
    const [old] = lib.list();
    fs.writeFileSync(lib.paths(old.ref).master, 'stale');
    touch('night.mkv', 30_000, 'longer content');
    lib.sync(NOW + 10_000);
    const list = lib.list();
    expect(list).toHaveLength(1);
    expect(list[0].ref).not.toBe(old.ref);
    expect(list[0].originalPath).toBe(p);
    expect(fs.existsSync(lib.paths(old.ref).dir)).toBe(false);
  });

  it.each(['..', '../x', '', 'zzzz'])('rejects invalid ref %j without touching disk', (ref) => {
    touch('night.mkv', 60_000);
    lib.sync(NOW);
    expect(() => lib.paths(ref)).toThrow();
    expect(lib.get(ref)).toBeNull();
    expect(lib.sourceFor(ref)).toBeNull();
    expect(() => lib.recordUpload(ref, 'c', NOW)).not.toThrow();
    expect(() => lib.remove(ref)).not.toThrow();
    expect(fs.existsSync(path.join(root, '.show-uploader'))).toBe(true);
    expect(lib.list()).toHaveLength(1);
  });
});
