import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  RECORDINGS_DIR: z.string().min(1),
  // Derived files (MP4, preview, peaks, sidecars, cut staging). Default: a hidden
  // folder next to the recordings so the OBS folder itself stays as OBS left it.
  WORK_DIR: z.string().min(1).optional(),
  AGENT_TOKEN: z.string().min(16, 'AGENT_TOKEN must be at least 16 characters'),
  // Loopback by default. In production set this to the PC's Tailscale IP so the
  // service is reachable over the tailnet and nowhere else.
  LISTEN_HOST: z.string().default('127.0.0.1'),
  LISTEN_PORT: z.coerce.number().int().positive().default(8787),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  // A file whose mtime is this old has stopped growing, so OBS is done with it.
  STABLE_WINDOW_MS: z.coerce.number().int().positive().default(20_000),
  SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RETENTION_DAYS: z.coerce.number().positive().default(14),
  // Index among the file's AUDIO streams that holds the mix. OBS records tracks
  // 1, 3 and 4, which appear in that order, so track 1 is stream 0.
  MIX_AUDIO_STREAM: z.coerce.number().int().min(0).default(0),
});

export type Config = {
  recordingsDir: string;
  workDir: string;
  token: string;
  listenHost: string;
  listenPort: number;
  tools: { ffmpeg: string; ffprobe: string };
  stableWindowMs: number;
  scanIntervalMs: number;
  retentionDays: number;
  mixAudioStream: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  return {
    recordingsDir: e.RECORDINGS_DIR,
    workDir: e.WORK_DIR ?? path.join(e.RECORDINGS_DIR, '.show-uploader'),
    token: e.AGENT_TOKEN,
    listenHost: e.LISTEN_HOST,
    listenPort: e.LISTEN_PORT,
    tools: { ffmpeg: e.FFMPEG_PATH, ffprobe: e.FFPROBE_PATH },
    stableWindowMs: e.STABLE_WINDOW_MS,
    scanIntervalMs: e.SCAN_INTERVAL_MS,
    retentionDays: e.RETENTION_DAYS,
    mixAudioStream: e.MIX_AUDIO_STREAM,
  };
}
