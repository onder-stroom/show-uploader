// Ported verbatim from the Coming Soon Clipper (lib/clipRange.ts): moveStart, moveEnd, ClipSelection.

export interface ClipSelection {
  start: number;
  end: number;
}

/**
 * Moving the in-point past the current out-point used to just clamp it
 * (collapsing the clip to a sliver at the old out-point). Instead, slide the
 * whole selection forward so it keeps the length it already had — used by
 * both the drag handle and the ±start nudge buttons, so they behave
 * consistently.
 */
export function moveStart(current: ClipSelection, videoDuration: number, newStart: number): ClipSelection {
  if (newStart >= current.end) {
    const length = current.end - current.start;
    const start = Math.min(newStart, videoDuration - length);
    return { start, end: start + length };
  }
  return { start: newStart, end: current.end };
}

/** Same idea in reverse: moving the out-point before the in-point slides the selection backward instead of collapsing it. */
export function moveEnd(current: ClipSelection, videoDuration: number, newEnd: number): ClipSelection {
  if (newEnd <= current.start) {
    const length = current.end - current.start;
    const end = Math.max(newEnd, length);
    return { start: end - length, end };
  }
  return { start: current.start, end: newEnd };
}
