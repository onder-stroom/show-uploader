import { useState } from 'react';
import Button from '@mui/material/Button';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { c } from '../theme';
import { formatShortcut } from '../upload/shortcuts';

/** The cheat sheet: whatever the editor registered, with the description it gave. */
export default function ShortcutSheet({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { hotkeys } = useHotkeysContext();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // One registration with two keys (redo) arrives as two entries: one row per description.
  const rows = new Map<string, string[]>();
  for (const h of hotkeys) if (h.description) rows.set(h.description, [...(rows.get(h.description) ?? []), formatShortcut(h.hotkey)]);
  return (
    <>
      <Button size="small" ref={setAnchor} onClick={onToggle}>keys (?)</Button>
      <Popover open={open && !!anchor} anchorEl={anchor} onClose={onToggle} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
        <Stack spacing={0.75} sx={{ p: 2, maxWidth: 420 }}>
          <Typography sx={{ fontWeight: 600 }}>keyboard shortcuts</Typography>
          {[...rows].map(([description, keys]) => (
            <Stack key={description} direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
              <Typography variant="body2">{description}</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap', color: c.link }}>{keys.join(' · ')}</Typography>
            </Stack>
          ))}
        </Stack>
      </Popover>
    </>
  );
}
