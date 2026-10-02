# Cut Recordings Into Per-Artist Uploads — Design

**Date:** 2026-10-01
**Status:** Draft, awaiting review

## Problem

OBS records a whole night on the Windows OBS PC as one MKV, with several artists in
sequence. The archive needs one upload per artist, each bound to that artist's agenda
show. Today the operator would have to cut the recording by hand and upload the pieces.
The existing `watcher/` was meant to bridge the PC and the uploader, but it was never
deployed, uploads each file whole in a single `PutObjectCommand` (S3's single-PUT limit
is 5 GB), and has no retry or resume.

## What we are building

An operator opens a recording from the OBS PC in the uploader, marks one segment per
artist on a timeline, matches each segment to a show, and confirms. Each segment is cut
losslessly on the PC, uploaded to S3 as that show's recording, and from there goes
through the normal publish pipeline. Only the segments cross the uplink.

## Decisions

| Question | Decision |
|---|---|
| Cut purpose | Split one recording into per-artist uploads. Social clips stay in the Coming Soon Clipper and are unchanged. |
| Link to the PC | Tailscale (already running on the PC). Public tunnel rejected. |
| Who connects to the PC | The uploader only. Browsers never reach the PC, and the PC holds no credentials for the api. |
| Where cuts run | On the PC, then upload only the segments. |
| PC-side home | `watcher/` in this repo, evolved into the recordings service. The OBS agent is **not** touched: recording must never share a process with media work. |
| Cut method | `ffmpeg -c copy` into MP4 with an exact start (same technique as the clipper's `videoClip.ts`). No re-encode. |
| Audio | OBS records AAC on tracks 1, 3 and 4. **Track 1 is the mix**; cuts map it explicitly. The other tracks stay in the MKV. |
| Video | OBS records AMD HW HEVC. Cuts are tagged `hvc1`. The editor plays an H.264 preview, never the full-quality file. |
| Agenda times | Draft markers only. They pre-fill suggested cuts and matches, and are never trusted. The operator confirms every segment. |
| Show matching | Auto-suggest by time overlap, operator confirms or reassigns. |
| Deleting recordings | The operator may delete the MKV or MP4 at any time. Nothing treats that as an error. |

## Architecture

```
Browser ──tRPC──▶ api ──enqueue──▶ worker (cut-recording job)
                   │                  │
                   │                  ├──HTTP over Tailscale──▶ recordings service (OBS PC)
                   │◀──internal key───┤                          list · preview · cut · upload
                   │                  │
              multipart_uploads    S3 ◀──presigned part URLs── (PC uploads parts directly)
              staged_uploads
```

Ownership follows the existing ports-and-adapters split.

### packages/domain (pure)

- `recording-segments.ts`: segment validation (start < end, within duration, no
  overlap, minimum length) and `suggestMatches(segments, agendaSlots)` (time overlap;
  returns suggestions, never decisions).
- `recordings-contract.ts`: the types for the agent protocol below, shared by the api,
  the worker and the PC service so the three cannot drift.

### PC recordings service (`watcher/`, replaces the current watcher)

Owns files, ffmpeg and the upload of parts. Nothing else.

- Watches the recordings folder (config, not OBS events). A file is *ready* once its
  size has not changed for the stable window.
- Prepares each ready file: remux to MP4 with faststart (mapping video and track 1),
  verify with ffprobe (duration within one frame, stream count), then make the H.264
  preview and waveform peaks. Preparation runs at below-normal priority and only while
  OBS is not recording; otherwise it queues.
- Keeps derived files and progress in a sidecar next to each recording. Sidecars and
  derived files are disposable and regenerated on demand.
- Serves a bearer-token HTTP API bound to the Tailscale interface only (see Contract).
- Prunes recordings per the retention rule below. "Already gone" is success.
- The MKV or MP4 can be deleted by hand at any moment. The source for a cut is the MP4
  if present, else the MKV (remuxed on demand), else the cut fails as `source_gone`.

#### Packaging and runtime

- **Node 20 + TypeScript**, the same stack as the current `watcher/`, so it shares
  `packages/domain` (segment rules, contract types) with the api and worker. Not Tauri
  or Electron: the service has no UI, and a Rust rewrite would lose the shared package.
- **Runs as a Windows service** under a wrapper (WinSW or NSSM): starts at boot,
  restarts on crash, logs to a file. Status is visible from the uploader's Recordings
  page (reachable, ready count, preparing), so no tray icon is needed.
- **Bundles `ffmpeg.exe` and `ffprobe.exe`** next to the service. Their path comes from
  config, not `PATH`.
- **Config** from env or a config file: recordings folder, token, listen address (the
  Tailscale IP), stable window, retention days.
- **Updates are manual at first** (replace the folder, restart the service). A
  self-update step can come later without changing this design.
- **Independence from the OBS agent:** separate process, install and failure domain.
  If this service crashes or hogs the CPU, recording is unaffected.

### api

- **Port** `RecordingsAgent` in `api/src/ports.ts`: list recordings and open a preview
  or peaks stream (proxied, see REST below). It never signs or stores anything. The real
  adapter in `adapters.ts` talks HTTP to the PC and is built once in `deps.ts`.
- **Use cases** in `api/src/usecases/recordings.ts` (existing file; extend):
  - `listRecordings` maps the agent's list and reports `unreachable` as a normal state.
  - `startCuts(segments)`: validates with the domain rules, checks each show exists
    and is not locked by a claim (existing rules), and enqueues one `cut-recording`
    job per segment with a deterministic job id (`cutId`) so a double confirm enqueues
    once. Throws `UseCaseError` (`NOT_FOUND`, `CONFLICT`, `PRECONDITION_FAILED`).
  - `completeUpload(sessionId)`: **extracted from `routes/multipart.ts`** so the
    browser route and the worker's internal call share one copy of the rule
    (complete the S3 object and upsert `staged_uploads[show_id]` atomically).
- **Router** `trpc/routers/recordings.ts`: thin; validates input, calls the use case,
  maps `UseCaseError`.
- **REST** (streaming, which tRPC cannot do): `GET /api/recordings/preview/:ref` proxies
  the agent's preview with Range support. A `<video>` element cannot send an
  `Authorization` header, so the route is authenticated by a short-lived signed token
  (a JWT signed with `jose`, already an api dependency) in the query (`t`), not by `requireAuth`.
  The token is issued by the tRPC
  query `recordings.signPreview({ref})`, keyed by recording like `storage.signObject`, so
  it is fetched once per viewing session and the `<video src>` never swaps. Waveform peaks
  are a plain tRPC query, `recordings.peaks({ref})`.
- **Internal endpoints** under the existing key-gated pattern the worker already uses
  for PocketBase write-back: open a multipart session bound to a show (size known),
  complete it (calls `completeUpload`), abort it.
- **Config**: `RECORDINGS_AGENT_URL` (Tailscale name) and `RECORDINGS_AGENT_TOKEN`,
  documented in `.env.example`.

### worker

`worker/src/jobs/cut-recording.ts`, taking `deps` like every job. New ports in
`worker/src/ports.ts`: `RecordingsAgent` (the PC) and `UploadSessions` (the api's
internal endpoints). Real adapters in `adapters.ts`, fakes in `test/fakes.ts`.

Steps, each idempotent on `cutId`:
1. Ask the PC to cut `[start, end]` of `ref`; poll until `cut`, learn `sizeBytes`.
2. Open a multipart session bound to the show via `UploadSessions`; get presigned part
   URLs.
3. Hand the part URLs to the PC; poll until it reports every part's ETag.
4. Complete via `UploadSessions` (which runs `completeUpload`).
5. Tell the PC to drop the cut's staging file.

On failure after step 2, abort the session. The archive job is **not** modified: its
input is already one artist's segment, and it runs first as before. Archive output
stays the single source of truth (no platform job re-trims anything).

### UI

New Recordings page in `ui/src/pages/`, using `ui/src/api/hooks.ts` and the theme
tokens only. Timeline with waveform from peaks, H.264 preview playback (key signed
via the proxy route, not polled), draggable segments, suggested cuts from agenda
times shown as dashed drafts, and a show picker per segment. Per the lifecycle rule,
nothing stores video state: a segment's status is *derived* from the cut job, the
multipart session and `staged_uploads` through one pure `resolveSegment` function next
to `resolveVideo`, with unit tests. List pages use `usePaged` where paging is needed.

## Agent HTTP contract (v1)

All requests carry `Authorization: Bearer <token>`. Bound to the Tailscale interface.

| Method and path | Purpose |
|---|---|
| `GET /v1/recordings` | Ready recordings: `ref`, `filename`, `sizeBytes`, `mtime`, `durationS`, `state` (`preparing`, `ready`, `failed`). `ref` is opaque and stable once a file is ready. |
| `GET /v1/recordings/:ref/preview` | H.264 preview, Range supported. |
| `GET /v1/recordings/:ref/peaks` | Waveform peaks JSON. |
| `POST /v1/cuts` `{cutId, ref, startS, endS}` | Start a cut. Idempotent on `cutId`. |
| `GET /v1/cuts/:cutId` | `state`: `cutting`, `cut`, `uploading`, `done`, `failed`, `source_gone`; `sizeBytes`, `etags`, `reason`. |
| `POST /v1/cuts/:cutId/upload` `{partSize, parts:[{n,url}]}` | Upload the cut in parts to the presigned URLs. |
| `DELETE /v1/cuts/:cutId` | Drop staging. |

Parts of 16 MiB match the existing multipart `PART_SIZE`. A failed part retries with
backoff; a restart of the service resumes from the staged cut and the part list.

## Data

No new table. The lifecycle rule holds: the show record is the single source of truth.

- `multipart_uploads` (existing, already bound to `show_id`) gains nullable provenance
  columns: `source_ref`, `cut_id`, `cut_start_s`, `cut_end_s`. Audit and retry only. A
  partial unique index on `cut_id` (where the session is not aborted) gives one live
  session per cut, so a retried request reuses it instead of opening a second S3 upload.
- `staged_uploads[show_id]` is written by `completeUpload`, exactly as today.
- Failure states (`failed`, `source_gone`) are reported by the agent and the job and are
  derived in the UI, not stored.

## Retention

The PC prunes a recording once at least one segment cut from it has uploaded
successfully **and** the retention period (default 14 days, `RETENTION_DAYS`) has
passed since the most recent successful cut upload. The PC has no credentials for the
api, so it cannot observe archival; "uploaded plus a grace period" is the rule it can
enforce. A recording that was never cut is never pruned automatically. Pruning is an
optimisation, not a guarantee: the operator may delete earlier, and the system never
depends on a file still existing.

## Failure handling

| Case | Behaviour |
|---|---|
| PC offline or off the tailnet | Recordings page shows "OBS PC not reachable". Not an error. Existing uploads are unaffected. |
| Recording deleted before a cut runs | That segment ends `source_gone` with a plain message. Segments already uploaded are in S3 and untouched. |
| Upload interrupted | Part-level retry and resume; stale multipart parts aborted. A retry re-cuts if the file still exists. |
| Double confirm | One job per `cutId`. |
| Overlapping, empty or out-of-range segment | Refused by the domain rule before anything runs. |
| Show already has a staged video | The existing replace-on-new-upload rule applies; the UI warns before confirming. |

## Security

- Tailscale ACL limits the PC service to the api and worker hosts; the bearer token is a
  second factor, not the only one.
- The PC has no credentials for the api, S3 or PocketBase. It only receives presigned
  part URLs scoped to one object.
- The api checks that a `ref` came from the agent's own list before proxying or cutting.
- The Komodo host must be on the tailnet. This is a deployment prerequisite whose exact
  wiring (a Tailscale sidecar in `docker-compose.prod.yml` or host-level) is decided and
  tested in the implementation plan, because it cannot be verified from here.

## Testing

- **domain:** segment validation, overlap suggestion (including bad agenda times).
- **api:** use cases against `api/test/fakes.ts` (a fake `RecordingsAgent`), in the
  style of `api/test/usecases/`.
- **worker:** `cut-recording` with fake ports, including failure after the session opens.
- **PC service:** a tiny HEVC MKV fixture with three AAC tracks. Assert track 1 only,
  the `hvc1` tag, the exact start (via ffprobe on the output) and the end within one
  frame.
- **`pnpm e2e`:** extended with a stub agent, because unit tests pass while wiring is
  wrong and production cannot be tried safely.
- **Manual:** one real recording on the PC before this is trusted.

## Verification items before implementation

1. **Cut end accuracy.** The clipper's `-t` counts from the keyframe, so the end may
   fall short of the out-point by up to one GOP (2 s). Measure on a real file and fix
   the duration calculation if so.
2. **Edit list survives the archive job.** Confirm the archived MP4 still starts at the
   exact in-point after the archive job's remux.
3. **HEVC in the archive.** The archive keeps HEVC as-is. Check playback of archive
   pages in Chrome without HEVC hardware. Pre-existing, so out of scope unless it
   already fails.
4. **Tailscale reachability** from the Komodo host (see Security).

## Out of scope

- Removing `pending_videos` and the old `/api/watcher/notify` route. They stay until the
  new flow is proven.
- Social clips from raw recordings.
- Any change to the OBS agent.
- Auto-update for the PC service (manual install first).
- A tray icon or any UI on the PC.
