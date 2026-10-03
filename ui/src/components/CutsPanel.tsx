import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { c } from '../theme';
import { cutLabel, isRunning, type CutItem } from '../upload/cutLabel';
import { formatTimecode } from '../upload/segments';

type Props = {
  /** The cuts of this recording, newest first. */
  cuts: CutItem[];
  titleOf(showId: string): string;
  /** 0..1 for an upload in progress, from S3. */
  fractionOf(showId: string): number | null;
  /** OBS is recording on the PC, which holds cuts and uploads back. */
  paused: boolean;
};

/**
 * Where this recording's cuts are, from the server: the same after a reload, in another tab or on
 * another machine. Closing the tab is safe, because the cutting and the upload run on the PC and the worker.
 */
export default function CutsPanel({ cuts, titleOf, fractionOf, paused }: Props) {
  if (cuts.length === 0) return null;
  const running = cuts.some(isRunning);
  return (
    <Stack spacing={1} sx={{ p: 1.5, backgroundColor: c.surface, border: `1px solid ${c.border}` }}>
      <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 600 }}>cuts of this recording</Typography>
        {running && <Typography variant="caption" color="text.secondary">you can close this tab: the cuts keep running.</Typography>}
      </Stack>
      {running && paused && (
        <Typography variant="body2" sx={{ color: c.danger }}>
          OBS is recording on the PC, so cutting and uploading are paused until it stops. Nothing is lost; they carry on by themselves.
        </Typography>
      )}
      {cuts.map((cut) => (
        <Stack key={cut.cutId} direction="row" spacing={2} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 0 }} noWrap>{titleOf(cut.showId)}</Typography>
          <Typography variant="caption" color="text.secondary">{formatTimecode(cut.startS)} → {formatTimecode(cut.endS)}</Typography>
          <Typography variant="caption" sx={{ color: cut.state === 'failed' ? c.danger : cut.state === 'done' ? c.ok : c.muted }}>
            {cutLabel(cut, fractionOf(cut.showId))}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
