import { UnrecoverableError, type Job } from 'bullmq';
import type { AgentCut, CutJobPayload, CutStep } from '@show-uploader/domain';
import type { WorkerDeps } from '../ports';

type Deps = Pick<WorkerDeps, 'agent' | 'sessions' | 'config'>;
type Opts = { sleep?: (ms: number) => Promise<void>; now?: () => number };

// Polls may fail (a network blip, the client's own timeout) without the wait ending: give
// up only when they have failed continuously for this long.
const POLL_FAILURE_LIMIT_MS = 5 * 60_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// BullMQ counts finished attempts in attemptsMade, so this is the last one when one
// more would reach the limit.
const isFinalAttempt = (job: Job) => job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

/**
 * Cut one segment of an OBS recording on the PC and make it that show's staged video.
 *
 * The PC cuts and uploads; the api opens the multipart session and completes it (so the
 * staged video is recorded by the same rule as a browser upload). This job only
 * sequences them and waits, and every step is safe to repeat:
 *  - an existing cut on the PC is reused, never re-cut, so a retry resumes the upload and
 *    parts that already landed are not sent again;
 *  - the api hands the same session back for the same cut;
 *  - a cut the api already completed is recognised and only cleaned up.
 * A recording the operator deleted is permanent (UnrecoverableError): retrying cannot help.
 */
export async function processCutRecording(job: Job<CutJobPayload>, { agent, sessions, config }: Deps, opts: Opts = {}): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const { cutId, ref, filename, showId, startS, endS } = job.data;
  const step = (s: CutStep) => job.updateProgress({ step: s });

  // Poll until `done` holds. A failed upload or a vanished recording ends the wait.
  // `resume` is for a PC that forgot it was uploading (restart): when a poll sees state
  // `cut` it is asked to upload again.
  async function waitFor(
    first: AgentCut,
    done: (c: AgentCut) => boolean,
    timeoutMs: number,
    what: string,
    resume?: () => Promise<AgentCut>
  ): Promise<AgentCut> {
    let deadline = now() + timeoutMs;
    let current = first;
    let failingSince: number | null = null;
    for (;;) {
      if (current.state === 'source_gone') throw new UnrecoverableError(current.reason ?? 'The recording was deleted from the PC');
      if (done(current)) return current;
      if (current.state === 'failed') throw new Error(current.reason ?? 'The PC reported a failure');
      // Time the PC spends deliberately paused (OBS is recording) does not count.
      if (current.paused) deadline = now() + timeoutMs;
      if (now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(config.cutPoll.intervalMs);
      let next: AgentCut | null;
      try {
        next = await agent.cut(cutId);
        if (next && resume && next.state === 'cut') next = await resume();
        failingSince = null;
      } catch (err) {
        failingSince ??= now();
        if (now() - failingSince > POLL_FAILURE_LIMIT_MS) throw err;
        continue;
      }
      if (!next) throw new Error('The recordings service has no record of this cut');
      current = next;
    }
  }

  let sessionId: string | null = null;
  try {
    await step('cutting');
    // Reuse a cut the PC still has (a retry): re-cutting would throw away parts that
    // already landed. A failed cut with no size never produced a file, so it is redone.
    let existing = await agent.cut(cutId);
    if (!existing || existing.state === 'source_gone' || (existing.state === 'failed' && existing.sizeBytes === null)) {
      existing = await agent.startCut({ cutId, ref, startS, endS });
    }
    const ready = await waitFor(
      existing,
      (c) => c.state === 'cut' || c.state === 'uploading' || c.state === 'done' || (c.state === 'failed' && c.sizeBytes !== null),
      config.cutPoll.cutTimeoutMs,
      'the cut'
    );
    if (ready.sizeBytes === null) throw new Error('The PC reported no size for the cut');

    const opened = await sessions.open({ cutId, showId, filename, size: ready.sizeBytes, ref, startS, endS });
    sessionId = opened.sessionId;

    if (!opened.completed) {
      await step('uploading');
      const startUpload = () => agent.upload(cutId, { partSize: opened.partSize, parts: opened.parts });
      const started = ready.state === 'done' ? ready : await startUpload();
      // A failure here is an upload failure, never "resumable": the wait must throw.
      await waitFor(started, (c) => c.state === 'done', config.cutPoll.uploadTimeoutMs, 'the upload', startUpload);
      await step('finishing');
      await sessions.complete(sessionId);
    }

    await agent.drop(cutId);
    return filename;
  } catch (err) {
    // Give the session and the PC's staged cut up only when nothing more will try: an
    // earlier attempt's finished parts are exactly what a retry resumes from.
    if (err instanceof UnrecoverableError || isFinalAttempt(job)) {
      if (sessionId) await sessions.abort(sessionId).catch((e) => console.warn(`Could not abort session ${sessionId}:`, e));
      await agent.drop(cutId);
    }
    throw err;
  }
}
