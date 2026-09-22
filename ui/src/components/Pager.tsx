import { useNavigate, useSearch } from '@tanstack/react-router';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export const PAGE_SIZES = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

// The URL state of a paged list. `page` is 1-based, as the reader sees it.
// Everything is optional, so a plain link to the route stays valid.
export type PagedSearch = { page?: number; per?: number; q?: string };

// For a route's validateSearch. Junk values fall back to the defaults rather
// than erroring, since these arrive from hand-edited and shared URLs.
export function pagedSearch(search: Record<string, unknown>): PagedSearch {
  const page = Number(search.page);
  const per = Number(search.per);
  return {
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    per: (PAGE_SIZES as readonly number[]).includes(per) && per !== DEFAULT_PAGE_SIZE ? per : undefined,
    q: typeof search.q === 'string' && search.q ? search.q : undefined,
  };
}

// Client-side search + pagination over a card list — shared by the archive and
// jobs-queue pages so both behave identically. Query, page and page size live
// in the URL, so reload, back/forward and shared links land on the same page.
// The route must spread `pagedSearch` into its validateSearch.
export function usePaged<T>(items: T[], searchText: (t: T) => string) {
  const search = useSearch({ strict: false }) as PagedSearch;
  const navigate = useNavigate();
  const query = search.q ?? '';
  const pageSize = search.per ?? DEFAULT_PAGE_SIZE;

  // Defaults are dropped from the URL so the plain route stays the plain route.
  // Typing replaces the history entry; paging pushes one, so back steps a page.
  const update = (next: PagedSearch, replace = false) =>
    void navigate({
      to: '.',
      // Merge, don't rebuild: the route's other params (e.g. history's
      // `highlight`) must survive a page turn.
      search: (prev: Record<string, unknown>) => {
        const merged = { ...prev, ...next };
        return { ...merged, ...pagedSearch(merged) };
      },
      replace,
    } as never);

  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter((t) => searchText(t).toLowerCase().includes(q)) : items;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clamped = Math.min(Math.max((search.page ?? 1) - 1, 0), pageCount - 1);
  const slice = filtered.slice(clamped * pageSize, clamped * pageSize + pageSize);
  return {
    query,
    setQuery: (v: string) => update({ q: v, page: undefined }, true),
    slice,
    page: clamped,
    pageCount,
    total: filtered.length,
    setPage: (p: number) => update({ page: p + 1 }),
    pageSize,
    // Keep the first visible item on screen rather than jumping back to page 1.
    setPageSize: (per: number) => update({ per, page: Math.floor((clamped * pageSize) / per) + 1 }),
  };
}

export function Pager({
  page,
  pageCount,
  total,
  setPage,
  pageSize,
  setPageSize,
  unit,
}: {
  page: number;
  pageCount: number;
  total: number;
  setPage: (p: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  unit: string;
}) {
  // Bigger tap targets than the old text links — these sit at the bottom of a
  // long list, which is exactly where a thumb lands.
  const nav = {
    fontSize: '0.75rem',
    color: 'text.disabled',
    px: 1,
    py: 0.5,
    minHeight: 32,
    '&:hover': { color: 'text.primary' },
  };
  return (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.disabled">
          {total} {unit}
        </Typography>
        {total > PAGE_SIZES[0] && (
          <TextField
            select
            size="small"
            variant="standard"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            slotProps={{ htmlInput: { 'aria-label': 'items per page' } }}
            sx={{ '& .MuiInputBase-input': { fontSize: '0.75rem', color: 'text.disabled', py: 0.5 } }}
          >
            {PAGE_SIZES.map((n) => (
              <MenuItem key={n} value={n} sx={{ fontSize: '0.75rem' }}>
                {n} / page
              </MenuItem>
            ))}
          </TextField>
        )}
      </Stack>
      {pageCount > 1 && (
        <Stack direction="row" spacing={{ xs: 1, sm: 2 }} sx={{ alignItems: 'center' }}>
          <Button variant="text" onClick={() => setPage(page - 1)} disabled={page === 0} sx={nav}>
            ← prev
          </Button>
          <Typography variant="caption" color="text.disabled" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {page + 1} / {pageCount}
          </Typography>
          <Button variant="text" onClick={() => setPage(page + 1)} disabled={page >= pageCount - 1} sx={nav}>
            next →
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
