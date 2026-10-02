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
