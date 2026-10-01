// ui/src/components/SegmentTimeline.tsx
import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { MIN_SEGMENT_SECONDS } from '@domain/recording-segments';
import { c, withAlpha } from '../theme';
import type { Draft } from '../upload/segments';

type Props = {
  /** The preview <video>; the waveform follows its playback and seeks it on click. */
  media: HTMLVideoElement | null;
  peaks: number[] | undefined;
  durationS: number;
  segments: Draft[];
  onChange(next: Draft[]): void;
};

const REGION_COLOR = withAlpha(c.link, 0.25);

/**
 * The whole recording as a waveform with draggable, resizable segments. wavesurfer owns the
 * pointer handling; this keeps its regions and the page's `segments` state in step. The
 * state is the source of truth, and the domain rules (neighbours, minimum length) are
 * enforced by validateSegments, which the page shows next to each row.
 */
export default function SegmentTimeline({ media, peaks, durationS, segments, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const regions = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  // Event handlers outlive renders; they must always see the current state.
  const latest = useRef({ segments, onChange });
  latest.current = { segments, onChange };

  useEffect(() => {
    if (!host.current || !media || !peaks) return;
    const plugin = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: host.current, media, peaks: [peaks], duration: durationS, height: 96,
      waveColor: c.muted, progressColor: c.ink, cursorColor: c.danger, plugins: [plugin],
    });
    regions.current = plugin;
    plugin.enableDragSelection({ color: REGION_COLOR });
    // A region the operator drags out on the waveform becomes a new draft segment.
    plugin.on('region-created', (r) => {
      const { segments: all, onChange: change } = latest.current;
      if (all.some((s) => s.id === r.id)) return; // one we created ourselves
      change([...all, { id: r.id, startS: r.start, endS: r.end, showId: null }]);
    });
    plugin.on('region-updated', (r) => {
      const { segments: all, onChange: change } = latest.current;
      change(all.map((s) => (s.id === r.id ? { ...s, startS: r.start, endS: r.end } : s)));
    });
    return () => {
      ws.destroy();
      regions.current = null;
    };
  }, [media, peaks, durationS]);

  // Mirror the state into the waveform: add missing, move changed, drop removed.
  useEffect(() => {
    const plugin = regions.current;
    if (!plugin) return;
    const existing = new Map(plugin.getRegions().map((r) => [r.id, r]));
    segments.forEach((s, i) => {
      const r = existing.get(s.id);
      if (!r) {
        plugin.addRegion({
          id: s.id, start: s.startS, end: s.endS, drag: true, resize: true,
          minLength: MIN_SEGMENT_SECONDS, color: REGION_COLOR, content: String(i + 1),
        });
      } else if (Math.abs(r.start - s.startS) > 0.05 || Math.abs(r.end - s.endS) > 0.05) {
        r.setOptions({ start: s.startS, end: s.endS });
      }
      existing.delete(s.id);
    });
    existing.forEach((r) => r.remove());
  }, [segments, media, peaks, durationS]);

  return <Box ref={host} sx={{ backgroundColor: c.accentSoft, border: `1px solid ${c.border}` }} />;
}
