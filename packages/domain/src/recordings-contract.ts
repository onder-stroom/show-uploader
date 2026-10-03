/**
 * The protocol between the uploader (api + worker) and the recordings service on
 * the OBS PC. One copy, imported by all three, so they cannot drift. Types and
 * tiny pure helpers only — no I/O.
 */

export const AGENT_API_PREFIX = '/v1';

export type RecordingState = 'preparing' | 'ready' | 'failed';

export type AgentRecording = {
  /** Opaque and stable once the file is ready. */
  ref: string;
  filename: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Null until ffprobe has run. */
  durationS: number | null;
  state: RecordingState;
  hasPreview: boolean;
  /** When OBS started writing the file, from its filename or birth time. */
  recordedAtMs: number;
  /** Segments were saved for this recording. Absent from a PC service that predates saving. */
  hasDraft?: boolean;
};

/** A segment as the operator left it in the editor; the working copy kept next to the recording. */
export type DraftSegment = { startS: number; endS: number; showId: string | null; frozen?: boolean };
export type RecordingDraft = { segments: DraftSegment[]; savedAtMs: number };

export const MAX_DRAFT_SEGMENTS = 100;
const MAX_DRAFT_SECONDS = 7 * 24 * 3600;

/**
 * The saved segments in an untrusted body, cleaned, or null when anything is wrong. Both the PC
 * service and the api apply it, so what one accepts the other never refuses. Work in progress is
 * allowed: overlaps and unchosen shows are not this rule's business, only the shape is.
 */
export function parseDraftSegments(input: unknown): DraftSegment[] | null {
  if (!Array.isArray(input) || input.length > MAX_DRAFT_SEGMENTS) return null;
  const out: DraftSegment[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const { startS, endS, showId, frozen } = raw as Record<string, unknown>;
    const inRange = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_DRAFT_SECONDS;
    if (!inRange(startS) || !inRange(endS)) return null;
    if (showId !== null && (typeof showId !== 'string' || showId.length === 0 || showId.length > 64)) return null;
    if (frozen !== undefined && typeof frozen !== 'boolean') return null;
    out.push({ startS, endS, showId: showId as string | null, ...(frozen ? { frozen: true } : {}) });
  }
  return out;
}

export type CutState = 'cutting' | 'cut' | 'uploading' | 'done' | 'failed' | 'source_gone';

export type AgentCut = {
  cutId: string;
  state: CutState;
  /** Known once the cut file exists. */
  sizeBytes: number | null;
  /** Present when state is 'done'. */
  etags: { n: number; etag: string }[] | null;
  reason: string | null;
  /** True while the PC deliberately waits for OBS to stop recording: the wait must not count it. */
  paused?: boolean;
};

export type CutRequest = { cutId: string; ref: string; startS: number; endS: number };

/** The queue the api produces to and the worker consumes. One name, shared, so they cannot drift. */
export const RECORDING_CUTS_QUEUE = 'recording-cuts';

export type CutStep = 'cutting' | 'uploading' | 'finishing';

/** One segment to cut and upload as `showId`'s staged recording. */
export type CutJobPayload = {
  /** Deterministic from (ref, showId, startS, endS); doubles as the BullMQ job id. */
  cutId: string;
  ref: string;
  /** The staged video's filename, already built with `cutFilename`. */
  filename: string;
  showId: string;
  startS: number;
  endS: number;
};

export type UploadRequest = { partSize: number; parts: { n: number; url: string }[] };

/** What the api reports when the PC cannot be reached. A normal state, not an error. */
export type UnreachableAgent = { reachable: false };

export function isTerminalCutState(s: CutState): boolean {
  return s === 'done' || s === 'failed' || s === 'source_gone';
}

const hms = (s: number) => {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
};

/** `<recording>__<in>-<out>.mp4`: the recording's identity plus the cut, filesystem-safe. */
export function cutFilename(recordingFilename: string, startS: number, endS: number): string {
  const dot = recordingFilename.lastIndexOf('.');
  const base = dot > 0 ? recordingFilename.slice(0, dot) : recordingFilename;
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safe}__${hms(startS)}-${hms(endS)}.mp4`;
}
