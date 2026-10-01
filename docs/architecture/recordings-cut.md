# Recordings cut — architecture

How one night's OBS recording becomes one archive upload per artist, and the rules the
code must keep. Design rationale: `docs/superpowers/specs/2026-10-01-recordings-cut-design.md`.

## The rule

> **The OBS PC's folder is the source of truth for recordings, and the operator may delete
> any file in it at any time. Nothing here stores recording state, and a missing file is
> never an error or an alert.** Video state still lives where
> `docs/architecture/video-lifecycle.md` puts it: the show record.

## The flow

1. **PC** (`watcher/`, a Windows service, not in Docker): watches the OBS recordings
   folder. A file whose mtime has stopped moving is finished. While any file is still
   growing, no ffmpeg work starts. A finished recording gets a verified MP4 master (video
   plus audio track 1 only, HEVC tagged `hvc1`), a small H.264 preview and waveform peaks.
2. **Operator** (`/recordings`): marks one segment per artist on the timeline and picks the
   show for each. Agenda times only *suggest*: they are draft markers, never trusted.
   The editor is the Coming Soon Clipper's trim editor, ported (`ui/src/components/TrimBar.tsx`,
   `WaveformPath.tsx`, `ui/src/upload/clipRange.ts`): zoom, in/out handles, playhead scrub,
   an SVG waveform path. One segment is selected and editable at a time; the others show as
   faint blocks on the bar.
3. **api** `recordings.startCuts` (`api/src/usecases/recording-cuts.ts`): validates (domain
   rules), checks every show exists and that the `ref` is in the PC's own list, and
   enqueues one `cut-recording` job per segment. The job id is a hash of
   (ref, show, in, out), so a double confirm is one job.
4. **worker** `cut-recording` (`worker/src/jobs/cut-recording.ts`): asks the PC to cut
   (`ffmpeg -c copy`, start exact via an MP4 edit list), learns the real size, asks the api
   to open a multipart session bound to the show, hands the PC the presigned part URLs
   (16 MiB parts, `PART_SIZE` in `api/src/usecases/uploads.ts`), waits, then asks the api
   to complete. Queue `recording-cuts`, one job at a time (concurrency 1). Three attempts,
   exponential backoff from 30 s.
5. **api** completion (`POST /api/internal/recordings/sessions/:sessionId/complete`) runs the
   same `completeUpload` use case the browser's multipart route uses: it finishes the S3
   object and writes `staged_uploads[show]` atomically.
   The worker-only internal routes (Bearer `WATCHER_API_KEY`, mounted at
   `/api/internal/recordings`) are `POST /cuts/:cutId/session` (open), `POST
   /sessions/:sessionId/complete` and `POST /sessions/:sessionId/abort`. The browser-facing
   preview is the separate `GET /api/recordings/preview/:ref?t=<token>`.
6. From there it is an ordinary staged recording: publish, then the archive job (loudness,
   remux, m4a), then the platforms. The archive job is unchanged.

## Who owns what

| Piece | Owns | Never |
|---|---|---|
| PC service | files, ffmpeg, uploading parts | holds credentials for the api, S3 or PocketBase; calls out on its own |
| worker job | sequencing and waiting | decides anything about shows; writes video state itself |
| api | sessions, completion, staged video, validation | trusts a caller-supplied `ref` (it must come from the PC's own list) |
| `packages/domain` | segment rules (`recording-segments.ts`), the agent protocol types (`recordings-contract.ts`) | I/O |

## Rules that must hold

- Only audio track 1 (the mix) is ever cut or remuxed (`MIX_AUDIO_STREAM`, default stream
  0). OBS records tracks 1, 3, 4; without an explicit `-map` ffmpeg would pick one silently.
- Cuts are stream copy. The **start is exact** (edit list); the **end runs a few frames
  long**, within about 0.2 s: measured 4.0 s requested -> 4.12 s, and in e2e 30 s ->
  30.16 s and 32 s -> 32.14 s (tolerance 0.3 s). `watcher/test/ffmpeg.test.ts` and
  `pnpm e2e` pin this. If a change breaks them, fix the cut, never the assertion.
- Retries resume. The PC keeps a finished cut and the ETags of parts that landed; the api
  hands back the same session for the same cut. Only the final attempt (or a deleted
  recording) aborts the session and drops the PC's staged cut.
- Redoing a cut that already completed is a no-op by design: the worker finds the api
  session completed and only cleans up on the PC. The cut is deterministic, so the bytes
  would be identical. To force a re-upload, change the in or out point by 0.1 s (a new cut
  id).
- The preview route (`GET /api/recordings/preview/:ref?t=...`) is authenticated by a
  short-lived signed token (a JWT signed with `jose`, keyed by `RECORDINGS_AGENT_TOKEN`)
  in the query, because a `<video>` cannot send a header. The signed path comes from a
  query keyed by recording, so the `<video src>` never swaps while it plays.
- Retention (PC): a recording is removed `RETENTION_DAYS` (default 14) after its newest
  successful cut upload. Never for a recording that was not cut.
- A manual OBS file split just produces more recordings; each is handled on its own.

## Operating it

- **Tailscale** runs on the OBS PC and on the Komodo host. Containers reach the PC's
  Tailscale IP through the host (Docker NATs outbound traffic), so the stack needs no
  sidecar. Allow only the Komodo host to reach TCP 8787 on the PC in the Tailscale ACL. If
  a container cannot reach the PC, add a Tailscale container to `docker-compose.prod.yml`
  and route `RECORDINGS_AGENT_URL` through it; do not widen the PC's listen address.
- Config: `RECORDINGS_AGENT_URL` and `RECORDINGS_AGENT_TOKEN` in the stack's `.env` (both
  api and worker read them via `env_file`). They must be unset to disable the feature, not
  empty: an empty string fails validation in both. Optional worker knobs `CUT_POLL_INTERVAL_MS`,
  `CUT_WAIT_MS`, `UPLOAD_WAIT_MS` are in `.env.example`.
- A prepare already running when OBS starts recording is not interrupted: the work is
  single-flight and runs at below-normal priority. `/v1/health` `recordingActive` is only
  refreshed between passes, so it can lag.
- The PC service has no `error` handler on listen. A bad `LISTEN_HOST` (for example the
  Tailscale IP not up yet at boot) crashes it, and WinSW restarts it after 10 s.
- Install and update the PC service per `watcher/README.md`.
- If the Recordings page says the PC is not reachable, check, in this order: the service is
  running, `curl -H "Authorization: Bearer <token>" http://<tailscale-ip>:8787/v1/health`
  from the Komodo host, the Tailscale ACL, `RECORDINGS_AGENT_URL`/`TOKEN` on the stack.
- The old drop-folder route (`POST /api/watcher/notify`, `pending_videos`) still exists but
  is legacy; recordings no longer arrive that way.
