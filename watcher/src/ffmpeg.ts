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
