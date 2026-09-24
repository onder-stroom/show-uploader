import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, Link } from '@tanstack/react-router';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import {
  useShow,
  useGeneratedMeta,
  usePendingVideos,
  useClaimPending,
  useCreateUpload,
  useStaged,
  useSaveShowMetadata,
  useUploads,
} from '../api/hooks';
import { trpcClient } from '../api/trpc';
import MetadataForm from '../components/MetadataForm';
import { FullPageDropzone, UploadControl } from '../components/Dropzone';
import PlatformSelector from '../components/PlatformSelector';
import { publishedPlatforms } from '../components/platforms';
import { PageLoading } from '../components/Skeleton';
import TrimFields from '../components/TrimFields';
import VideoPreview from '../components/VideoPreview';
import DownloadLink from '../components/DownloadLink';
import { useUpload } from '../upload/UploadProvider';
import { resolveVideo, type StagedVideo } from '../upload/resolveVideo';
import { usePresence } from '../presence/PresenceProvider';
import { shortName } from '../components/PresenceRoster';
import { humanSize } from '../format';
import { c, ROLE, LABEL_SX } from '../theme';

// The agenda site hosts the archive record's admin detail page at
// `<base>/#/archive/<recordId>`, and the record id is the same id we use as showId.
const AGENDA_BASE = import.meta.env.VITE_POCKETBASE_URL ?? 'https://agenda.coming-soon.space';

const ALL_PLATFORMS = ['youtube', 'mixcloud'];
const LABEL_TO_PLATFORM: Record<string, string> = { YouTube: 'youtube', MixCloud: 'mixcloud' };

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// The scheduled show length from the agenda start/end (both "HH:MM"), as HH:MM:SS
// — the expected recording duration, suggested as a trim end point. Handles an
// overnight window (end past midnight). Null when the times don't parse.
function scheduledDuration(startTime: string, endTime: string): string | null {
  const toMin = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '');
    return m ? +m[1] * 60 + +m[2] : null;
  };
  const s = toMin(startTime);
  const e = toMin(endTime);
  if (s === null || e === null) return null;
  let mins = e - s;
  if (mins <= 0) mins += 24 * 60; // crosses midnight
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

// Published title convention: "<name> <DD.MM.YYYY> @ coming soon".
function publishTitle(name: string, date: string): string {
  const [y, m, d] = (date ?? '').split('-');
  const dmy = d && m && y ? `${d}.${m}.${y}` : date;
  // Strip an existing "<date> @ coming soon" suffix (as one unit) first so a
  // show title that already follows the convention doesn't get it appended
  // twice — without touching a bare trailing date that's part of the real name.
  const base = (name ?? '')
    .replace(/\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*)?@\s*coming soon\s*$/i, '')
    .trim();
  return `${base} ${dmy} @ coming soon`;
}

// Inline text links are only as tall as their text — around 17px here, well
// under a thumb. This gives them a 32px hit area without changing how they look.
const tapLinkSx = { display: 'inline-flex', alignItems: 'center', minHeight: 32 } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box component="section" sx={{ borderTop: `1px solid ${c.line}`, pt: 3 }}>
      <Typography sx={{ ...LABEL_SX, mb: 2, display: 'block' }}>{title}</Typography>
      {children}
    </Box>
  );
}

// A short status line above the form (took-over notice, running job).
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: 0.5,
        border: `1px solid ${c.ink}`,
        px: 1.5,
        py: 1,
      }}
    >
      {children}
    </Stack>
  );
}

export default function NewUpload() {
  const { showId } = useParams({ strict: false }) as { showId?: string };
  const navigate = useNavigate();

  // Any status, not just drafts: an attach-recording flow points here at an
  // already-published show. Also removes listShows' perPage=200 cap for the
  // direct-by-id case.
  const showQuery = useShow(showId ?? '', !!showId);
  const selectedShow = showQuery.data ?? null;

  // An upload for this show whose platform work hasn't settled yet. Newest
  // first, since a re-upload leaves the older finished one behind.
  const { data: allUploads = [] } = useUploads();
  const runningUpload =
    allUploads
      .filter((u) => u.show_id === showId)
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      .find((u) => u.jobs.some((j) => j.status === 'queued' || j.status === 'processing')) ?? null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState('');
  // A hand-picked drop-folder file (not a staged upload). Everything else about
  // "does this show have a video" is DERIVED, never stored — see resolveVideo.
  const [pickedVideo, setPickedVideo] = useState<StagedVideo | null>(null);
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewConverting, setPreviewConverting] = useState(false);
  const [platforms, setPlatforms] = useState<string[]>(['youtube', 'mixcloud']);
  const [includeJingle, setIncludeJingle] = useState(true);
  const [trimStart, setTrimStart] = useState('');
  const [trimEnd, setTrimEnd] = useState('');
  const [autoTrimSilence, setAutoTrimSilence] = useState(true);

  const qc = useQueryClient();
  // Everything the record actually says: the episode notes, the series blurb and
  // the curated genres. The model is told to use only these — see groq.ts.
  const meta = useGeneratedMeta(
    selectedShow?.title,
    [selectedShow?.description, selectedShow?.showDescription].filter(Boolean).join('\n\n'),
    selectedShow?.tags ?? undefined
  );
  const pending = usePendingVideos();
  const claim = useClaimPending();
  const createUpload = useCreateUpload();
  const saveMeta = useSaveShowMetadata();
  const upload = useUpload();
  const activeUpload = showId ? upload.get(showId) : undefined;
  const stagedQ = useStaged(showId);
  const presence = usePresence();

  // THE single source of truth for the form's video, derived from the live
  // upload + the server-staged video + a hand-picked drop-folder file.
  const video = resolveVideo({
    live: activeUpload ?? null,
    staged: stagedQ.data ? { s3_key: stagedQ.data.s3_key, filename: stagedQ.data.filename } : null,
    pending: pickedVideo,
  });
  const videoS3Key = video.state === 'ready' ? video.key : '';
  const videoFilename = video.state === 'ready' || video.state === 'uploading' || video.state === 'error' ? video.filename : '';

  // Soft claim: opening auto-claims the show, unless someone else holds it — then
  // we show an interstitial and only claim (steal) once the user opts to open anyway.
  const existingClaim = showId ? presence.claims[showId] : undefined;
  const heldByOther = !!existingClaim && existingClaim.userSub !== presence.myUserId;
  const [ackSteal, setAckSteal] = useState(false);
  const proceeding = !heldByOther || ackSteal;

  useEffect(() => {
    setAckSteal(false);
  }, [showId]);

  useEffect(() => {
    if (!showId || !proceeding) return;
    presence.hold(showId);
    return () => presence.unhold(showId);
  }, [showId, proceeding]);

  // When a live upload finishes, the server has already recorded the staged
  // video (in the multipart 'complete' step) — just refetch so the ready state
  // is durable across navigation. A fresh upload supersedes a drop-folder pick.
  useEffect(() => {
    if (activeUpload?.status === 'done') {
      setPickedVideo(null);
      setSelectedPendingId(null);
      void qc.invalidateQueries({ queryKey: ['staged', showId] });
      void qc.invalidateQueries({ queryKey: ['staged-shows'] });
    }
  }, [activeUpload?.status, showId, qc]);

  // Platforms already published on this record (YouTube/MixCloud), from mediaLinks.
  const existingLinks = selectedShow?.mediaLinks ?? [];

  // On show change, reset the editable fields + drop-folder pick. The video
  // itself is DERIVED (staged query + live upload, both keyed by showId), so
  // there's nothing to reset or race here.
  useEffect(() => {
    if (!selectedShow) return;
    setTitle(publishTitle(selectedShow.title, selectedShow.date));
    // Description = the episode's own notes (PB is master); fall back to the
    // linked show's blurb when the episode has none of its own.
    setDescription(selectedShow.description || selectedShow.showDescription || '');
    setTags(selectedShow.tags ?? []);
    setImageUrl(selectedShow.imageUrl ?? '');
    setPickedVideo(null);
    setSelectedPendingId(null);
    setPreviewOpen(false);

    // Re-publish smarts: pre-select only the platform(s) not yet up. If both are
    // already published, select NONE (never re-publish → duplicate).
    const already = publishedPlatforms(selectedShow.mediaLinks ?? []);
    setPlatforms(ALL_PLATFORMS.filter((p) => !already.has(p)));
  }, [selectedShow?.id]);

  // The AI description is a SUGGESTION (a button in the form), not an auto-
  // override — PocketBase is the master, so the field stays the record's notes
  // until the operator chooses to apply the suggestion. (Tags work the same way.)

  const handleField = (field: string, value: string | string[]) => {
    if (field === 'title') setTitle(value as string);
    if (field === 'description') setDescription(value as string);
    if (field === 'tags') setTags(value as string[]);
    if (field === 'imageUrl') setImageUrl(value as string);
  };

  // The preview remux replaced the recording with an MP4 and deleted the
  // original. A staged video is re-read from the server, but a drop-folder pick
  // lives here — leaving it on the old key would publish a deleted object.
  const handleConverted = useCallback((mp4Key: string) => {
    setPickedVideo((prev) =>
      prev ? { ...prev, s3_key: mp4Key, filename: mp4Key.split('/').pop() ?? prev.filename } : prev
    );
  }, []);

  // Discard this show's video: clear the pick, cancel/forget any live upload, and
  // remove the server-staged record. The derived `video` then falls back to none.
  const handleReplace = () => {
    setPickedVideo(null);
    setSelectedPendingId(null);
    setPreviewOpen(false);
    if (showId) {
      upload.reset(showId);
      void trpcClient.uploads.deleteStaged.mutate({ showId }).catch(() => {});
      void qc.invalidateQueries({ queryKey: ['staged', showId] });
      void qc.invalidateQueries({ queryKey: ['staged-shows'] });
    }
  };

  const handleSubmit = () => {
    if (!selectedShow || !videoS3Key) return;
    createUpload.mutate(
      {
        showId: selectedShow.id,
        title,
        description,
        tags,
        imageUrl: imageUrl || null,
        videoS3Key,
        platforms: platforms as ('youtube' | 'mixcloud')[],
        includeJingle,
        autoTrimSilence,
        trimStart: trimStart || null,
        trimEnd: trimEnd || null,
      },
      {
        onSuccess: async ({ uploadId }) => {
          if (selectedPendingId) await claim.mutateAsync(selectedPendingId).catch(() => {});
          // Publishing clears the staged row server-side — reflect that.
          qc.invalidateQueries({ queryKey: ['staged', showId] });
          qc.invalidateQueries({ queryKey: ['staged-shows'] });
          void navigate({ to: '/history', search: { highlight: uploadId } });
        },
      }
    );
  };

  // Blocked during a preview convert: the remux deletes the source, so a publish
  // started now would hand the platform jobs an object that disappears mid-run.
  const canSubmit =
    !!selectedShow &&
    !!videoS3Key &&
    // Zero platforms is always a valid submit: it archives the recording and
    // touches no platform. The replace flow depends on it (forcing a platform
    // pick here is what caused duplicate MixCloud posts), and the button
    // labels the choice loudly — "save & archive this recording".
    !createUpload.isPending &&
    !previewConverting;
  const pendingVideos = pending.data ?? [];

  if (showQuery.isPending) {
    return <PageLoading label="loading…" />;
  }

  if (!selectedShow) {
    return (
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Typography color="text.secondary">that show isn't in the schedule (it may have loaded already).</Typography>
        <Button component={Link} to="/">
          ← back to shows
        </Button>
      </Stack>
    );
  }

  if (heldByOther && !ackSteal) {
    return (
      <Paper variant="outlined" sx={{ mx: 'auto', maxWidth: 448, p: 3, borderColor: c.ink }}>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="caption" color="text.disabled">
              already being processed
            </Typography>
            <Typography variant="h1" sx={{ mt: 1 }}>
              {selectedShow.title}
            </Typography>
          </Box>
          <Typography color="text.secondary">
            <Box component="span" sx={{ color: c.ink }}>
              {shortName(existingClaim!.userName)}
            </Box>{' '}
            is already working on this ({timeAgo(existingClaim!.claimedAt)}). two people on the same show usually
            means duplicate work.
          </Typography>
          {/* Stacks on phones — side by side these two fell under 44px each. */}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              variant="contained"
              color={ROLE.destroy}
              onClick={() => setAckSteal(true)}
              sx={{ flex: 1, minHeight: 44 }}
            >
              open anyway
            </Button>
            <Button component={Link} to="/" sx={{ flex: 1, minHeight: 44 }}>
              back
            </Button>
          </Stack>
        </Stack>
      </Paper>
    );
  }

  return (
    <FullPageDropzone showId={selectedShow.id}>
      <Stack spacing={4} sx={{ mx: 'auto', maxWidth: 576 }}>
        {existingClaim && existingClaim.userSub === presence.myUserId && ackSteal && (
          <Notice>
            <Typography variant="caption" color="text.secondary">
              you took this over — it's now claimed by you
            </Typography>
          </Notice>
        )}

        {/* Arriving here from the archive's "replace" link (or a second tab)
            while this show still has work in flight: say so and point at it,
            rather than letting the operator queue a second run blind. */}
        {runningUpload && (
          <Notice>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
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
              <Typography variant="caption" color="text.secondary">
                this show already has an upload running
              </Typography>
            </Stack>
            {/* Plain TanStack Link — its typed `search` doesn't survive MUI's
                `component` generic, so the styling hangs off the wrapper. */}
            <Box
              sx={{
                fontSize: '0.6875rem',
                '& a': {
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 32,
                  color: c.link,
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                },
                '& a:hover': { color: c.ink },
              }}
            >
              <Link to="/history" search={{ highlight: runningUpload.id }}>
                view job →
              </Link>
            </Box>
          </Notice>
        )}

        <Box>
          <MuiLink component={Link} to="/" color={ROLE.navigate} sx={tapLinkSx}>
            ← to process
          </MuiLink>
          <Typography variant="h1" sx={{ mt: 1, textTransform: 'none' }}>
            {selectedShow.title}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ mt: 0.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {selectedShow.date} · {selectedShow.startTime}–{selectedShow.endTime}
            </Typography>
            <MuiLink
              href={`${AGENDA_BASE}/#/archive/${selectedShow.id}`}
              target="_blank"
              rel="noreferrer"
              variant="body2"
              color={ROLE.navigate}
              sx={tapLinkSx}
            >
              ↗ open in agenda
            </MuiLink>
          </Stack>
        </Box>

        {pendingVideos.length > 0 && (
          <Section title="from drop folder">
            <Stack spacing={0.75}>
              {pendingVideos.map((v) => {
                const on = selectedPendingId === v.id;
                return (
                  <ButtonBase
                    key={v.id}
                    onClick={() => {
                      setPickedVideo({ s3_key: v.s3_key, filename: v.filename });
                      setSelectedPendingId(v.id);
                    }}
                    aria-pressed={on}
                    sx={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1.5,
                      px: 1.75,
                      py: 1.25,
                      minHeight: 44,
                      border: `1px solid ${on ? c.ink : c.line}`,
                      backgroundColor: on ? c.accentSoft : c.surface,
                      color: on ? c.ink : c.muted,
                      '&:hover': { borderColor: c.ink, color: c.ink },
                    }}
                  >
                    <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
                      {v.filename}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
                      {(v.size_bytes / 1e9).toFixed(1)} GB
                    </Typography>
                  </ButtonBase>
                );
              })}
            </Stack>
          </Section>
        )}

        <Section title="details">
          <MetadataForm
            showId={selectedShow.id}
            title={title}
            description={description}
            tags={tags}
            imageUrl={imageUrl}
            generating={meta.isFetching}
            suggestedTags={meta.data?.tags ?? []}
            suggestedDescription={meta.data?.youtubeDescription ?? ''}
            onChange={handleField}
          />
          {/* Persist title / description / tags straight to the agenda record now —
              they survive a refresh / navigation, without waiting for the upload to
              finish. PocketBase is the master; the description is the episode's own
              notes (not the AI copy, which is just a suggestion above). */}
          <Stack
            direction="row"
            spacing={1.5}
            sx={{
              mt: 2,
              pt: 2,
              alignItems: 'center',
              flexWrap: 'wrap',
              rowGap: 1,
              borderTop: `1px solid ${c.line}`,
            }}
          >
            <Button
              disabled={saveMeta.isPending || !title.trim()}
              color={ROLE.write}
              onClick={() => saveMeta.mutate({ id: selectedShow.id, title, description, tags })}
              sx={{ minHeight: 40 }}
            >
              {saveMeta.isPending ? 'saving…' : 'save to agenda'}
            </Button>
            {saveMeta.isSuccess && !saveMeta.isPending && (
              <Typography variant="caption" color="success.main">
                ✓ saved to agenda
              </Typography>
            )}
            {saveMeta.isError && (
              <Typography variant="caption" color="error.main">
                save failed — try again
              </Typography>
            )}
            <Typography variant="caption" color="text.disabled" sx={{ ml: { sm: 'auto' } }}>
              pocketbase is the master · persists now
            </Typography>
          </Stack>
        </Section>

        <Section title="video">
          {video.state === 'ready' ? (
            <>
              <Stack
                direction="row"
                spacing={1.5}
                sx={{
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  border: `1px solid ${c.ok}`,
                  backgroundColor: c.okSoft,
                  px: 2,
                  py: 1.5,
                }}
              >
                <Typography noWrap sx={{ minWidth: 0 }}>
                  ✓ {videoFilename || 'video ready'}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
                  <Button
                    variant="text"
                    onClick={() => setPreviewOpen((v) => !v)}
                    sx={{ minHeight: 32, fontSize: '0.6875rem' }}
                  >
                    {previewOpen ? 'hide preview' : 'preview'}
                  </Button>
                  <DownloadLink objectKey={videoS3Key || null} label="download" />
                  <Button
                    variant="text"
                    color={ROLE.destroy}
                    onClick={handleReplace}
                    sx={{ minHeight: 32, fontSize: '0.6875rem' }}
                  >
                    replace
                  </Button>
                </Stack>
              </Stack>
              <VideoPreview
                videoS3Key={videoS3Key}
                open={previewOpen}
                onConverted={handleConverted}
                onConvertingChange={setPreviewConverting}
              />
            </>
          ) : (
            showId && <UploadControl showId={showId} />
          )}
        </Section>

        <Section title="trim">
          <TrimFields
            autoTrimSilence={autoTrimSilence}
            trimStart={trimStart}
            trimEnd={trimEnd}
            scheduledDuration={scheduledDuration(selectedShow.startTime, selectedShow.endTime)}
            onAutoTrimChange={setAutoTrimSilence}
            onChange={(field, value) => {
              if (field === 'trimStart') setTrimStart(value);
              if (field === 'trimEnd') setTrimEnd(value);
            }}
          />
        </Section>

        <Section title="publish to">
          <PlatformSelector
            platforms={platforms}
            includeJingle={includeJingle}
            showId={selectedShow.id}
            existingLinks={existingLinks}
            meta={{ title, description, tags, imageUrl: imageUrl || null }}
            onChange={setPlatforms}
            onJingleChange={setIncludeJingle}
          />
        </Section>

        <Box sx={{ borderTop: `1px solid ${c.line}`, pt: 3 }}>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={!canSubmit}
            sx={{ width: '100%', minHeight: 48, fontSize: '0.9375rem' }}
          >
            {createUpload.isPending
              ? 'starting…'
              : platforms.length === 0
                ? 'save & archive this recording'
                : 'save & start platform uploads'}
          </Button>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: 'block', textAlign: 'center' }}>
            {!videoS3Key
              ? 'add a video to start.'
              : platforms.length === 0
                ? 'muxes to mp4 + extracts audio, then links both on the agenda record.'
                : 'uploads to youtube/mixcloud + syncs the draft. publishing the agenda record is a separate step (archive page).'}
          </Typography>
        </Box>
      </Stack>
    </FullPageDropzone>
  );
}
