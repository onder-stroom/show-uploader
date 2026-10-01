import type { Library } from './library';
import { prepareRecording, type Media } from './prepare';
import { pruneOnce } from './prune';

/**
 * One pass of the service's background work. Preparing runs ffmpeg for minutes, so it
 * only starts while no file in the folder is still growing, and at most one recording
 * per pass. Everything else here is cheap file bookkeeping.
 */
export async function tick(
  deps: { library: Library; media: Media; mixAudioStream: number; retentionMs: number },
  nowMs: number
): Promise<{ recordingActive: boolean }> {
  const { recordingActive } = deps.library.sync(nowMs);

  if (!recordingActive) {
    const next = deps.library.list().find((s) => s.state === 'preparing');
    if (next) await prepareRecording({ library: deps.library, media: deps.media, mixAudioStream: deps.mixAudioStream }, next.ref);
  }

  pruneOnce({ library: deps.library, retentionMs: deps.retentionMs }, nowMs);
  return { recordingActive };
}
