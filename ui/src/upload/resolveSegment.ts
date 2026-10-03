import type { StagedVideo } from './resolveVideo';

/** What the api reports for a cut (the queue's view). */
export type CutStatusView = {
  state: 'queued' | 'cutting' | 'uploading' | 'finishing' | 'done' | 'failed' | 'unknown';
  error: string | null;
  /** The staged video's filename the cut was made with: what to look for on the show. */
  filename?: string;
};

export type SegmentStatus =
  | { state: 'draft' }
  | { state: 'queued' | 'cutting' | 'finishing' }
  | { state: 'uploading'; fraction: number | null }
  | { state: 'ready'; filename: string }
  /** The cut finished but the show has no video from it: none staged, or a different one (`other`). */
  | { state: 'unstaged'; other: string | null }
  | { state: 'failed'; message: string };

/**
 * The single, pure rule for "where is this segment?". Like resolveVideo it derives from
 * server truth and stores nothing. What survives a refresh is the staged video, once the cut
 * has put one on the show. The in-flight cut status does not: the editor keeps the cut ids in
 * component state (`cutByShow`), so a refresh forgets them until the show shows a staged video.
 *
 * `staged` must already be the video that belongs to THIS segment (its filename matches
 * the cut's), otherwise an unrelated earlier upload would make a draft look ready.
 */
export function resolveSegment(input: {
  cut?: CutStatusView | null;
  staged?: StagedVideo | null;
  uploadFraction?: number | null;
  /** The filename of whatever IS staged on the show, when it is not this segment's. */
  otherStaged?: string | null;
}): SegmentStatus {
  const { cut, staged, uploadFraction, otherStaged } = input;
  const state = cut?.state ?? 'unknown';

  if (state === 'failed') return { state: 'failed', message: cut?.error ?? 'The cut failed' };
  if (state === 'queued' || state === 'cutting' || state === 'finishing') return { state };
  if (state === 'uploading') return { state: 'uploading', fraction: uploadFraction ?? null };

  // done / unknown: the staged video is the durable truth (the job may have aged out).
  if (staged) return { state: 'ready', filename: staged.filename };
  return state === 'done' ? { state: 'unstaged', other: otherStaged ?? null } : { state: 'draft' };
}
