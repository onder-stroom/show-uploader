import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useDropzone } from 'react-dropzone';
import { Link } from '@tanstack/react-router';
import prettyBytes from 'pretty-bytes';
import prettyMs from 'pretty-ms';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useUpload, type UploadItem } from '../upload/UploadProvider';
import { c, withAlpha, ROLE } from '../theme';

const OpenContext = createContext<() => void>(() => {});

export function FullPageDropzone({ children, showId }: { children: ReactNode; showId: string }) {
  const { start } = useUpload();
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) start(accepted[0], showId);
    },
    [start, showId]
  );
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    multiple: false,
    accept: { 'video/*': ['.mkv', '.mp4', '.mov', '.webm'] },
  });

  const { ref: rootRef, ...rootProps } = getRootProps();

  return (
    <Box {...rootProps} ref={rootRef} sx={{ position: 'relative', minHeight: '100vh' }}>
      <input {...getInputProps()} />
      <OpenContext.Provider value={open}>{children}</OpenContext.Provider>
      {isDragActive && (
        <Stack
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: 1300,
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            backgroundColor: withAlpha(c.page, 0.85),
            backdropFilter: 'blur(4px)',
          }}
        >
          <Box sx={{ border: `2px dashed ${c.ink}`, px: { xs: 4, sm: 8 }, py: { xs: 6, sm: 6 }, textAlign: 'center' }}>
            <Typography variant="h2">drop to upload</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              mkv · mp4 · mov · webm — resumable
            </Typography>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

// Human-readable transfer stats via pretty-bytes / pretty-ms.
function stats(uploadedBytes: number, totalBytes: number, bytesPerSec: number): string {
  const parts = [`${prettyBytes(uploadedBytes)} / ${prettyBytes(totalBytes)}`];
  if (bytesPerSec > 0) {
    parts.push(`${prettyBytes(bytesPerSec)}/s`);
    const remainingMs = ((totalBytes - uploadedBytes) / bytesPerSec) * 1000;
    if (remainingMs > 0) parts.push(`${prettyMs(remainingMs, { compact: true })} left`);
  }
  return parts.join(' · ');
}

export function UploadControl({ showId }: { showId: string }) {
  const open = useContext(OpenContext);
  const { get, cancel } = useUpload();
  const item = get(showId);
  const pct = Math.round((item?.fraction ?? 0) * 100);

  if (item?.status === 'uploading') {
    return (
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography noWrap sx={{ minWidth: 0 }}>
            {item.filename}
          </Typography>
          <Button
            variant="text"
            onClick={() => cancel(showId)}
            color={ROLE.destroy}
            sx={{ flexShrink: 0, minHeight: 32, fontSize: '0.6875rem' }}
          >
            cancel
          </Button>
        </Stack>
        <LinearProgress variant="determinate" value={pct} sx={{ mt: 1.5 }} />
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          {pct}% · {stats(item.uploadedBytes, item.totalBytes, item.bytesPerSec)} · resumable
        </Typography>
      </Paper>
    );
  }

  if (item?.status === 'done') {
    return (
      <Stack
        direction="row"
        spacing={1.5}
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          border: `1px solid ${c.ok}`,
          backgroundColor: c.okSoft,
          px: 2.5,
          py: 2,
        }}
      >
        <Typography noWrap sx={{ minWidth: 0 }}>
          {item.filename}
        </Typography>
        <Typography color="success.main" sx={{ flexShrink: 0, fontWeight: 500 }}>
          ✓ ready
        </Typography>
      </Stack>
    );
  }

  const failed = item?.status === 'error';
  return (
    <ButtonBase
      onClick={open}
      sx={{
        width: '100%',
        display: 'block',
        px: 3,
        py: 5,
        textAlign: 'center',
        border: `2px dashed ${failed ? c.danger : c.line}`,
        backgroundColor: failed ? c.dangerSoft : 'transparent',
        transition: 'border-color 0.12s ease, background-color 0.12s ease',
        '&:hover': failed ? {} : { borderColor: c.ink, backgroundColor: c.accentSoft },
      }}
    >
      {failed ? (
        <>
          <Typography color="error.main" sx={{ fontWeight: 500 }}>
            upload failed
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            {item.error}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: 'block' }}>
            tap to choose a file and retry
          </Typography>
        </>
      ) : (
        <>
          <Typography sx={{ fontWeight: 500 }}>drop a video anywhere</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            or tap to browse · resumable, keeps going as you navigate
          </Typography>
        </>
      )}
    </ButtonBase>
  );
}

// One row in the header queue: clickable (jumps to that show), with a cancel ✕
// so a wrong file can be stopped from anywhere (aborts the S3 multipart too).
function IndicatorRow({ item, compact }: { item: UploadItem; compact?: boolean }) {
  const { cancel } = useUpload();
  const pct = Math.round(item.fraction * 100);
  // A grid, not a row of flex items: the bar, the percentage and the speed get
  // fixed tracks, so every row lines up and the name gets ALL the remaining
  // width. Laid out as flex, a long filename collapsed to a single letter while
  // the columns wandered from row to row.
  return (
    <Box
      sx={{
        display: 'grid',
        // Cancel is in every row, compact included: with one upload running the
        // header row IS the whole queue, and it is the only way to abort a wrong
        // file from another page.
        gridTemplateColumns: 'minmax(0, 1fr) 60px 34px 62px 32px',
        alignItems: 'center',
        columnGap: 1,
        width: compact ? 'auto' : '100%',
        px: compact ? 0 : 0.5,
        py: compact ? 0 : 0.5,
      }}
    >
      {/* TanStack's Link carries typed route params, which don't survive MUI's
          `component` generic — so it stays a plain Link and the styling hangs
          off the wrapper. */}
      <Box
        sx={{
          minWidth: 0,
          '& a': { display: 'block', color: c.muted, textDecoration: 'none' },
          '& a:hover': { color: c.ink },
        }}
      >
        <Link to="/upload/$showId" params={{ showId: item.showId }} title={item.filename}>
          <Typography variant="caption" noWrap sx={{ display: 'block', maxWidth: compact ? 200 : 'none' }}>
            {item.filename}
          </Typography>
        </Link>
      </Box>
      <LinearProgress variant="determinate" value={pct} sx={{ height: 4 }} />
      <Typography variant="caption" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {pct}%
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        {item.bytesPerSec > 0 ? `${prettyBytes(item.bytesPerSec)}/s` : ''}
      </Typography>
      <Tooltip title="cancel upload">
        <Button
          variant="text"
          onClick={() => cancel(item.showId)}
          aria-label={`cancel upload of ${item.filename}`}
          color={ROLE.destroy}
          sx={{ minWidth: 24, px: 0 }}
        >
          ✕
        </Button>
      </Tooltip>
    </Box>
  );
}

export function UploadIndicator() {
  const { uploads } = useUpload();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const active = Object.values(uploads).filter((u) => u.status === 'uploading');

  if (active.length === 0) return null;
  if (active.length === 1) return <IndicatorRow item={active[0]} compact />;

  const avg = Math.round((active.reduce((s, u) => s + u.fraction, 0) / active.length) * 100);
  return (
    <>
      <Button
        ref={anchorRef}
        variant="text"
        onClick={() => setOpen((o) => !o)}
        sx={{ gap: 0.75, fontSize: '0.6875rem', color: c.muted, '&:hover': { textDecoration: 'none', color: c.ink } }}
      >
        <Box
          aria-hidden
          sx={{
            width: 6,
            height: 6,
            borderRadius: '999px',
            bgcolor: c.ink,
            animation: 'pulse 2s ease-in-out infinite',
            '@keyframes pulse': { '50%': { opacity: 0.3 } },
          }}
        />
        {active.length} uploading · {avg}%
        <Box component="span" sx={{ fontSize: '0.5625rem' }}>
          {open ? '▲' : '▼'}
        </Box>
      </Button>
      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { variant: 'outlined', sx: { mt: 1, width: 'min(560px, calc(100vw - 32px))', p: 1 } } }}
      >
        <Stack spacing={0.25}>
          {active.map((u) => (
            <IndicatorRow key={u.showId} item={u} />
          ))}
        </Stack>
      </Popover>
    </>
  );
}
