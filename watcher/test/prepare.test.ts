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

  it('survives a rescan that finds the original deleted mid-prepare, and is forgotten once it ends', async () => {
    const ref = register('night.mkv');
    const original = lib.get(ref)!.originalPath;
    const media = fakeMedia({
      remux: vi.fn(async (o) => {
        fs.rmSync(original); // the operator deletes it while ffmpeg runs
        lib.sync(NOW + 10_000); // and a rescan comes in
        expect(fs.existsSync(path.dirname(o.output))).toBe(true);
        fs.writeFileSync(o.output, 'mp4');
      }),
    });
    await prepareRecording({ library: lib, media, mixAudioStream: 0 }, ref);
    expect(lib.list()).toHaveLength(1);
    lib.sync(NOW + 20_000);
    expect(lib.list()).toEqual([]);
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
