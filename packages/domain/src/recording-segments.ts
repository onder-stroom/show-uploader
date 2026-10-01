/**
 * Rules for cutting one recording into per-artist segments. Pure: no I/O.
 *
 * Agenda times only SUGGEST. Real nights run over and under, so a suggestion is a
 * draft marker the operator drags into place, never a decision.
 */

export type Segment = { startS: number; endS: number };

export type SegmentProblem = {
  index: number;
  code: 'EMPTY' | 'TOO_SHORT' | 'OUT_OF_RANGE' | 'OVERLAP';
  message: string;
};

/** Shorter than this is a mis-click, not a set. */
export const MIN_SEGMENT_SECONDS = 30;

export function validateSegments(segments: Segment[], durationS: number): SegmentProblem[] {
  const problems: SegmentProblem[] = [];
  const clean: { index: number; seg: Segment }[] = [];

  segments.forEach((seg, index) => {
    const { startS, endS } = seg;
    if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
      problems.push({ index, code: 'EMPTY', message: 'Segment has no length' });
      return;
    }
    if (startS < 0 || endS > durationS) {
      problems.push({ index, code: 'OUT_OF_RANGE', message: 'Segment is outside the recording' });
      return;
    }
    if (endS - startS < MIN_SEGMENT_SECONDS) {
      problems.push({ index, code: 'TOO_SHORT', message: `Segment is shorter than ${MIN_SEGMENT_SECONDS}s` });
      return;
    }
    clean.push({ index, seg });
  });

  // Overlap is judged in time order but reported against the caller's own index,
  // so the UI can highlight the segment the operator actually dragged.
  const byTime = [...clean].sort((a, b) => a.seg.startS - b.seg.startS);
  for (let i = 1; i < byTime.length; i++) {
    if (byTime[i].seg.startS < byTime[i - 1].seg.endS) {
      problems.push({ index: byTime[i].index, code: 'OVERLAP', message: 'Segments overlap' });
    }
  }
  return problems.sort((a, b) => a.index - b.index);
}

export type AgendaSlot = { showId: string; startMs: number; endMs: number };
export type SegmentSuggestion = Segment & { showId: string };

export function suggestSegments(recordingStartMs: number, durationS: number, slots: AgendaSlot[]): SegmentSuggestion[] {
  const out: SegmentSuggestion[] = [];
  for (const slot of slots) {
    const startS = Math.max(0, (slot.startMs - recordingStartMs) / 1000);
    const endS = Math.min(durationS, (slot.endMs - recordingStartMs) / 1000);
    if (endS > startS) out.push({ startS, endS, showId: slot.showId });
  }
  return out.sort((a, b) => a.startS - b.startS);
}

/** The slot a segment overlaps most, or null — never a forced guess. */
export function matchShowForSegment(recordingStartMs: number, segment: Segment, slots: AgendaSlot[]): string | null {
  let best: { showId: string; overlap: number } | null = null;
  for (const slot of slots) {
    const s = (slot.startMs - recordingStartMs) / 1000;
    const e = (slot.endMs - recordingStartMs) / 1000;
    const overlap = Math.min(segment.endS, e) - Math.max(segment.startS, s);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { showId: slot.showId, overlap };
  }
  return best?.showId ?? null;
}
