import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { useTRPC, trpcClient } from './trpc';

// Queries -------------------------------------------------------------------
//
// Everything except multipart uploads, the raw cover-byte upload and the SSE
// streams is served over tRPC (end-to-end typed). The remaining REST `api`
// methods cover exactly those cases.

export function useShows() {
  const trpc = useTRPC();
  return useQuery(trpc.shows.listShows.queryOptions(undefined, { staleTime: 60_000 }));
}

// Shows already published elsewhere, for the "attach a recording" picker.
// Filtered client-side in Attach.tsx to ones with no cs-archive-video link —
// this returns every published record.
export function useListPublishedShows() {
  const trpc = useTRPC();
  return useQuery(trpc.shows.listPublished.queryOptions(undefined, { staleTime: 30_000 }));
}

export function useGenres() {
  const trpc = useTRPC();
  return useQuery(trpc.shows.listGenres.queryOptions(undefined, { staleTime: 300_000 }));
}

// Cover URLs per show from PocketBase (the master). Polls so a cover changed in
// the agenda admin shows up here within ~15s without a manual refresh.
// Cover + live publish status per show, straight from PocketBase. Polled, so
// the archive reflects what's actually on the website — including changes made
// by someone else or in the agenda admin.
export function useArchiveStates() {
  const trpc = useTRPC();
  return useQuery(trpc.shows.listStates.queryOptions(undefined, { refetchInterval: 15_000, staleTime: 10_000 }));
}

// The current PocketBase metadata for one show (what a platform sync would push).
export function useShow(id: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.shows.get.queryOptions({ id }, { enabled, staleTime: 10_000 }));
}

// Re-sync a published show's metadata/cover from PocketBase to selected platforms.
export function useSyncPlatforms() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation(
    trpc.shows.syncPlatforms.mutationOptions({
      // A successful sync stamps platform_syncs — refresh the "last synced"
      // line the panel shows.
      onSuccess: () => qc.invalidateQueries(trpc.shows.syncTimes.pathFilter()),
    })
  );
}

// When each platform last accepted a metadata sync for this show.
export function useSyncTimes(showId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.shows.syncTimes.queryOptions({ id: showId }, { enabled, staleTime: 30_000 }));
}

// Save the upload-page edits (title/description/tags) straight to the PocketBase
// archive record, so they persist before the upload finishes. Invalidates shows
// so the (re-seeded) form + archive reflect the saved values.
export function useSaveShowMetadata() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation(
    trpc.shows.saveMetadata.mutationOptions({ onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()) })
  );
}

export function useStagedShowIds() {
  const trpc = useTRPC();
  return useQuery(trpc.uploads.getStagedShowIds.queryOptions(undefined, { refetchInterval: 15_000 }));
}

// In-progress multipart uploads (any browser) with a server-computed % per show,
// so this machine can show "uploading elsewhere · N%". Polls briskly since it
// reflects live activity.
export function useUploadingProgress() {
  const trpc = useTRPC();
  return useQuery(trpc.uploads.getUploadingProgress.queryOptions(undefined, { refetchInterval: 8_000 }));
}

export function useStaged(showId: string | undefined) {
  const trpc = useTRPC();
  return useQuery(
    trpc.uploads.getStaged.queryOptions({ showId: showId ?? '' }, { enabled: !!showId, refetchInterval: 10_000 })
  );
}

export function useAuthCheck(enabled: boolean) {
  return useQuery({ queryKey: ['auth-me'], queryFn: api.checkAuth, enabled, retry: false });
}

export function useGeneratedMeta(
  title: string | undefined,
  description: string | undefined,
  genres: string[] | undefined
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.shows.generateMeta.queryOptions(
      { title: title ?? '', description: description ?? '', genres: genres ?? [] },
      { enabled: !!title, retry: false, staleTime: Infinity }
    )
  );
}

export function usePendingVideos() {
  const trpc = useTRPC();
  return useQuery(trpc.watcher.pending.queryOptions(undefined, { refetchInterval: 15_000 }));
}

export function useUploads() {
  const trpc = useTRPC();
  return useQuery(
    trpc.uploads.list.queryOptions(undefined, {
      // Poll only while something is actually moving. The interval exists for
      // the history page's live progress bars; the archive page shows finished
      // shows, so left unconditional it re-fetched every 10s forever for rows
      // that had not changed in weeks.
      refetchInterval: (q) =>
        q.state.data?.some((u) =>
          u.jobs.some((j) => j.status === 'queued' || j.status === 'processing')
        )
          ? 10_000
          : false,
    })
  );
}

// Mutations -----------------------------------------------------------------

export function useCreateUpload() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation(
    trpc.uploads.create.mutationOptions({ onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()) })
  );
}

// Keeps the `retry.mutate(platform)` call-site shape; the uploadId is bound here.
export function useRetryJob(uploadId: string) {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (platform: 'youtube' | 'mixcloud' | 'archive') =>
      trpcClient.uploads.retryJob.mutate({ uploadId, platform }),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Takes the agenda record id, not an upload id — publishing only writes to
// PocketBase, so it must keep working for an archived show with no job row.
export function usePublishRecord() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (showId: string) => trpcClient.uploads.publishRecord.mutate({ showId }),
    onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()),
  });
}

export function useGenerateAudio() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (uploadId: string) => trpcClient.uploads.generateAudio.mutate({ uploadId }),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Whether the source recording is really on S3 for an upload (HEAD, not a DB
// guess). Long staleTime: the answer only changes when a file is uploaded or
// the archive job rewrites it, so it shouldn't ride the uploads poll.
export function useVideoInfo(uploadId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.uploads.videoInfo.queryOptions({ uploadId }, { staleTime: 5 * 60_000 }));
}

// Disk + bucket figures for the storage page. The bucket side lists every
// object, so this refetches on a slow timer rather than riding the uploads poll.
export function useStorageOverview() {
  const trpc = useTRPC();
  return useQuery(
    trpc.storage.overview.queryOptions(undefined, { refetchInterval: 30_000, staleTime: 15_000 })
  );
}

// One level of the bucket. Keyed by prefix, so stepping back is instant.
export function useBrowseStorage(prefix: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.storage.browse.queryOptions({ prefix }, { staleTime: 30_000, enabled }));
}

/**
 * A download URL for one object, keyed by that object.
 *
 * The key is what makes this safe to feed a <video src>: the same object always
 * resolves to the same cached URL, so a refetch elsewhere cannot swap the source
 * out from under a playing element. staleTime keeps it that way for the session;
 * the signature itself is good for hours.
 */
export function useSignedUrl(objectKey: string | null, enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.storage.signObject.queryOptions(
      { key: objectKey ?? '' },
      { enabled: enabled && !!objectKey, staleTime: 60 * 60_000, gcTime: 60 * 60_000 }
    )
  );
}

/** Imperative sign for click handlers, sharing the cache above. */
export function useSignObjectOnDemand() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return (key: string) =>
    qc.fetchQuery({ ...trpc.storage.signObject.queryOptions({ key }), staleTime: 60 * 60_000 });
}

// Deletes one bucket object. The server refuses anything the app still
// references — this can only ever remove a true orphan — so the button needs
// no destructive-action framing beyond the usual "are you sure".
export function useDeleteObject() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    ...trpc.storage.deleteObject.mutationOptions(),
    onSuccess: () => qc.invalidateQueries(trpc.storage.pathFilter()),
  });
}

// What the storage-layout migration would move. Read-only — nothing is touched
// until runMigration is called.
export function useMigrationPlan() {
  const trpc = useTRPC();
  return useQuery(trpc.storage.migrationPlan.queryOptions(undefined, { staleTime: 30_000 }));
}

export function useRunMigration() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    ...trpc.storage.runMigration.mutationOptions(),
    // Keys moved, so every cached view of them is stale.
    onSuccess: () => qc.invalidateQueries(),
  });
}

// Preview remux for a not-yet-published recording. Enabled only once the caller
// opens the preview, so simply having a video on the form costs no polling.
// Polls while the remux runs and stops as soon as it settles.
export function usePreviewStatus(videoS3Key: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.uploads.previewStatus.queryOptions(
      { videoS3Key },
      {
        enabled: enabled && !!videoS3Key,
        refetchInterval: (q) => (q.state.data?.state === 'working' ? 2000 : false),
      }
    )
  );
}

export function useStartPreview() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    ...trpc.uploads.startPreview.mutationOptions(),
    // The remux repoints the pending/staged row to the new .mp4 key, so the
    // form's video has to be re-read rather than kept from before the convert.
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Puts the agenda record back to draft — the inverse of usePublishRecord. The
// platform uploads and their links are untouched.
export function useUnpublishRecord() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (showId: string) => trpcClient.uploads.unpublishRecord.mutate({ showId }),
    onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()),
  });
}

// Every archive record PocketBase holds a cs-archive-* link for — the archive
// page's source of truth. Independent of jobs by design: deleting a finished
// job must not take its recording off the archive.
export function useListArchivedShows() {
  const trpc = useTRPC();
  return useQuery(trpc.shows.listArchived.queryOptions(undefined, { staleTime: 30_000 }));
}

// Removes the upload and its jobs from the queue. Files on S3 and the
// PocketBase record stay put.
export function useDeleteUpload() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (uploadId: string) => trpcClient.uploads.deleteUpload.mutate({ uploadId }),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Posts an archived recording to one platform it isn't on yet, straight from
// the shows/ artefacts — no re-upload, no re-processing. The server refuses a
// platform the record already links (same guard as a normal publish).
export function usePublishToPlatform() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (input: { showId: string; platform: 'youtube' | 'mixcloud' }) =>
      trpcClient.uploads.publishToPlatform.mutate(input),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Re-encodes an already-archived show's video to shrink it — lossy, replaces
// the original on S3 in place. Manual and per-recording: never auto-triggered,
// unlike the other platform jobs. Safe to re-run (creating a new/reset job row
// each time), so the same button works on any future outlier.
export function useCompressVideo() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    // Keyed by the show: the server creates its own bookkeeping row when none
    // exists, so the button never depends on one being there already.
    mutationFn: (showId: string) => trpcClient.uploads.compressArchiveVideo.mutate({ showId }),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// One-shot backfill: re-runs the archive job on every upload still stored in
// its original container, converting them to browser-playable MP4.
export function useRemuxBackfill() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: () => trpcClient.uploads.remuxBackfill.mutate(),
    onSuccess: () => qc.invalidateQueries(trpc.uploads.pathFilter()),
  });
}

// Cover image lives in the PocketBase record; changing it invalidates shows so
// every view (form, archive) reflects the new master cover.
export function useUploadCover(showId: string | undefined) {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (file: File) => api.uploadCover(showId!, file),
    onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()),
  });
}

export function useClearCover(showId: string | undefined) {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: () => api.clearCover(showId!),
    onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()),
  });
}

// Managing an already-published platform link, over tRPC. update/set-public
// return { error } (a message on failure). remove un-links from the archive
// record → refetch shows.
export function usePlatformUpdate() {
  const trpc = useTRPC();
  return useMutation(trpc.platform.update.mutationOptions());
}

// Real YouTube privacy status for a published video, so the UI can hide "set
// public" once it's actually public (enabled only for YouTube links).
export function useYoutubeStatus(url: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.platform.youtubeStatus.queryOptions({ url }, { enabled, staleTime: 30_000, retry: false }));
}

export function usePlatformSetPublic() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation(
    trpc.platform.setPublic.mutationOptions({ onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()) })
  );
}

export function usePlatformRemove() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation(
    trpc.platform.removeLink.mutationOptions({ onSuccess: () => qc.invalidateQueries(trpc.shows.pathFilter()) })
  );
}

export function useClaimPending() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return useMutation({
    mutationFn: (id: string) => trpcClient.watcher.claimPending.mutate({ id }),
    onSuccess: () => qc.invalidateQueries(trpc.watcher.pathFilter()),
  });
}
