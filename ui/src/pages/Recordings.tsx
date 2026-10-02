// ui/src/pages/Recordings.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { suggestSegments, validateSegments } from '@domain/recording-segments';
import { cutFilename, type AgentRecording } from '@domain/recordings-contract';
import {
  useCutStatuses, usePreviewPath, useRecordingPeaks, useRecordings, useRescanRecordings, useShows, useStaged, useStartCuts,
  useUploadingProgress,
} from '../api/hooks';
import { humanDuration } from '../format';
import { c } from '../theme';
import { PageLoading } from '../components/Skeleton';
import { TrimBar, ZOOM_LEVELS } from '../components/TrimBar';
import { toWaveform } from '../components/WaveformPath';
import { resolveSegment, type CutStatusView, type SegmentStatus } from '../upload/resolveSegment';
import { agendaSlot, editorNote, formatTimecode, newSegmentAt, parseTimecode, selectAfterRemove, type Draft } from '../upload/segments';

// The PC's clock is Brussels, and so is everyone reading this page.
// A cut in these states is being made from the times as they were: editing them now would
// leave the row showing times the cut does not have.
const ACTIVE_STATES: readonly string[] = ['queued', 'cutting', 'uploading', 'finishing'];
const isActive = (cut: CutStatusView | undefined) => !!cut && ACTIVE_STATES.includes(cut.state);

const brussels = new Intl.DateTimeFormat('nl-BE', { timeZone: 'Europe/Brussels', dateStyle: 'medium', timeStyle: 'short' });

export default function Recordings() {
  const q = useRecordings();
  const rescan = useRescanRecordings();
  // The opened recording itself, not a ref looked up in the latest list: one poll that
  // fails or lacks it must not unmount the editor and lose the operator's drafts.
  const [opened, setOpened] = useState<AgentRecording | null>(null);

  if (!opened && q.isPending) return <PageLoading label="asking the OBS PC…" />;
  if (!opened && q.isError) {
    return (
      <Typography variant="body2" sx={{ color: c.danger }}>
        could not read recordings: {q.error.message}
      </Typography>
    );
  }

  const header = (
    <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <Box>
        <Typography variant="h1">recordings</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          cut a night into one upload per artist. cuts are lossless and only the cut parts leave the PC.
        </Typography>
      </Box>
      {!opened && (
        <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
          <Button size="small" variant="outlined" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
            {rescan.isPending ? 'scanning…' : 'rescan'}
          </Button>
          {rescan.isError && (
            <Typography variant="caption" sx={{ color: c.danger }}>could not rescan: {rescan.error.message}</Typography>
          )}
        </Stack>
      )}
    </Stack>
  );

  // Off, or off the tailnet. Normal, not an error: nothing already uploaded is affected.
  if (!opened && !q.data?.reachable) {
    return (
      <Stack spacing={3}>
        {header}
        <Typography variant="body2" color="text.secondary">
          the OBS PC is not reachable right now. recordings already uploaded are not affected.
        </Typography>
      </Stack>
    );
  }

  const list = q.data?.reachable ? q.data.recordings : [];
  const note = opened ? editorNote(q.data, opened.ref) : null;
  return (
    <Stack spacing={4}>
      {header}
      {opened ? (
        <>
          {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
          <Editor key={opened.ref} recording={opened} onClose={() => setOpened(null)} />
        </>
      ) : (
        <Stack spacing={1.5}>
          {list.length === 0 && (
            <Typography variant="body2" color="text.secondary">no recordings on the OBS PC.</Typography>
          )}
          {list.map((r) => (
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
              <Button size="small" variant="outlined" disabled={r.state !== 'ready'} onClick={() => setOpened(r)}>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const nextId = useRef(1);
  const newId = () => String(nextId.current++);

  // The server computes the real % from S3 (ListParts), so every machine shows the same number.
  const fractionFor = (showId: string | null): number | null => {
    if (showId === null) return null;
    const pct = uploading.data?.find((u) => u.show_id === showId)?.pct;
    return typeof pct === 'number' ? pct / 100 : null;
  };

  const cutFor = (s: Draft) => {
    const cutId = s.showId ? cutByShow[s.showId] : undefined;
    return statuses.data?.find((x) => x.cutId === cutId);
  };
  const anyActive = segments.some((s) => isActive(cutFor(s)));
  const problems = validateSegments(segments, durationS);
  const canCut = segments.length > 0 && segments.every((s) => s.showId) && problems.length === 0 && !startCuts.isPending && !anyActive;

  const selected = segments.find((s) => s.id === selectedId) ?? null;
  const waveform = useMemo(() => (peaks.data ? toWaveform(peaks.data) : null), [peaks.data]);
  const seek = (seconds: number) => {
    if (video.current) video.current.currentTime = seconds;
    setPlayhead(seconds);
  };

  const patch = (id: string, change: Partial<Draft>) => setSegments((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

  // Agenda times are DRAFT markers: they fill in a first guess the operator then corrects.
  const suggest = () => {
    const slots = (shows.data ?? []).map(agendaSlot).filter((s): s is NonNullable<typeof s> => s !== null);
    const next = suggestSegments(recording.recordedAtMs, durationS, slots).map((s) => ({ ...s, id: newId() }));
    setSegments(next);
    setSelectedId(next[0]?.id ?? null);
  };

  const add = () => {
    const seg = newSegmentAt(playhead, durationS, segments);
    if (!seg) return;
    const draft = { ...seg, id: newId(), showId: null };
    setSegments((all) => [...all, draft].sort((a, b) => a.startS - b.startS));
    setSelectedId(draft.id);
  };

  // Removing the selected segment selects its neighbour (the next one, else the previous).
  const remove = (id: string) => {
    setSelectedId(selectAfterRemove(segments, id, selectedId));
    setSegments(segments.filter((x) => x.id !== id));
  };

  const submit = () =>
    startCuts.mutate(
      { ref: recording.ref, segments: segments.map(({ startS, endS, showId }) => ({ startS, endS, showId: showId! })) },
      { onSuccess: (r) => setCutByShow(Object.fromEntries(r.cuts.map((x) => [x.showId, x.cutId]))) }
    );

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'baseline', minWidth: 0 }}>
        <Button size="small" onClick={onClose} sx={{ flexShrink: 0 }}>← recordings</Button>
        <Typography sx={{ fontWeight: 600, minWidth: 0 }} noWrap>{recording.filename}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{humanDuration(durationS)}</Typography>
      </Stack>

      {preview.data ? (
        <Box
          component="video" ref={video} src={preview.data.path} controls preload="metadata" playsInline
          onTimeUpdate={(e: React.SyntheticEvent<HTMLVideoElement>) => setPlayhead(e.currentTarget.currentTime)}
          sx={{ width: '100%', maxWidth: '100%', maxHeight: '45vh', backgroundColor: '#000', display: 'block' }}
        />
      ) : (
        <Typography variant="caption" color="text.disabled">
          {!recording.hasPreview
            ? 'no preview available for this recording.'
            : preview.isError ? `could not open the preview: ${preview.error.message}` : 'loading the preview…'}
        </Typography>
      )}

      <Stack spacing={1} sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">zoom</Typography>
          <IconButton size="small" aria-label="zoom out" disabled={zoomIndex === 0} onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}>−</IconButton>
          <Typography variant="caption" sx={{ minWidth: 32, textAlign: 'center' }}>{ZOOM_LEVELS[zoomIndex]}x</Typography>
          <IconButton size="small" aria-label="zoom in" disabled={zoomIndex === ZOOM_LEVELS.length - 1} onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}>+</IconButton>
          {peaks.isPending && <Typography variant="caption" color="text.disabled">loading the waveform…</Typography>}
          {peaks.isError && <Typography variant="caption" color="text.disabled">no waveform available, the timeline still works.</Typography>}
        </Stack>
        <TrimBar
          duration={durationS}
          start={selected?.startS ?? null}
          end={selected?.endS ?? null}
          currentTime={playhead}
          zoom={ZOOM_LEVELS[zoomIndex]}
          onChange={(startS, endS) => selected && patch(selected.id, { startS, endS })}
          onScrub={seek}
          waveform={waveform}
          others={segments.filter((s) => s.id !== selectedId).map((s) => ({ start: s.startS, end: s.endS }))}
          disabled={selected ? isActive(cutFor(selected)) : false}
        />
        <Typography variant="caption" color="text.disabled">
          select a segment, then drag its edges or the block on the timeline. click or drag the timeline to seek. agenda times are only a first guess.
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1}>
        <Button size="small" variant="outlined" onClick={suggest} disabled={!shows.data || anyActive}>suggest from agenda</Button>
        <Button size="small" variant="outlined" onClick={add} disabled={anyActive || newSegmentAt(playhead, durationS, segments) === null}>add segment</Button>
      </Stack>

      <Stack spacing={1}>
        {segments.map((s, i) => {
          const expected = cutFilename(recording.filename, s.startS, s.endS);
          return (
            <SegmentRow
              key={s.id} index={i} draft={s} playhead={playhead} expectedFilename={expected}
              cut={cutFor(s)}
              selected={s.id === selectedId}
              onSelect={() => setSelectedId(s.id)}
              uploadFraction={fractionFor(s.showId)}
              showOptions={(shows.data ?? []).map((x) => ({ id: x.id, title: x.title, taken: segments.some((o) => o.id !== s.id && o.showId === x.id) }))}
              problem={problems.find((p) => p.index === i)?.message}
              onChange={(change) => patch(s.id, change)}
              onRemove={() => remove(s.id)}
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
  cut: CutStatusView | undefined; selected: boolean; onSelect(): void; uploadFraction: number | null;
  showOptions: { id: string; title: string; taken: boolean }[];
  problem: string | undefined;
  onChange(change: Partial<Draft>): void; onRemove(): void;
}) {
  const { draft, cut, index } = props;
  // Only a video whose filename matches THIS cut counts as this segment's result.
  const staged = useStaged(draft.showId ?? undefined).data;
  const matching = staged && staged.filename === props.expectedFilename ? staged : null;
  const status = resolveSegment({ cut, staged: matching, uploadFraction: props.uploadFraction });
  const locked = isActive(cut);
  const replaces = staged && !matching && status.state === 'draft';

  return (
    <Stack
      spacing={0.5}
      // A mouse convenience only; the number button below is the keyboard route. Clicks that come
      // from a control (or its portalled menu) are that control's business, not a row selection.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, textarea, [role="combobox"], [role="option"], [role="listbox"]')) return;
        props.onSelect();
      }}
      sx={{
        p: 1.5, cursor: 'pointer', backgroundColor: props.selected ? c.linkSoft : c.surface,
        border: `1px solid ${props.problem ? c.danger : props.selected ? c.link : c.border}`,
      }}
    >
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <ButtonBase
          aria-label={`select segment ${index + 1}`} aria-pressed={props.selected} onClick={props.onSelect}
          sx={{ width: 28, height: 28, fontWeight: 700, border: `1px solid ${props.selected ? c.link : c.line}` }}
        >
          {index + 1}
        </ButtonBase>
        <TimeField label="in" disabled={locked} onFocus={props.onSelect} value={draft.startS} onCommit={(s) => props.onChange({ startS: s })} />
        <Button size="small" disabled={locked} onClick={() => { props.onSelect(); props.onChange({ startS: props.playhead }); }}>← playhead</Button>
        <TimeField label="out" disabled={locked} onFocus={props.onSelect} value={draft.endS} onCommit={(s) => props.onChange({ endS: s })} />
        <Button size="small" disabled={locked} onClick={() => { props.onSelect(); props.onChange({ endS: props.playhead }); }}>← playhead</Button>
        <Select
          size="small" displayEmpty value={draft.showId ?? ''} sx={{ minWidth: 220, flex: 1 }}
          disabled={locked} onOpen={props.onSelect}
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
        <Button size="small" disabled={locked} onClick={(e) => { e.stopPropagation(); props.onRemove(); }}>
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

function TimeField({ label, value, disabled, onFocus, onCommit }: { label: string; value: number; disabled: boolean; onFocus(): void; onCommit(s: number): void }) {
  const [text, setText] = useState(formatTimecode(value));
  useEffect(() => setText(formatTimecode(value)), [value]);
  return (
    <TextField
      size="small" label={label} value={text} disabled={disabled} onFocus={onFocus} sx={{ width: 130 }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        // Untouched text must not re-commit: a value set by dragging would be rounded to the displayed 0.1s.
        if (text === formatTimecode(value)) return;
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
