import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config';
import { CutManager, putPartViaFetch } from './cuts';
import { buildCutArgs, buildPreviewArgs, buildRemuxArgs, computePeaks, probe, runFfmpeg } from './ffmpeg';
import { Library } from './library';
import type { Media } from './prepare';
import { tick } from './scheduler';
import { createServer } from './server';

const config = loadConfig();
const { tools } = config;

const library = new Library({
  recordingsDir: config.recordingsDir,
  workDir: config.workDir,
  stableWindowMs: config.stableWindowMs,
});

const media: Media = {
  probe: (file) => probe(tools, file),
  remux: (o) => runFfmpeg(tools.ffmpeg, buildRemuxArgs(o)),
  preview: (o) => runFfmpeg(tools.ffmpeg, buildPreviewArgs(o)),
  peaks: (file, audioStream) => computePeaks(tools, file, audioStream),
};

const cuts = new CutManager({
  library,
  cutFile: (o) => runFfmpeg(tools.ffmpeg, buildCutArgs(o)),
  putPart: putPartViaFetch,
  stagingDir: path.join(config.workDir, 'cuts'),
  mixAudioStream: config.mixAudioStream,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
cuts.load();

// A recording that failed last run gets another go after a restart; nothing retries it
// on its own, so one bad file cannot loop forever.
for (const s of library.list()) {
  if (s.state === 'failed') library.save({ ...s, state: 'preparing', error: null });
}

let recordingActive = false;
let busy = false;

async function loop(): Promise<void> {
  if (busy) return; // a long prepare must not overlap the next tick
  busy = true;
  try {
    recordingActive = (
      await tick(
        { library, media, mixAudioStream: config.mixAudioStream, retentionMs: config.retentionDays * 86_400_000 },
        Date.now()
      )
    ).recordingActive;
  } catch (err) {
    console.error('background pass failed:', err);
  } finally {
    busy = false;
  }
}

const app = createServer({ token: config.token, library, cuts, status: () => ({ recordingActive }) });
app.listen(config.listenPort, config.listenHost, () => {
  console.log(`recordings service on http://${config.listenHost}:${config.listenPort} watching ${config.recordingsDir}`);
});

void loop();
setInterval(() => void loop(), config.scanIntervalMs);
