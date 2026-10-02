import { useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCreateShow, useStrands } from '../api/hooks';
import type { AgendaShow } from '../api/client';
import { c } from '../theme';
import { validateNewShow } from '../upload/showPicker';

type Props = {
  open: boolean;
  /** What the form starts as: the typed title and the stretch of recording being cut. */
  initial: { title: string; date: string; startTime: string; endTime: string };
  onClose: () => void;
  onCreated: (show: AgendaShow) => void;
};

/** Adds a show the agenda does not have, as a draft the upload then belongs to. */
export default function AddShowDialog({ open, initial, onClose, onCreated }: Props) {
  // The dialog is mounted only while open (see Recordings), so these start from `initial` each time.
  const [form, setForm] = useState(initial);
  const [strandId, setStrandId] = useState<string | null>(null);
  const strands = useStrands();
  const create = useCreateShow();

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const strand = strandId ?? strands.data?.find((s) => s.isDefault)?.id ?? '';
  const problem = validateNewShow(form);

  const submit = () => {
    if (problem || create.isPending) return;
    create.mutate({ ...form, title: form.title.trim(), strandId: strand || null }, { onSuccess: (show) => onCreated(show) });
  };

  return (
    <Dialog open={open} onClose={create.isPending ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>add a show</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            for something that is not in the agenda. it becomes a draft in the list of shows to process; nothing is published.
          </Typography>
          <TextField label="title" size="small" autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} />
          <TextField
            label="date" type="date" size="small" value={form.date} onChange={(e) => set({ date: e.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="from" type="time" size="small" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1 }}
            />
            <TextField
              label="to" type="time" size="small" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }} sx={{ flex: 1 }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: '-8px !important' }}>
            times are UTC, like the agenda lists them. filled in from the part of the recording you are cutting.
          </Typography>
          <TextField select label="strand" size="small" value={strand} disabled={!strands.data} onChange={(e) => setStrandId(e.target.value)}>
            {(strands.data ?? []).map((s) => (
              <MenuItem key={s.id} value={s.id}>{s.name}{s.isDefault ? ' (default)' : ''}</MenuItem>
            ))}
          </TextField>
          {strands.isError && <Typography variant="caption" sx={{ color: c.danger }}>could not load the strands: {strands.error.message}</Typography>}
          {create.isError && <Typography variant="body2" sx={{ color: c.danger }}>{create.error.message}</Typography>}
          {!create.isError && problem && form.title !== '' && <Typography variant="caption" sx={{ color: c.danger }}>{problem}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={create.isPending}>cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!!problem || create.isPending || strands.isError}>
          {create.isPending ? 'adding…' : 'add show'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
