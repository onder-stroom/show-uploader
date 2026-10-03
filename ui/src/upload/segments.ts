import { MIN_SEGMENT_SECONDS, suggestSegments, type AgendaSlot, type Segment } from '@domain/recording-segments';
import type { DraftSegment } from '@domain/recordings-contract';

/** The editor's working copy of a segment. The server re-validates everything with the domain rules. */
export type Draft = Segment & {
  id: string;
  showId: string | null;
  /** Locked by the operator: it cannot be dragged, edited, re-assigned or removed until unfrozen. */
  frozen?: boolean;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function formatTimecode(s: number): string {
  const total = Math.max(0, round1(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total - h * 3600 - m * 60;
  const secText = sec.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secText}` : `${m}:${secText}`;
}

/** h:mm:ss, m:ss, or plain seconds, each with optional decimals. Null when unreadable. */
export function parseTimecode(text: string): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  // Minutes may exceed 59 only when there is no hours part ("62:03" is an hour and two minutes).
  if ((m[1] !== undefined && min >= 60) || sec >= 60) return null;
  return h * 3600 + min * 60 + sec;
}

/**
 * The agenda stores UTC: a date (of the start) and HH:MM times. A show that ends "before"
 * it starts crosses midnight. Only ever a suggestion: real nights run over and under.
 */
export function agendaSlot(show: { id: string; date: string; startTime: string; endTime: string }): AgendaSlot | null {
  // Date.parse is lenient with garbage like "T:00Z" (V8 reads it as year 2000), so check the shape first.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(show.date) || !/^\d{2}:\d{2}$/.test(show.startTime) || !/^\d{2}:\d{2}$/.test(show.endTime)) return null;
  const startMs = Date.parse(`${show.date}T${show.startTime}:00Z`);
  let endMs = Date.parse(`${show.date}T${show.endTime}:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs += 24 * 3600_000;
  return { showId: show.id, startMs, endMs };
}

const NEW_SEGMENT_SECONDS = 30 * 60;
const EDGE_EPS = 1e-6;

/**
 * A new segment from the playhead: 30 minutes, cut short by the next segment or the end of
 * the recording. Null when it would start inside another segment or leave under the minimum.
 */
export function newSegmentAt(playhead: number, durationS: number, others: Segment[]): Segment | null {
  const startS = round1(Math.max(0, playhead));
  // A tolerance, not strict comparison: a segment end carries float noise (3820.7000000000003 after a
  // drag), and a playhead sitting exactly on it must count as outside.
  if (others.some((o) => o.startS <= startS + EDGE_EPS && startS < o.endS - EDGE_EPS)) return null;
  const limit = Math.min(durationS, ...others.filter((o) => o.startS >= startS).map((o) => o.startS));
  const endS = round1(Math.min(startS + NEW_SEGMENT_SECONDS, limit));
  return endS - startS >= MIN_SEGMENT_SECONDS ? { startS, endS } : null;
}

/**
 * Where a new segment can start when the operator asks for one at `from`: there if it is free,
 * else at the end of whichever segment holds it (and on, if that end is inside another). Adding
 * from inside a segment is the common case, so it must not be a dead end.
 */
export function firstFreeStart(from: number, others: Segment[]): number {
  let t = Math.max(0, from);
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => o.startS <= t + EDGE_EPS && t < o.endS - EDGE_EPS);
    if (!hit) return t;
    t = hit.endS;
  }
  return t;
}

/**
 * Where "add segment" starts: right where the previous segment ends, so consecutive artists line up
 * with no gap and no playhead juggling. The previous segment is the one that ends last among those
 * that start at or before the playhead; with none, the playhead itself.
 */
export function startAfterPrevious(playhead: number, segments: Segment[]): number {
  const before = segments.filter((s) => s.startS <= playhead + EDGE_EPS);
  const anchor = before.length ? Math.max(...before.map((s) => s.endS)) : Math.max(0, playhead);
  return firstFreeStart(anchor, segments);
}

/** The selection after removing a segment: kept if another row went, else the neighbour (next, then previous), else none. */
export function selectAfterRemove(segments: Draft[], removedId: string, selectedId: string | null): string | null {
  if (removedId !== selectedId) return selectedId;
  const i = segments.findIndex((x) => x.id === removedId);
  const rest = segments.filter((x) => x.id !== removedId);
  return rest[Math.min(i, rest.length - 1)]?.id ?? null;
}

/**
 * Why the opened recording may not be current: the PC is off the tailnet for one 15 s poll,
 * or the list briefly lacks it. The editor stays up either way (it holds the operator's work).
 */
export function editorNote(list: { reachable: boolean; recordings?: { ref: string }[] } | undefined, ref: string): string | null {
  if (!list) return null;
  if (!list.reachable) return 'the OBS PC is not reachable right now. your segments are kept.';
  if (!list.recordings?.some((r) => r.ref === ref)) return 'this recording is no longer listed on the OBS PC. your segments are kept.';
  return null;
}

/**
 * The shows the agenda has during a recording, in the order they start: what a night most likely
 * contains. A hint only, like every agenda time, so it never throws: anything it cannot read (a
 * missing list, an entry without an id or times) is skipped, and the answer is then just shorter.
 */
export function showsDuringRecording<T extends { id: string; date: string; startTime: string; endTime: string }>(
  recordedAtMs: number,
  durationS: number,
  shows: readonly T[] | null | undefined
): T[] {
  try {
    if (!Array.isArray(shows) || !(durationS > 0) || !Number.isFinite(recordedAtMs)) return [];
    const usable = shows.filter((s) => s && typeof s.id === 'string');
    const byId = new Map(usable.map((s) => [s.id, s]));
    const slots = usable.map(agendaSlot).filter((s): s is AgendaSlot => s !== null);
    return suggestSegments(recordedAtMs, durationS, slots).flatMap((s) => byId.get(s.showId) ?? []);
  } catch {
    return [];
  }
}

/** The editor's segments as they are saved: no ids, which only exist to key rows. */
export function toDraftSegments(segments: Draft[]): DraftSegment[] {
  return segments.map((s) => ({ startS: s.startS, endS: s.endS, showId: s.showId, ...(s.frozen ? { frozen: true } : {}) }));
}

/** What identifies a set of segments, so "unsaved changes" is a comparison and not bookkeeping. */
export const draftKey = (segments: Draft[]): string => JSON.stringify(toDraftSegments(segments));

/**
 * Saved segments back into editor rows. A show that is no longer in the to-process list (it was
 * published meanwhile) is cleared, so a row never claims a show the picker cannot offer; pass null
 * when the list is not known and every show is kept.
 */
export function fromDraftSegments(saved: DraftSegment[], newId: () => string, knownShowIds: ReadonlySet<string> | null): Draft[] {
  return saved
    .map((s) => ({
      id: newId(),
      startS: s.startS,
      endS: s.endS,
      showId: s.showId && (!knownShowIds || knownShowIds.has(s.showId)) ? s.showId : null,
      ...(s.frozen ? { frozen: true } : {}),
    }))
    .sort((a, b) => a.startS - b.startS);
}
