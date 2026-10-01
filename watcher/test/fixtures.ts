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
