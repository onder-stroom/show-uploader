import { useRef } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { c } from '../theme';
import { filterShows, showOptionMeta, type ShowOption } from '../upload/showPicker';

const ADD = { kind: 'add' } as const;
type Item = ShowOption | typeof ADD;
const isAdd = (i: Item): i is typeof ADD => 'kind' in i;

type Props = {
  value: string | null;
  options: ShowOption[];
  disabled?: boolean;
  onOpen?: () => void;
  onChange: (showId: string | null) => void;
  /** The operator wants a show that is not in the list; `typed` is what they had typed. */
  onAdd: (typed: string) => void;
};

/**
 * The show a segment belongs to. Type to search the shows still to process (title, date, times,
 * strand); each row shows its date and times, so identically named shows can be told apart. The
 * last row adds a show the agenda does not have.
 */
export default function ShowPicker({ value, options, disabled, onOpen, onChange, onAdd }: Props) {
  const typed = useRef('');
  return (
    <Autocomplete<Item, false, false, false>
      size="small" autoHighlight disabled={disabled} sx={{ minWidth: 260, flex: 1 }}
      // The list is wider than the field: a row carries a title and its date, times and strand.
      slotProps={{ popper: { sx: { width: 'max-content !important', minWidth: 320, maxWidth: 'min(480px, 95vw)' } } }}
      options={[...options, ADD]}
      value={options.find((o) => o.id === value) ?? null}
      onOpen={onOpen}
      isOptionEqualToValue={(a, b) => !isAdd(a) && !isAdd(b) && a.id === b.id}
      getOptionLabel={(o) => (isAdd(o) ? '' : o.title)}
      getOptionDisabled={(o) => !isAdd(o) && o.taken}
      filterOptions={(items, state) => [...filterShows(items.filter((i): i is ShowOption => !isAdd(i)), state.inputValue), ADD]}
      onInputChange={(_e, text, reason) => { if (reason === 'input') typed.current = text; }}
      onChange={(_e, item) => {
        if (!item) onChange(null);
        else if (isAdd(item)) onAdd(typed.current.trim());
        else onChange(item.id);
      }}
      renderOption={(props, item) => {
        const { key, ...rest } = props as typeof props & { key: string };
        if (isAdd(item)) {
          return (
            <Box component="li" key={key} {...rest} sx={{ fontWeight: 600 }}>
              + add a show that is not in the list…
            </Box>
          );
        }
        return (
          <Box component="li" key={key} {...rest}>
            <Box sx={{ minWidth: 0 }}>
              <Typography noWrap>{item.title}</Typography>
              <Typography variant="caption" sx={{ color: c.muted }}>
                {showOptionMeta(item)}{item.taken ? ' · used by another segment' : ''}
              </Typography>
            </Box>
          </Box>
        );
      }}
      renderInput={(params) => <TextField {...params} placeholder="choose the show…" />}
    />
  );
}
