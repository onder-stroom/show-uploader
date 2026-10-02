import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { c } from '../theme';
import { formatTimecode, type Draft } from '../upload/segments';

// Ported from the Coming Soon Clipper (components/TrimControls.tsx): the same groups, in the same
// order, with the same presets and nudge size, so people who use both find their way around.
const LENGTH_PRESETS = [
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '1m30', seconds: 90 },
  { label: '2m', seconds: 120 },
];
const NUDGE_S = 0.5;

type Props = {
  segment: Draft | null;
  /** The segment cannot be edited: a cut is running, or it is frozen. */
  locked: boolean;
  onMarkIn(): void;
  onMarkOut(): void;
  onGoToIn(): void;
  onGoToOut(): void;
  onSetLength(seconds: number): void;
  onNudgeStart(deltaS: number): void;
  onNudgeEnd(deltaS: number): void;
  onStartLoop(): void;
};

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', p: 1.5, border: `1px solid ${c.border}`, backgroundColor: c.surface }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      {children}
    </Stack>
  );
}

/** The Clipper's mark / length / fine controls for the selected segment. */
export default function SegmentControls({ segment, locked, ...on }: Props) {
  const off = !segment;
  const edit = off || locked;
  const length = segment ? segment.endS - segment.startS : 0;
  return (
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <Group label="mark:">
        <Tooltip title="set the in point at the playhead. shortcut: I"><span>
          <Button size="small" variant="outlined" disabled={edit} onClick={on.onMarkIn}>IN (I)</Button>
        </span></Tooltip>
        <Tooltip title="set the out point at the playhead. shortcut: O"><span>
          <Button size="small" variant="outlined" disabled={edit} onClick={on.onMarkOut}>OUT (O)</Button>
        </span></Tooltip>
        <Tooltip title="move the playhead to the in point. shortcut: shift+I"><span>
          <Button size="small" disabled={off} onClick={on.onGoToIn}>go to IN</Button>
        </span></Tooltip>
        <Tooltip title="move the playhead to the out point. shortcut: shift+O"><span>
          <Button size="small" disabled={off} onClick={on.onGoToOut}>go to OUT</Button>
        </span></Tooltip>
        <Box component="span" sx={{ fontFamily: 'inherit', fontSize: '0.8125rem', color: c.muted }}>
          {segment ? `${formatTimecode(segment.startS)} → ${formatTimecode(segment.endS)}` : ''}
        </Box>
      </Group>

      <Group label="length:">
        {LENGTH_PRESETS.map((p) => (
          <Button key={p.seconds} size="small" disabled={edit} variant={Math.abs(length - p.seconds) < 0.05 ? 'contained' : 'outlined'} onClick={() => on.onSetLength(p.seconds)}>
            {p.label}
          </Button>
        ))}
        <Tooltip title="jump to the in point and play the segment on repeat"><span>
          <Button size="small" disabled={off} onClick={on.onStartLoop}>start loop</Button>
        </span></Tooltip>
      </Group>

      <Group label="fine:">
        <Button size="small" disabled={edit} onClick={() => on.onNudgeStart(-NUDGE_S)}>− start</Button>
        <Button size="small" disabled={edit} onClick={() => on.onNudgeStart(NUDGE_S)}>+ start</Button>
        <Button size="small" disabled={edit} onClick={() => on.onNudgeEnd(-NUDGE_S)}>− end</Button>
        <Button size="small" disabled={edit} onClick={() => on.onNudgeEnd(NUDGE_S)}>+ end</Button>
        <Typography variant="caption" color="text.secondary">duration: {segment ? length.toFixed(1) : '–'}s</Typography>
      </Group>
    </Stack>
  );
}
