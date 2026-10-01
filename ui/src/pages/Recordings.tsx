// ui/src/pages/Recordings.tsx
import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { suggestSegments, validateSegments } from '@domain/recording-segments';
import { cutFilename, type AgentRecording } from '@domain/recordings-contract';
import {
  useCutStatuses, usePreviewPath, useRecordingPeaks, useRecordings, useShows, useStaged, useStartCuts, useUploadingProgress,
} from '../api/hooks';
import { humanDuration } from '../format';
import { c } from '../theme';
import { PageLoading } from '../components/Skeleton';
import SegmentTimeline from '../components/SegmentTimeline';
import { resolveSegment, type CutStatusView, type SegmentStatus } from '../upload/resolveSegment';
import { agendaSlot, formatTimecode, parseTimecode, type Draft } from '../upload/segments';

// The PC's clock is Brussels, and so is everyone reading this page.
const brussels = new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', dateStyle: 'medium', timeStyle: 'short' });

export default function Recordings() {
  const q = useRecordings();
  const [ref, setRef] = useState<string | null>(null);

  if (q.isPending) return <PageLoading label="asking the OBS PC…" />;
  if (q.isError) {
    return (
      <Typography variant="body2" sx={{ color: c.danger }}>
        could not read recordings: {q.error.message}
      </Typography>
    );
  }

  const header = (
    <Box>
      <Typography variant="h1">recordings</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        cut a night into one upload per artist. cuts are lossless and only the cut parts leave the PC.
      </Typography>
    </Box>
  );

  // Off, or off the tailnet. Normal, not an error: nothing already uploaded is affected.
  if (!q.data.reachable) {
    return (
      <Stack spacing={3}>
        {header}
        <Typography variant="body2" color="text.secondary">
          the OBS PC is not reachable right now. recordings already uploaded are not affected.
        </Typography>
      </Stack>
    );
  }

  const selected = q.data.recordings.find((r) => r.ref === ref) ?? null;
  return (
    <Stack spacing={4}>
      {header}
      {selected ? (
        <Editor key={selected.ref} recording={selected} onClose={() => setRef(null)} />
      ) : (
        <Stack spacing={1.5}>
          {q.data.recordings.length === 0 && (
            <Typography variant="body2" color="text.secondary">no recordings on the OBS PC.</Typography>
          )}
          {q.data.recordings.map((r) => (
            <Stack
              key={r.ref} direction="row" spacing={2}
              sx={{ alignItems: 'center', p: 1.5, backgroundColor: c.surface, border: `1px solid ${c.border}` }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }} noWrap>{r.filename}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {brussels.format(r.recordedAtMs)} · {r.durationS ? humanDuration(r.durationS) : 'reading…'}
                  {r.state === 'preparing' && ' · preparing the editor view…'}
                  {r.state === 'failed' && ' · could not be prepared'}
                </Typography>
              </Box>
              <Button size="small" variant="outlined" disabled={r.state !== 'ready'} onClick={() => setRef(r.ref)}>
                open
              </Button>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Editor({ recording, onClose }: { recording: AgentRecording; onClose: () => void }) {
  const durationS = recording.durationS ?? 0;
  const preview = usePreviewPath(recording.hasPreview ? recording.ref : null);
  const peaks = useRecordingPeaks(recording.ref);
  const shows = useShows();
  const uploading = useUploadingProgress();
  const startCuts = useStartCuts();

  const [segments, setSegments] = useState<Draft[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [cutByShow, setCutByShow] = useState<Record<string, string>>({});
  const statuses = useCutStatuses(Object.values(cutByShow));
  // The <video> as state, so the waveform can attach once the element exists.
  const [media, setMedia] = useState<HTMLVideoElement | null>(null);
  const nextId = useRef(1);
  const newId = () => String(nextId.current++);

  // The server computes the real % from S3 (ListParts), so every machine shows the same number.
  const fractionFor = (showId: string | null): number | null => {
    const pct = uploading.data?.find((u) => u.show_id === showId)?.pct;
    return typeof pct === 'number' ? pct / 100 : null;
  };

  const problems = validateSegments(segments, durationS);
  const canCut = segments.length > 0 && segments.every((s) => s.showId) && problems.length === 0 && !startCuts.isPending;

  const patch = (id: string, change: Partial<Draft>) => setSegments((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

  // Agenda times are DRAFT markers: they fill in a first guess the operator then corrects.
  const suggest = () => {
    const slots = (shows.data ?? []).map(agendaSlot).filter((s): s is NonNullable<typeof s> => s !== null);
    setSegments(suggestSegments(recording.recordedAtMs, durationS, slots).map((s) => ({ ...s, id: newId() })));
  };

  const submit = () =>
    startCuts.mutate(
      { ref: recording.ref, segments: segments.map(({ startS, endS, showId }) => ({ startS, endS, showId: showId! })) },
      { onSuccess: (r) => setCutByShow(Object.fromEntries(r.cuts.map((x) => [x.showId, x.cutId]))) }
    );

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline' }}>
        <Button size="small" onClick={onClose}>← recordings</Button>
        <Typography sx={{ fontWeight: 600 }} noWrap>{recording.filename}</Typography>
        <Typography variant="caption" color="text.secondary">{humanDuration(durationS)}</Typography>
      </Stack>

      {preview.data ? (
        <Box
          component="video" ref={setMedia} src={preview.data.path} controls preload="metadata" playsInline
          onTimeUpdate={(e: React.SyntheticEvent<HTMLVideoElement>) => setPlayhead(e.currentTarget.currentTime)}
          sx={{ width: '100%', maxHeight: '45vh', backgroundColor: '#000', display: 'block' }}
        />
      ) : (
        <Typography variant="caption" color="text.disabled">
          {preview.isError ? `could not open the preview: ${preview.error.message}` : 'loading the preview…'}
        </Typography>
      )}

      <SegmentTimeline media={media} peaks={peaks.data} durationS={durationS} segments={segments} onChange={setSegments} />
      <Typography variant="caption" color="text.disabled">
        drag on the waveform to add a segment · drag a segment or its edges to adjust · click to seek. agenda times are only a first guess.
      </Typography>

      <Stack direction="row" spacing={1}>
        <Button size="small" variant="outlined" onClick={suggest} disabled={!shows.data}>suggest from agenda</Button>
      </Stack>

      <Stack spacing={1}>
        {segments.map((s, i) => {
          const cutId = s.showId ? cutByShow[s.showId] : undefined;
          const expected = cutFilename(recording.filename, s.startS, s.endS);
          return (
            <SegmentRow
              key={s.id} index={i} draft={s} playhead={playhead} expectedFilename={expected}
              cut={statuses.data?.find((x) => x.cutId === cutId) as CutStatusView | undefined}
              uploadFraction={fractionFor(s.showId)}
              showOptions={(shows.data ?? []).map((x) => ({ id: x.id, title: x.title, taken: segments.some((o) => o.id !== s.id && o.showId === x.id) }))}
              problem={problems.find((p) => p.index === i)?.message}
              onChange={(change) => patch(s.id, change)}
              onRemove={() => setSegments((all) => all.filter((x) => x.id !== s.id))}
            />
          );
        })}
      </Stack>

      {startCuts.isError && <Typography variant="body2" sx={{ color: c.danger }}>{startCuts.error.message}</Typography>}
      <Box>
        <Button variant="contained" disabled={!canCut} onClick={submit}>
          cut {segments.length || ''} segment{segments.length === 1 ? '' : 's'}
        </Button>
      </Box>
    </Stack>
  );
}

function SegmentRow(props: {
  index: number; draft: Draft; playhead: number; expectedFilename: string;
  cut: CutStatusView | undefined; uploadFraction: number | null;
  showOptions: { id: string; title: string; taken: boolean }[];
  problem: string | undefined;
  onChange(change: Partial<Draft>): void; onRemove(): void;
}) {
  const { draft, cut, index } = props;
  // Only a video whose filename matches THIS cut counts as this segment's result.
  const staged = useStaged(draft.showId ?? undefined).data;
  const matching = staged && staged.filename === props.expectedFilename ? staged : null;
  const status = resolveSegment({ cut, staged: matching, uploadFraction: props.uploadFraction });
  const replaces = staged && !matching && status.state === 'draft';

  return (
    <Stack spacing={0.5} sx={{ p: 1.5, backgroundColor: c.surface, border: `1px solid ${props.problem ? c.danger : c.border}` }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography sx={{ width: 20, fontWeight: 700 }}>{index + 1}</Typography>
        <TimeField label="in" value={draft.startS} onCommit={(s) => props.onChange({ startS: s })} />
        <Button size="small" onClick={() => props.onChange({ startS: props.playhead })}>← playhead</Button>
        <TimeField label="out" value={draft.endS} onCommit={(s) => props.onChange({ endS: s })} />
        <Button size="small" onClick={() => props.onChange({ endS: props.playhead })}>← playhead</Button>
        <Select
          size="small" displayEmpty value={draft.showId ?? ''} sx={{ minWidth: 220, flex: 1 }}
          onChange={(e) => props.onChange({ showId: e.target.value || null })}
        >
          <MenuItem value=""><em>choose the show…</em></MenuItem>
          {props.showOptions.map((o) => (
            <MenuItem key={o.id} value={o.id} disabled={o.taken}>{o.title}</MenuItem>
          ))}
        </Select>
        <Typography variant="caption" sx={{ minWidth: 150, color: status.state === 'failed' ? c.danger : c.muted }}>
          {statusLabel(status)}
        </Typography>
        <Button size="small" onClick={props.onRemove} disabled={['queued', 'cutting', 'uploading', 'finishing'].includes(status.state)}>
          remove
        </Button>
      </Stack>
      {props.problem && <Typography variant="caption" sx={{ color: c.danger }}>{props.problem}</Typography>}
      {replaces && (
        <Typography variant="caption" color="text.secondary">
          this show already has a video staged. cutting replaces it.
        </Typography>
      )}
    </Stack>
  );
}

function statusLabel(s: SegmentStatus): string {
  switch (s.state) {
    case 'draft': return '';
    case 'queued': return 'queued';
    case 'cutting': return 'cutting on the PC…';
    case 'uploading': return s.fraction === null ? 'uploading…' : `uploading ${Math.round(s.fraction * 100)}%`;
    case 'finishing': return 'finishing…';
    case 'ready': return '✓ staged for publishing';
    case 'failed': return s.message;
  }
}

function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit(s: number): void }) {
  const [text, setText] = useState(formatTimecode(value));
  useEffect(() => setText(formatTimecode(value)), [value]);
  return (
    <TextField
      size="small" label={label} value={text} sx={{ width: 130 }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const s = parseTimecode(text);
        if (s === null) setText(formatTimecode(value));
        else onCommit(s);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
