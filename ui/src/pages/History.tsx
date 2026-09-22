import { useEffect, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useUploads, useDeleteUpload } from '../api/hooks';
import type { UploadWithJobs } from '../api/client';
import JobProgress from '../components/JobProgress';
import ConfirmAction from '../components/ConfirmAction';
import { usePaged, Pager } from '../components/Pager';
import { ListSkeleton } from '../components/Skeleton';
import { c } from '../theme';

const isSettled = (u: UploadWithJobs) =>
  u.jobs.length > 0 && u.jobs.every((j) => j.status === 'done' || j.status === 'failed');

function UploadCard({
  upload,
  highlight,
  highlightRef,
}: {
  upload: UploadWithJobs;
  highlight?: string;
  highlightRef: React.RefObject<HTMLDivElement>;
}) {
  const remove = useDeleteUpload();
  const isHighlit = upload.id === highlight;
  return (
    <Paper
      variant="outlined"
      ref={isHighlit ? highlightRef : null}
      sx={{
        p: { xs: 2, sm: 2.5 },
        borderColor: isHighlit ? c.ink : c.line,
        transition: 'border-color 0.2s ease',
      }}
    >
      {/* Title and timestamp stack on phones — side by side they squeezed the
          title down to a couple of words. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={{ xs: 0.5, sm: 2 }}
        sx={{ mb: 2, alignItems: { sm: 'baseline' }, justifyContent: 'space-between' }}
      >
        <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{upload.title}</Typography>
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {new Date(upload.created_at).toLocaleString()}
          {upload.archive_s3_key && (
            <Box component="span" sx={{ ml: 1, color: 'success.main' }}>
              · archived
            </Box>
          )}
        </Typography>
      </Stack>

      {upload.jobs.length > 0 ? (
        <JobProgress uploadId={upload.id} jobs={upload.jobs} />
      ) : (
        <Typography variant="caption" color="text.disabled">
          no jobs
        </Typography>
      )}

      {/* Left-aligned with the card's content, not floated right: the confirm
          step expands into "remove from queue? yes no", which off the right edge
          pushed its own buttons around. */}
      <Stack sx={{ mt: 2, alignItems: 'flex-start' }}>
        <ConfirmAction
          label="delete"
          question="remove from queue?"
          pending={remove.isPending}
          pendingLabel="deleting…"
          onConfirm={() => remove.mutate(upload.id)}
          title="remove this upload and its jobs from the queue — the files on S3 and the agenda record stay"
        />
        {remove.isError && (
          <Typography variant="caption" color="error.main" sx={{ mt: 1 }}>
            delete failed — try again.
          </Typography>
        )}
        {/* A job already running holds its worker lock and can't be pulled; say so
            rather than implying the upload was stopped. */}
        {remove.data && remove.data.stillRunning > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
            removed — but {remove.data.stillRunning} job{remove.data.stillRunning === 1 ? '' : 's'} already running
            will finish.
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}

export default function History() {
  const { data: uploads = [], isPending } = useUploads();
  const { highlight } = useSearch({ strict: false }) as { highlight?: string };
  const highlightRef = useRef<HTMLDivElement>(null);

  const active = uploads.filter((u) => !isSettled(u));
  const done = uploads.filter(isSettled);
  const paged = usePaged(done, (u) => u.title);

  useEffect(() => {
    if (highlight && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlight, uploads]);

  if (isPending) return <ListSkeleton />;

  return (
    <Stack spacing={4}>
      {active.length > 0 && (
        <Stack component="section" spacing={1.5}>
          <Typography variant="h1" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              aria-hidden
              sx={{
                width: 8,
                height: 8,
                borderRadius: '999px',
                bgcolor: c.ink,
                animation: 'pulse 2s ease-in-out infinite',
                '@keyframes pulse': { '50%': { opacity: 0.3 } },
              }}
            />
            processing
          </Typography>
          {active.map((upload) => (
            <UploadCard key={upload.id} upload={upload} highlight={highlight} highlightRef={highlightRef} />
          ))}
        </Stack>
      )}

      <Stack component="section" spacing={1.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'flex-end' }, justifyContent: 'space-between' }}
        >
          <Typography variant="h1">done</Typography>
          {done.length > 0 && (
            <TextField
              size="small"
              value={paged.query}
              onChange={(e) => paged.setQuery(e.target.value)}
              placeholder="filter done…"
              sx={{ width: { xs: '100%', sm: 256 } }}
            />
          )}
        </Stack>
        {done.length === 0 ? (
          <Typography color="text.secondary">
            {active.length > 0 ? 'nothing finished yet.' : 'no uploads yet. pick a show to get started.'}
          </Typography>
        ) : (
          <>
            {paged.slice.map((upload) => (
              <UploadCard key={upload.id} upload={upload} highlight={highlight} highlightRef={highlightRef} />
            ))}
            <Pager {...paged} unit="done" />
          </>
        )}
      </Stack>
    </Stack>
  );
}
