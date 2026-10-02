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

  it('reports the OBS state before any prepare starts, so a pause lifts without waiting for it', async () => {
    age('a.mkv', 60_000);
    const m = media();
    const order: string[] = [];
    m.probe = vi.fn(async () => (order.push('probe'), { durationS: 10, videoCodec: 'h264', audioStreams: 1 }));
    await tick({ library: lib, media: m, mixAudioStream: 0, retentionMs: 1e12 }, NOW, (a) => order.push(`active:${a}`));
    expect(order.slice(0, 2)).toEqual(['active:false', 'probe']);
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
