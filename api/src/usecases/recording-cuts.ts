import { createHash } from 'node:crypto';
import {
  AGENT_PROTOCOL, cutFilename, parseDraftSegments, validateSegments,
  type AgentRecording, type CutStep, type RecordingDraft, type UnreachableAgent,
} from '@show-uploader/domain';
import type { ApiDeps, CutJobView } from '../ports';
import { signPreview } from '../services/preview-signature';
import { UseCaseError } from './errors';
import { openUploadSession } from './uploads';

function reachability(list: AgentRecording[] | null) {
  return list ? ({ reachable: true, recordings: list } as { reachable: true; recordings: AgentRecording[] }) : ({ reachable: false } as UnreachableAgent);
}

export async function listRecordings({ recordings }: Pick<ApiDeps, 'recordings'>) {
  return reachability(await recordings.list());
}

/**
 * Which build of the PC service answers, and whether it is new enough for what the uploader does.
 * A service that reports no protocol predates the number and counts as 1.
 */
export async function agentStatus({ recordings }: Pick<ApiDeps, 'recordings'>) {
  const h = await recordings.health();
  if (!h) return { reachable: false } as UnreachableAgent;
  const protocol = typeof h.protocol === 'number' ? h.protocol : 1;
  return { reachable: true as const, protocol, build: typeof h.build === 'string' ? h.build : null, expected: AGENT_PROTOCOL, current: protocol >= AGENT_PROTOCOL };
}

export type DraftProblem = 'unreachable' | 'outdated';

/**
 * The segments saved for a recording. Opening the editor must never fail because of them, so a PC
 * that is off or too old is an answer ("problem"), not an error: the editor just starts empty.
 */
export async function loadDraft(ref: string, { recordings }: Pick<ApiDeps, 'recordings'>): Promise<{ draft: RecordingDraft | null; problem: DraftProblem | null }> {
  const r = await recordings.getDraft(ref);
  switch (r.kind) {
    case 'ok': return { draft: r.draft, problem: null };
    case 'unsupported': return { draft: null, problem: 'outdated' };
    case 'gone': throw new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC');
    default: return { draft: null, problem: 'unreachable' };
  }
}

/** Save the operator's segments next to the recording on the PC. Saving is asked for, so a failure says why. */
export async function saveDraft(ref: string, segments: unknown, { recordings }: Pick<ApiDeps, 'recordings'>): Promise<RecordingDraft> {
  const clean = parseDraftSegments(segments);
  if (!clean) throw new UseCaseError('PRECONDITION_FAILED', 'Those segments cannot be saved');
  const r = await recordings.saveDraft(ref, clean);
  switch (r.kind) {
    case 'ok': return r.draft ?? { segments: [], savedAtMs: Date.now() };
    case 'unsupported': throw new UseCaseError('PRECONDITION_FAILED', 'The PC service is too old to save segments. Update it, then try again.');
    case 'gone': throw new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC');
    case 'rejected': throw new UseCaseError('PRECONDITION_FAILED', 'The PC refused those segments');
    default: throw new UseCaseError('PRECONDITION_FAILED', 'The OBS PC is not reachable, so nothing was saved');
  }
}

/** Same answer as the list, after the PC has looked at its folder again. */
export async function rescanRecordings({ recordings }: Pick<ApiDeps, 'recordings'>) {
  return reachability(await recordings.rescan());
}

/**
 * Deterministic from what is being cut, so a double confirm is the same job. It is also
 * the BullMQ job id (no colons) and the PC's cut id (A-Z a-z 0-9 _ -).
 */
export function cutIdFor(ref: string, showId: string, startS: number, endS: number): string {
  const r = (n: number) => n.toFixed(3);
  return createHash('sha1').update(`${ref}|${showId}|${r(startS)}|${r(endS)}`).digest('hex');
}

type SegmentInput = { startS: number; endS: number; showId: string };

export async function startCuts(
  input: { ref: string; segments: SegmentInput[] },
  { recordings, agenda, cuts }: Pick<ApiDeps, 'recordings' | 'agenda' | 'cuts'>
) {
  if (input.segments.length === 0) throw new UseCaseError('PRECONDITION_FAILED', 'Nothing to cut');

  const list = await recordings.list();
  if (!list) throw new UseCaseError('PRECONDITION_FAILED', 'The OBS PC is not reachable');
  const recording = list.find((r) => r.ref === input.ref);
  // The operator may delete a recording at any time; that is not a bug, just a fact.
  if (!recording) throw new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC (it may have been deleted)');
  if (recording.state !== 'ready' || recording.durationS === null) {
    throw new UseCaseError('PRECONDITION_FAILED', 'The recording is still being prepared');
  }

  const problems = validateSegments(input.segments, recording.durationS);
  if (problems.length > 0) {
    throw new UseCaseError('PRECONDITION_FAILED', `Segment ${problems[0].index + 1}: ${problems[0].message}`);
  }

  const showIds = input.segments.map((s) => s.showId);
  if (new Set(showIds).size !== showIds.length) {
    throw new UseCaseError('CONFLICT', 'Each show can only receive one segment');
  }
  for (const showId of showIds) {
    if (!(await agenda.getShow(showId))) throw new UseCaseError('NOT_FOUND', `Show ${showId} was not found`);
  }

  // Everything is validated above, so either every segment is queued or none is.
  const out: { cutId: string; showId: string }[] = [];
  for (const seg of input.segments) {
    const cutId = cutIdFor(input.ref, seg.showId, seg.startS, seg.endS);
    await cuts.enqueue({
      cutId, ref: input.ref, showId: seg.showId, startS: seg.startS, endS: seg.endS,
      filename: cutFilename(recording.filename, seg.startS, seg.endS),
    });
    out.push({ cutId, showId: seg.showId });
  }
  return { cuts: out };
}

export type CutStatus = { state: 'queued' | CutStep | 'done' | 'failed' | 'unknown'; error: string | null };

/** What the operator sees for a cut, from the queue's view of it. Pure so it tests without Redis. */
export function deriveCutStatus(job: CutJobView): CutStatus {
  if (!job) return { state: 'unknown', error: null };
  switch (job.status) {
    case 'completed':
      return { state: 'done', error: null };
    case 'failed':
      return { state: 'failed', error: job.failedReason ?? 'The cut failed' };
    case 'active':
      return { state: job.step ?? 'cutting', error: null };
    default:
      return { state: 'queued', error: null };
  }
}

export async function cutStatuses(cutIds: string[], { cuts }: Pick<ApiDeps, 'cuts'>) {
  return Promise.all(cutIds.map(async (cutId) => ({ cutId, ...deriveCutStatus(await cuts.job(cutId)) })));
}

export async function recordingPeaks(ref: string, { recordings }: Pick<ApiDeps, 'recordings'>): Promise<number[]> {
  const peaks = await recordings.peaks(ref);
  if (!peaks) throw new UseCaseError('NOT_FOUND', 'No waveform for this recording yet');
  return peaks;
}

/**
 * A path the browser can hand to <video>. Only for a recording the PC itself listed, so a
 * caller-supplied ref can never become an arbitrary request to the PC.
 */
export async function signPreviewPath(
  ref: string,
  { recordings, config }: Pick<ApiDeps, 'recordings' | 'config'>,
  nowMs: number = Date.now()
): Promise<{ path: string }> {
  if (!config.recordingsSecret) throw new UseCaseError('PRECONDITION_FAILED', 'Recordings are not configured');
  const list = await recordings.list();
  if (!list) throw new UseCaseError('PRECONDITION_FAILED', 'The OBS PC is not reachable');
  if (!list.some((r) => r.ref === ref)) throw new UseCaseError('NOT_FOUND', 'Recording not found');
  const token = await signPreview(ref, config.recordingsSecret, nowMs);
  return { path: `/api/recordings/preview/${encodeURIComponent(ref)}?t=${token}` };
}

export type OpenCutSessionInput = {
  cutId: string; showId: string; filename: string; size: number; ref: string; startS: number; endS: number;
};

/**
 * The worker's step 2: an upload session for a cut that now exists on the PC, with a
 * presigned URL for every part. Idempotent per cut: a retried job gets the same session
 * back (parts that already landed stay landed), and a cut already completed says so.
 */
export async function openCutSession(input: OpenCutSessionInput, deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>) {
  if (!(await deps.agenda.getShow(input.showId))) throw new UseCaseError('NOT_FOUND', `Show ${input.showId} was not found`);

  const existing = await deps.sessions.findByCutId(input.cutId);
  if (existing?.status === 'completed') {
    return { sessionId: existing.id, key: existing.s3_key, partSize: existing.part_size, parts: [], completed: true };
  }

  const open = existing
    ? { sessionId: existing.id, key: existing.s3_key, partSize: existing.part_size, size: Number(existing.size_bytes), s3UploadId: existing.s3_upload_id }
    : await openUploadSession(
        {
          filename: input.filename, contentType: 'video/mp4', size: input.size, showId: input.showId,
          cut: { cutId: input.cutId, ref: input.ref, startS: input.startS, endS: input.endS },
        },
        deps
      ).then(async (o) => ({ ...o, size: input.size, s3UploadId: (await deps.sessions.get(o.sessionId))!.s3_upload_id }));

  const partCount = Math.max(1, Math.ceil(open.size / open.partSize));
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, i) => ({ n: i + 1, url: await deps.objects.presignPart(open.key, open.s3UploadId, i + 1) }))
  );
  return { sessionId: open.sessionId, key: open.key, partSize: open.partSize, parts, completed: false };
}
