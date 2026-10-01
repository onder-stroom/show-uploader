import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import GlobalStyles from '@mui/material/GlobalStyles';
import { c, withAlpha } from '../theme';
import { moveEnd, moveStart } from '../upload/clipRange';
import { formatTimecode } from '../upload/segments';
import { WaveformPath, type WaveformData } from './WaveformPath';

// Ported from the Coming Soon Clipper (components/TrimBar.tsx). The interaction model and the
// drag math are the clipper's; only the styling is translated (Tailwind -> sx + theme tokens).
// Additions: `others` (faint blocks for the other segments), a nullable selection, `disabled`.

export const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32];

interface TrimBarProps {
  duration: number;
  /** The selection; null for both shows the bare track. */
  start: number | null;
  end: number | null;
  currentTime: number;
  /** How many multiples of the container width the track renders at — owned by the page so the zoom control can live next to it. */
  zoom: number;
  onChange: (start: number, end: number) => void;
  /**
   * Fired when the playhead is moved (dragged, or a click on the track) so the
   * video can seek there live. Dragging the in/out handles or the selection
   * deliberately leaves the playhead where it is.
   */
  onScrub: (seconds: number) => void;
  /** Audio peaks drawn behind the track; null while unavailable. */
  waveform: WaveformData | null;
  /** The other segments, drawn faint and non-interactive. */
  others?: { start: number; end: number }[];
  /** The selection cannot be edited (its cut is running); the playhead still scrubs. */
  disabled?: boolean;
}

const TICKS_AT_1X = 8;
const MAX_TICKS = 64;
// Below this, a press-and-release on the selection reads as "move the
// playhead here" (like clicking anywhere else on the track); past it, it
// reads as dragging the whole selection.
const DRAG_THRESHOLD_PX = 4;

const THUMB = {
  pointerEvents: 'auto',
  WebkitAppearance: 'none',
  appearance: 'none',
  width: '8px',
  height: '100%',
  boxSizing: 'border-box',
  border: `1px solid ${c.paper}`,
  borderRadius: '2px',
  background: c.link,
  cursor: 'ew-resize',
} as const;
const TRACK = { background: 'transparent', border: 'none', height: '100%' } as const;
const FOCUS = { outline: `2px solid ${c.link}`, outlineOffset: '2px' } as const;

// The native range inputs are stacked over the whole track. Without pointer-events: none on the
// input (auto on the thumb) the later input would win every hit test, the start handle could
// never be grabbed, and clicks on the open track would never reach the seek layer beneath.
const trimRangeStyles = {
  '.trim-range': { pointerEvents: 'none', background: 'transparent', margin: 0 },
  '.trim-range::-webkit-slider-runnable-track': TRACK,
  '.trim-range::-webkit-slider-thumb': THUMB,
  '.trim-range::-moz-range-track': TRACK,
  '.trim-range::-moz-range-thumb': THUMB,
  '.trim-range:focus-visible::-webkit-slider-thumb': FOCUS,
  '.trim-range:focus-visible::-moz-range-thumb': FOCUS,
  '.trim-range:disabled::-webkit-slider-thumb': { background: c.faint, cursor: 'not-allowed' },
  '.trim-range:disabled::-moz-range-thumb': { background: c.faint, cursor: 'not-allowed' },
};

const noScrollbar = { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } } as const;
const noDrag = { touchAction: 'none', userSelect: 'none' } as const;

export function TrimBar({ duration, start, end, currentTime, zoom, onChange, onScrub, waveform, others = [], disabled = false }: TrimBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const blockDragRef = useRef<{ pointerX: number; start: number; end: number; moved: boolean } | null>(null);
  // Captured once when a handle drag begins, so the "preserve the length it
  // already had" behavior on crossing uses the length from BEFORE this drag
  // gesture started — not whatever tiny gap is left on the tick where the
  // crossing actually happens. A native range input fires onChange on every
  // intermediate tick of a drag, and each tick approaching the other handle
  // legitimately shrinks the gap (that's normal trimming); recomputing the
  // "length to preserve" from that shrinking gap meant a real mouse drag
  // crossing the other handle only ever preserved a sliver, not the clip's
  // actual length.
  const startGestureRef = useRef<{ start: number; end: number } | null>(null);
  const endGestureRef = useRef<{ start: number; end: number } | null>(null);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
  // Which slice of the full timeline is currently scrolled into view, as
  // fractions of duration — drawn as a small indicator bar so it's obvious
  // at a glance that you're zoomed in, and to what part.
  const [viewport, setViewport] = useState({ start: 0, end: 1 });

  const updateViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth === 0) return;
    setViewport({
      start: el.scrollLeft / el.scrollWidth,
      end: (el.scrollLeft + el.clientWidth) / el.scrollWidth,
    });
  }, []);

  // Re-center on wherever the playhead is, but only when the zoom level
  // itself changes — never reactively on start/end/currentTime, or the view
  // would shift underneath whatever the operator is doing.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || duration <= 0) return;
    const ratio = currentTimeRef.current / duration;
    container.scrollLeft = Math.max(0, ratio * container.scrollWidth - container.clientWidth / 2);
    updateViewport();
  }, [zoom, duration, updateViewport]);

  if (duration <= 0) return null;

  const selection = start !== null && end !== null ? { start, end } : null;
  const editable = selection !== null && !disabled;

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    onScrub(ratio * duration);
  }

  function moveSelectionBlock(event: React.PointerEvent<HTMLDivElement>) {
    const drag = blockDragRef.current;
    const rect = barRef.current?.getBoundingClientRect();
    if (!drag || !rect || rect.width === 0) return;
    const deltaSeconds = ((event.clientX - drag.pointerX) / rect.width) * duration;
    const length = drag.end - drag.start;
    const newStart = Math.max(0, Math.min(drag.start + deltaSeconds, duration - length));
    const newEnd = newStart + length;
    onChange(newStart, newEnd);
  }

  const tickCount = Math.min(MAX_TICKS, TICKS_AT_1X * zoom);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (i / tickCount) * duration);
  const playheadPct = (Math.min(duration, Math.max(0, currentTime)) / duration) * 100;

  const scrubHandlers = {
    draggable: false,
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromPointer(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      seekFromPointer(e);
    },
  };

  const rangeSx = { position: 'absolute', inset: 0, width: '100%', height: '100%', appearance: 'none', background: 'transparent' } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
      <GlobalStyles styles={trimRangeStyles} />
      <Box ref={scrollRef} onScroll={updateViewport} sx={{ ...noScrollbar, overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}>
        <Box ref={barRef} sx={{ position: 'relative', width: `${zoom * 100}%`, minWidth: '100%' }}>
          {/*
            The playhead's own grab handle lives in a strip above the track,
            never overlapped by the selection or the trim handles below it —
            grabbing the selection to move it previously made the playhead
            underneath it ungrabbable. Always on top (z 20), always reachable.
          */}
          <Box sx={{ position: 'relative', height: 28, cursor: 'ew-resize', ...noDrag }} {...scrubHandlers}>
            <Box
              sx={{
                pointerEvents: 'none', position: 'absolute', top: 0, zIndex: 20, left: `${playheadPct}%`,
                transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25,
              }}
            >
              <Box
                component="span"
                sx={{ borderRadius: '3px', backgroundColor: c.accentSoft, px: 0.5, fontFamily: 'monospace', fontSize: 10, whiteSpace: 'nowrap', color: c.muted }}
              >
                {formatTimecode(currentTime)}
              </Box>
              <Box sx={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: `8px solid ${c.ink}` }} />
            </Box>
          </Box>

          <Box sx={{ position: 'relative', height: 48 }}>
            {/* Background: click or drag anywhere on the track to move the playhead — independent of the in/out handles. */}
            <Box
              sx={{ position: 'absolute', inset: 0, cursor: 'pointer', border: `1px solid ${c.border}`, backgroundColor: c.accentSoft, ...noDrag }}
              {...scrubHandlers}
            />
            {waveform && <WaveformPath data={waveform} duration={duration} />}

            {others.map((o, i) => (
              <Box
                key={i}
                sx={{
                  pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0,
                  left: `${(o.start / duration) * 100}%`, width: `${((o.end - o.start) / duration) * 100}%`,
                  backgroundColor: withAlpha(c.ink, 0.12), borderLeft: `1px solid ${withAlpha(c.ink, 0.35)}`, borderRight: `1px solid ${withAlpha(c.ink, 0.35)}`,
                }}
              />
            ))}

            {/*
              The selection is grabbable — dragging it moves both in/out points
              together, preserving the clip's length. But a plain click here
              (no real movement) reads as "move the playhead to this point",
              same as clicking anywhere else on the track; otherwise there'd be
              no way to place the playhead anywhere inside your own selection.
            */}
            {selection && (
              <Box
                sx={{
                  position: 'absolute', top: 0, bottom: 0,
                  cursor: editable ? 'grab' : 'pointer', '&:active': { cursor: editable ? 'grabbing' : 'pointer' },
                  borderLeft: `1px solid ${c.link}`, borderRight: `1px solid ${c.link}`, backgroundColor: withAlpha(c.link, 0.25),
                  left: `${(selection.start / duration) * 100}%`, width: `${((selection.end - selection.start) / duration) * 100}%`,
                  ...noDrag,
                }}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  blockDragRef.current = { pointerX: e.clientX, start: selection.start, end: selection.end, moved: false };
                }}
                onPointerMove={(e) => {
                  if (e.buttons !== 1 || !blockDragRef.current) return;
                  if (!blockDragRef.current.moved && Math.abs(e.clientX - blockDragRef.current.pointerX) < DRAG_THRESHOLD_PX) {
                    return;
                  }
                  blockDragRef.current.moved = true;
                  // Deviation: a locked selection never moves; the press-and-release still seeks.
                  if (editable) moveSelectionBlock(e);
                }}
                onPointerUp={(e) => {
                  if (blockDragRef.current && !blockDragRef.current.moved) {
                    seekFromPointer(e);
                  }
                  blockDragRef.current = null;
                }}
              />
            )}

            {selection && (
              <>
                <Box
                  component="input"
                  type="range"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={selection.start}
                  disabled={!editable}
                  onPointerDown={() => {
                    startGestureRef.current = { start: selection.start, end: selection.end };
                  }}
                  onPointerUp={() => {
                    startGestureRef.current = null;
                  }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const reference = startGestureRef.current ?? selection;
                    const result = moveStart(reference, duration, Number(e.target.value));
                    onChange(result.start, result.end);
                  }}
                  className="trim-range"
                  sx={rangeSx}
                  aria-label="Segment start"
                />
                <Box
                  component="input"
                  type="range"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={selection.end}
                  disabled={!editable}
                  onPointerDown={() => {
                    endGestureRef.current = { start: selection.start, end: selection.end };
                  }}
                  onPointerUp={() => {
                    endGestureRef.current = null;
                  }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const reference = endGestureRef.current ?? selection;
                    const result = moveEnd(reference, duration, Number(e.target.value));
                    onChange(result.start, result.end);
                  }}
                  className="trim-range"
                  sx={rangeSx}
                  aria-label="Segment end"
                />
              </>
            )}

            {/* Playhead line through the track — its grab handle is the flag above the track; this is purely visual and live during playback. */}
            <Box
              sx={{
                pointerEvents: 'none', position: 'absolute', top: 0, bottom: 0, zIndex: 10, width: '2px',
                transform: 'translateX(-50%)', backgroundColor: c.ink, left: `${playheadPct}%`,
              }}
            />
          </Box>

          <Box sx={{ position: 'relative', mt: 0.5, height: 16 }}>
            {ticks.map((t, i) => {
              // The first/last labels center on 0%/100% like the rest would
              // push their text straight past the bar's own edge — that
              // overflow was what kept the container scrollable even at 1x,
              // when the whole timeline already fit. Anchor them inward instead.
              const shift = i === 0 ? '0' : i === tickCount ? '-100%' : '-50%';
              return (
                <Box
                  key={i}
                  component="span"
                  sx={{ position: 'absolute', transform: `translateX(${shift})`, fontFamily: 'monospace', fontSize: 11, color: c.faint, left: `${(t / duration) * 100}%` }}
                >
                  {formatTimecode(t)}
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Viewport indicator: which slice of the full timeline is in view. Full-width at 1x (nothing to indicate); shrinks and moves as you zoom/scroll. */}
      <Box sx={{ position: 'relative', height: 4, borderRadius: 999, backgroundColor: c.accentSoft }}>
        <Box
          sx={{
            position: 'absolute', top: 0, bottom: 0, borderRadius: 999, backgroundColor: c.muted,
            left: `${viewport.start * 100}%`, width: `${(viewport.end - viewport.start) * 100}%`,
          }}
        />
      </Box>
    </Box>
  );
}
