import { useMemo } from 'react';
import Box from '@mui/material/Box';
import { c } from '../theme';

// Ported from the Coming Soon Clipper (components/Waveform.tsx); the clipper's fetching hook is not.
export interface WaveformData {
  peaks: Uint8Array;
  peaksPerSecond: number;
}

/** The api's peaks (0..1, one per second) in the clipper's shape. */
export function toWaveform(peaks: number[]): WaveformData {
  return { peaks: Uint8Array.from(peaks, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), peaksPerSecond: 1 };
}

/**
 * Mirrored peak envelope as one filled SVG path, stretched to the track: it
 * scales with the zoomed track width without redrawing, where a canvas would
 * hit browser size limits at high zoom on a two-hour show.
 */
export function WaveformPath({ data, duration }: { data: WaveformData; duration: number }) {
  const { peaks, peaksPerSecond } = data;

  const d = useMemo(() => {
    if (peaks.length === 0 || duration <= 0) return '';
    const x = (i: number) => ((i / peaksPerSecond / duration) * 1000).toFixed(2);
    const h = (i: number) => (peaks[i] / 255) * 48;
    let top = `M0,50`;
    let bottom = '';
    for (let i = 0; i < peaks.length; i++) {
      top += `L${x(i)},${(50 - h(i)).toFixed(1)}`;
      bottom = `L${x(i)},${(50 + h(i)).toFixed(1)}` + bottom;
    }
    return `${top}${bottom}Z`;
  }, [peaks, peaksPerSecond, duration]);

  return (
    <Box
      component="svg"
      aria-hidden
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      sx={{ pointerEvents: 'none', position: 'absolute', inset: 0, width: '100%', height: '100%', color: c.faint }}
    >
      <path d={d} fill="currentColor" opacity={0.6} />
    </Box>
  );
}
