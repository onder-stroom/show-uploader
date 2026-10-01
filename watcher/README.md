# Recordings service (OBS PC)

Runs on the Windows OBS machine, next to (not inside) the OBS agent. It watches the OBS
recordings folder, prepares each finished recording (verified MP4 master, small H.264
preview, waveform peaks), cuts segments losslessly on request and uploads only those to
S3. It never talks to the api itself: the uploader's worker drives it over Tailscale.

## Install

1. Node 20 and `ffmpeg.exe` + `ffprobe.exe` (a full build with libx264) in `C:\show-uploader\tools`.
2. On the PC, in a checkout of this repo: `pnpm install`, `pnpm --filter @show-uploader/watcher build`, then
   `pnpm --filter @show-uploader/watcher deploy --legacy --prod C:\show-uploader\watcher`.
   Do not copy `watcher/` by hand: its `node_modules` holds links (the workspace's
   `@show-uploader/domain` and the `.pnpm` store) that a plain copy breaks. `deploy` writes a
   self-contained folder (`dist/`, `package.json`, real `node_modules` with `domain` included)
   and needs an empty target. `--legacy` is required on pnpm 10 (otherwise it refuses with
   `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`). Run it on the PC: the links it makes do not survive
   being zipped or copied across machines. Verified on macOS with pnpm 10.28: the deployed
   `node dist/index.js` started on its own and answered `/v1/health`.
3. Copy `.env.example` to `.env` and fill it in. Set `LISTEN_HOST` to the PC's Tailscale IP.
4. Install the service with WinSW (`service/show-uploader-recordings.xml`): `show-uploader-recordings.exe install`, then `start`.
5. In the Tailscale admin, allow only the uploader host to reach port 8787 on this machine.

## Operate

- Logs: next to the WinSW exe. Status: the uploader's Recordings page.
- Updating: stop the service, rename `C:\show-uploader\watcher` to `watcher.old`, build and `deploy`
  into a fresh `C:\show-uploader\watcher` (step 2; the target must be empty), copy `.env` over from
  `watcher.old`, start the service, then delete `watcher.old`.
- Deleting recordings by hand is fine at any time. The service forgets a recording once
  neither its MKV nor its MP4 master is left.
- While OBS is recording (`recordingActive`), cuts and part uploads pause and resume when it
  stops; the cut stays `cutting`/`uploading` meanwhile. Deleting a cut still works.
- Staging files (`<WORK_DIR>\cuts`, multi-GB) of a cut that was never dropped (drop failed, a
  restart) are swept at boot and every pass: a record and its MP4 after `RETENTION_DAYS`
  untouched, a stray MP4 without a record after an hour.
- Derived files live in `RECORDINGS_DIR\.show-uploader`. They are disposable.
- Retention: a recording is removed `RETENTION_DAYS` after its newest successful cut
  upload. A recording that was never cut is never removed automatically.
- A prepare (remux, preview, peaks) already running when OBS starts recording is not
  interrupted: it is single-flight and runs at below-normal priority. `GET /v1/health`
  reports `recordingActive`, refreshed only between passes, so it can lag.
- The service has no `error` handler on listen. A bad `LISTEN_HOST` (for example the
  Tailscale IP not up yet at boot) crashes it; WinSW restarts it after 10 s.
- Cuts are stream copy: the start is exact, the end runs a few frames long (within ~0.2 s).
- Only audio track 1 is used (`MIX_AUDIO_STREAM`, default stream 0).
- Leave optional values unset in `.env` rather than empty: an empty value fails validation.
