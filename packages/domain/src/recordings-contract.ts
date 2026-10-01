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
};

export type CutState = 'cutting' | 'cut' | 'uploading' | 'done' | 'failed' | 'source_gone';

export type AgentCut = {
  cutId: string;
  state: CutState;
  /** Known once the cut file exists. */
  sizeBytes: number | null;
  /** Present when state is 'done'. */
  etags: { n: number; etag: string }[] | null;
  reason: string | null;
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
