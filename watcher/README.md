# Recordings service (OBS PC)

Runs on the Windows OBS machine, next to (not inside) the OBS agent. It watches the OBS
recordings folder, prepares each finished recording (verified MP4 master, small H.264
preview, waveform peaks), cuts segments losslessly on request and uploads only those to
S3. It never talks to the api itself: the uploader's worker drives it over Tailscale.

## Install

The PC needs only Node 20+ (24 is fine), `ffmpeg.exe` + `ffprobe.exe` (with libx264) and one file. Build that
file on your dev machine; no git, pnpm or build is needed on the PC.

1. On the dev machine: `pnpm install`, then `pnpm --filter @show-uploader/watcher bundle`. This writes
   `watcher/dist/recordings-service.js`: the whole service in one self-contained file (it is plain JavaScript
   with no native modules, so a file built on macOS runs on Windows).
2. Copy that one file to the PC into `C:\show-uploader\recordings\`.
3. In that folder create `.env` (start from `watcher/.env.example`). Set `RECORDINGS_DIR` to OBS's recording
   path, `AGENT_TOKEN` to a long random secret, `LISTEN_HOST` to the PC's Tailscale IP (`tailscale ip -4`), and
   `FFMPEG_PATH` / `FFPROBE_PATH` to the full paths of the executables (a service does not see a per-user PATH).
4. Test it in a PowerShell window first: `cd C:\show-uploader\recordings; node recordings-service.js`, then from
   another machine on the tailnet `curl -H "Authorization: Bearer <token>" http://<tailscale-ip>:8787/v1/health`.
   If it does not answer, allow the port for Tailscale addresses only (admin PowerShell):
   `New-NetFirewallRule -DisplayName "Show Uploader Recordings" -Direction Inbound -Protocol TCP -LocalPort 8787 -RemoteAddress 100.64.0.0/10 -Action Allow`.
5. To keep it running across logouts and reboots, install it as a Windows service with WinSW: put
   `WinSW-x64.exe` in `C:\show-uploader\service\` renamed to `show-uploader-recordings.exe`, copy
   `service/show-uploader-recordings.xml` next to it (check the `node.exe` path with `(Get-Command node).Source`),
   then in an admin PowerShell: `.\show-uploader-recordings.exe install`, then `.\show-uploader-recordings.exe start`.
6. In the Tailscale admin, allow only the uploader host to reach port 8787 on this machine.

## Operate

- Logs: next to the WinSW exe. Status: the uploader's Recordings page.
- Updating: build a new bundle (step 1), stop the service, replace `recordings-service.js` (keep `.env`), start the service.
- **Which build is running?** `GET /v1/health` reports `build` (the commit the bundle was built from, with
  `-dirty` if it had uncommitted changes, `dev` when run from source) and `protocol` (what the service can do).
  The Recordings page shows the build under its title, and warns when the protocol is older than the
  uploader expects. `pnpm --filter @show-uploader/watcher bundle` stamps the build.
- Segments the operator saves in the editor are kept in `draft.json` in the recording's own folder under
  `.show-uploader`, so they go away with the recording and survive a restart.
- Deleting recordings by hand is fine at any time. Delete the MKV and the service forgets the
  recording, including its MP4 master, preview and waveform, at the next scan (every
  `SCAN_INTERVAL_MS`, but a scan waits for a running prepare). The Recordings page has a
  **rescan** button (`POST /v1/rescan`) that looks at the folder at once. A recording whose cut
  or prepare is running is kept until that work ends.
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
