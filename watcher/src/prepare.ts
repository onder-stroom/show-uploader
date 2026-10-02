import fs from 'node:fs';
import path from 'node:path';
import type { ProbeResult } from './ffmpeg';
import type { Library, Sidecar } from './library';

/** What preparing needs from ffmpeg. A seam so the state machine tests without a binary. */
export type Media = {
  probe(file: string): Promise<ProbeResult>;
  remux(o: { input: string; output: string; audioStream: number; videoCodec: string | null }): Promise<void>;
  preview(o: { input: string; output: string; audioStream: number }): Promise<void>;
  peaks(file: string, audioStream: number): Promise<number[]>;
};

// A frame at 25 fps is 0.04 s; a remux that drifts further than this lost something.
const DURATION_TOLERANCE_S = 0.25;

/**
 * Make one recording usable by the editor: a verified MP4 master (MKV only), a small
 * H.264 preview, and waveform peaks. Each stage writes to a `.part` file and renames
 * once it is whole, and each is skipped when its flag is set, so a crash or restart
 * resumes where it stopped. A media failure never throws: the sidecar ends `failed`
 * with the reason, so one bad file cannot stall the others.
 */
export async function prepareRecording(
  deps: { library: Library; media: Media; mixAudioStream: number },
  ref: string
): Promise<Sidecar | null> {
  const { library, media, mixAudioStream } = deps;
  const initial = library.get(ref);
  if (!initial) return null;
  let s: Sidecar = initial;
  const p = library.paths(ref);

  const first = library.sourceFor(ref);
  if (!first) return s; // deleted meanwhile; the next sync forgets it

  const save = (patch: Partial<Sidecar>) => {
    s = { ...s, ...patch };
    library.save(s);
  };

  try {
    if (s.durationS === null || s.videoCodec === null) {
      const info = await media.probe(first);
      save({ durationS: info.durationS, videoCodec: info.videoCodec });
    }

    const isMp4 = path.extname(s.originalPath).toLowerCase() === '.mp4';
    if (!isMp4 && !s.hasMaster) {
      const part = path.join(p.dir, 'master.part.mp4');
      await media.remux({ input: s.originalPath, output: part, audioStream: mixAudioStream, videoCodec: s.videoCodec });
      const check = await media.probe(part);
      if (Math.abs(check.durationS - (s.durationS ?? 0)) > DURATION_TOLERANCE_S || check.audioStreams !== 1) {
        fs.rmSync(part, { force: true });
        throw new Error(
          `Remux verification failed (${check.durationS}s vs ${s.durationS}s, ${check.audioStreams} audio streams)`
        );
      }
      fs.renameSync(part, p.master);
      save({ hasMaster: true });
    }

    const playable = library.sourceFor(ref);
    if (!playable) return s;
    // The master carries exactly one audio stream; an original MP4 still has all tracks.
    const audioStream = s.hasMaster ? 0 : isMp4 ? mixAudioStream : 0;

    if (!s.hasPreview) {
      const part = path.join(p.dir, 'preview.part.mp4');
      await media.preview({ input: playable, output: part, audioStream });
      fs.renameSync(part, p.preview);
      save({ hasPreview: true });
    }

    if (!s.hasPeaks) {
      fs.writeFileSync(p.peaks, JSON.stringify(await media.peaks(playable, audioStream)));
      save({ hasPeaks: true });
    }

    save({ state: 'ready', error: null });
  } catch (err) {
    save({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
  return s;
}
