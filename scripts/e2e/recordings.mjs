// scripts/e2e/recordings.mjs
/**
 * The whole recordings feature on the real built pieces: the recordings service
 * (watcher/dist) watching a real folder with a real 3-audio-track MKV, the built api
 * routes and use cases, the built worker, and real MinIO, Postgres and Redis. Only
 * PocketBase (agenda) is stubbed.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ROOT, bucket, database, env, probeSeconds, reporter, requireFrom, scratchDir, startWorker, waitFor,
} from './lib.mjs';

Object.assign(process.env, env);

const PORT = 18787;
const TOKEN = env.RECORDINGS_AGENT_TOKEN;
const NAME = '2026-10-01_20-00-00.mkv';
const SHOWS = ['show-rec-a', 'show-rec-b'];

// OBS here records HEVC; use it when this ffmpeg can, so the hvc1 path is exercised.
function makeNight(file) {
  const hevc = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libx265');
  const video = hevc
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:min-keyint=50:scenecut=0:log-level=none']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0'];
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=1320:sample_rate=48000',
    '-t', '90', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a',
    ...video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac:a:0', '1', '-ac:a:1', '2', '-ac:a:2', '2', file,
  ]);
  // Old enough that the service sees it as finished at once.
  const t = new Date(Date.now() - 120_000);
  fs.utimesSync(file, t, t);
  return hevc ? 'hevc' : 'h264';
}

// One "sample_rate,channels" line per audio stream. Track 1 is the only mono 44.1 kHz one.
const audioStreams = (file) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels,sample_rate', '-of', 'csv=p=0', file])
    .toString().trim().split('\n').filter(Boolean);
const onlyTrackOne = (file) => {
  const a = audioStreams(file);
  return a.length === 1 && a[0] === '44100,1';
};

export async function run() {
  const { check, finish } = reporter('recordings');
  const work = scratchDir('e2e-rec-');
  const recDir = path.join(work, 'obs');
  fs.mkdirSync(recDir);
  const store = await bucket();
  const db = await database();
  const worker = startWorker();
  let watcher;
  let watcherLog = '';
  let internalApi;

  const agent = (p, init = {}) =>
    fetch(`http://127.0.0.1:${PORT}/v1${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });

  try {
    // Stale rows from a kept earlier run; platform_jobs go with their show_uploads (ON DELETE CASCADE).
    await db`DELETE FROM show_uploads WHERE show_id = ANY(${SHOWS})`;
    await db`DELETE FROM staged_uploads WHERE show_id = ANY(${SHOWS})`;
    await db`DELETE FROM multipart_uploads WHERE show_id = ANY(${SHOWS})`;

    const codec = makeNight(path.join(recDir, NAME));
    watcher = spawn('node', [path.join(ROOT, 'watcher/dist/index.js')], {
      cwd: work, // so dotenv can never pick up a real .env
      env: {
        ...process.env, RECORDINGS_DIR: recDir, AGENT_TOKEN: TOKEN, LISTEN_HOST: '127.0.0.1', LISTEN_PORT: String(PORT),
        STABLE_WINDOW_MS: '1000', SCAN_INTERVAL_MS: '500', FFMPEG_PATH: 'ffmpeg', FFPROBE_PATH: 'ffprobe',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    watcher.stdout.on('data', (d) => (watcherLog += d));
    watcher.stderr.on('data', (d) => (watcherLog += d));

    // --- the PC prepares the recording ------------------------------------------
    const rec = await waitFor('the service to prepare the recording', async () => {
      const res = await agent('/recordings').catch(() => null);
      const list = res?.ok ? await res.json() : [];
      return list.find((r) => r.state === 'ready') ?? null;
    }, 120000);
    check(`the service prepared the ${codec} recording`, rec.hasPreview && Math.abs(rec.durationS - 90) < 1, JSON.stringify(rec));
    const unauth = await fetch(`http://127.0.0.1:${PORT}/v1/recordings`).catch(() => null);
    check('the service refuses a call without the token', unauth?.status === 401, String(unauth?.status));
    const ranged = await agent(`/recordings/${rec.ref}/preview`, { headers: { Range: 'bytes=0-99' } });
    check('the preview is served with Range support', ranged.status === 206);

    // --- the api side: internal routes + use cases on real adapters ---------------
    const api = requireFrom('api');
    const { createDeps } = api('./dist/adapters.js');
    const { startCuts } = api('./dist/usecases/recording-cuts.js');
    const { publishUpload } = api('./dist/usecases/publish.js');
    const { createInternalRecordingsRouter } = api('./dist/routes/recordings.js');
    const express = api('express');

    const shows = Object.fromEntries(SHOWS.map((id) => [id, { id, title: id, description: '', tags: [], imageUrl: null, date: '2026-10-01', mediaLinks: [] }]));
    const deps = {
      ...createDeps(),
      agenda: {
        getShow: async (id) => shows[id] ?? null,
        update: async () => {},
        resolveGenres: async (names) => names,
        liveState: async () => ({ isLive: false, resumeAt: null }),
      },
      platforms: { syncYoutube: async () => null, syncMixcloud: async () => null },
    };

    const app = express();
    app.use(express.json());
    app.use('/api/internal/recordings', createInternalRecordingsRouter(deps, env.WATCHER_API_KEY));
    // The worker's archive step writes the agenda links back here.
    app.patch('/api/watcher/shows/:id', (_req, res) => res.json({ ok: true }));
    internalApi = await new Promise((resolve, reject) => {
      const server = app.listen(13999, () => resolve(server));
      server.on('error', reject);
    });

    // --- cut two segments ---------------------------------------------------------
    const segments = [
      // Both start and end mid-GOP (keyframes every 2 s), and at least the 30 s minimum.
      { startS: 1, endS: 31, showId: SHOWS[0] },
      { startS: 33.5, endS: 65.5, showId: SHOWS[1] },
    ];
    const started = await startCuts({ ref: rec.ref, segments }, deps);
    check('startCuts queues one job per segment', started.cuts.length === 2);

    const staged = await waitFor('both segments staged', async () => {
      const rows = await db`SELECT show_id, s3_key, filename, size_bytes FROM staged_uploads WHERE show_id = ANY(${SHOWS})`;
      return rows.length === 2 ? rows : null;
    }, 300000);
    const byShow = Object.fromEntries(staged.map((r) => [r.show_id, r]));

    for (const [i, show] of SHOWS.entries()) {
      const row = byShow[show];
      const want = segments[i].endS - segments[i].startS;
      check(`${show}: staged under incoming/ with the cut's filename`, row.s3_key.startsWith('incoming/') && row.filename.endsWith('.mp4'), row.filename);
      check(`${show}: object on S3 matches the recorded size`, (await store.size(row.s3_key)) === Number(row.size_bytes));
      const file = path.join(work, `${show}.mp4`);
      fs.writeFileSync(file, await store.get(row.s3_key));
      const seconds = probeSeconds(file);
      // Spec verification item 1: start AND end exact on a mid-GOP cut (keyframes every 2 s).
      check(`${show}: exactly ${want}s long (start and end exact)`, Math.abs(seconds - want) < 0.3, `${seconds}s`);
      check(`${show}: only track 1 (mono, 44.1 kHz) survived`, onlyTrackOne(file), audioStreams(file).join(' | '));
    }

    const provRows = await db`SELECT show_id, cut_id, source_ref, cut_start_s, cut_end_s, status FROM multipart_uploads WHERE show_id = ANY(${SHOWS})`;
    check('each session records which cut it came from', segments.every((seg, i) => {
      const p = provRows.find((r) => r.show_id === SHOWS[i]);
      return p && p.cut_id === started.cuts[i].cutId && p.source_ref === rec.ref
        && p.cut_start_s === seg.startS && p.cut_end_s === seg.endS && p.status === 'completed';
    }), JSON.stringify(provRows));

    const cleaned = await waitFor('the PC to drop its staging file', async () => (await agent(`/cuts/${started.cuts[0].cutId}`)).status === 404, 30000);
    check('the PC cleaned up after the upload', !!cleaned);

    // --- the archive keeps the exact length (spec verification item 2) ------------
    const published = await publishUpload(
      {
        showId: SHOWS[0], title: 'Rec A 01.10.2026 @ coming soon', description: '', tags: [], imageUrl: null,
        videoS3Key: byShow[SHOWS[0]].s3_key, platforms: ['youtube'], includeJingle: false, autoTrimSilence: false,
      },
      deps
    );
    const jobs = await waitFor('the publish pipeline', async () => {
      const rows = await db`SELECT platform, status, error FROM platform_jobs WHERE upload_id = ${published.uploadId}`;
      return rows.length >= 2 && rows.every((r) => r.status === 'done' || r.status === 'failed') ? rows : null;
    }, 300000);
    for (const j of jobs) check(`${j.platform} job done on the cut segment`, j.status === 'done', j.error ?? '');
    const [up] = await db`SELECT video_s3_key, duration_seconds FROM show_uploads WHERE id = ${published.uploadId}`;
    check('the archive kept the cut\'s exact length', Math.abs(up.duration_seconds - 30) <= 1, `${up.duration_seconds}s`);
    const archived = path.join(work, 'archived.mp4');
    fs.writeFileSync(archived, await store.get(up.video_s3_key));
    // The archive's loudness pass resamples (96 kHz), so only the stream count and mono are stable.
    const arch = audioStreams(archived);
    check('the archived MP4 still holds a single mono audio stream (track 1)', arch.length === 1 && arch[0].endsWith(',1'), arch.join(' | '));

    // --- a recording deleted by hand is a plain refusal, and breaks nothing -------
    fs.rmSync(path.join(recDir, NAME));
    fs.rmSync(path.join(recDir, '.show-uploader'), { recursive: true, force: true });
    await waitFor('the service to forget it', async () => ((await (await agent('/recordings')).json()).length === 0), 30000);
    const refused = await startCuts({ ref: rec.ref, segments: [segments[0]] }, deps).then(() => null, (e) => e);
    check('startCuts refuses a recording deleted by hand with NOT_FOUND', refused?.code === 'NOT_FOUND', refused?.message);
    check('segments already uploaded are untouched', (await store.size(byShow[SHOWS[1]].s3_key)) === Number(byShow[SHOWS[1]].size_bytes));
  } catch (err) {
    check('suite ran to the end', false, err instanceof Error ? err.message : String(err));
  } finally {
    watcher?.kill('SIGTERM');
    internalApi?.close();
    worker.stop();
    await db.end({ timeout: 2 });
    fs.rmSync(work, { recursive: true, force: true });
  }
  return finish(worker.log() + (watcherLog ? `\n--- watcher log (tail) ---\n${watcherLog.slice(-2000)}` : ''));
}
