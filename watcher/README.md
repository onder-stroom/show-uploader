# Recordings service (OBS PC)

Runs on the Windows OBS machine, next to (not inside) the OBS agent. It watches the OBS
recordings folder, prepares each finished recording (verified MP4 master, small H.264
preview, waveform peaks), cuts segments losslessly on request and uploads only those to
S3. It never talks to the api itself: the uploader's worker drives it over Tailscale.

## Install

1. Node 20 and `ffmpeg.exe` + `ffprobe.exe` (a full build with libx264) in `C:\show-uploader\tools`.
2. `pnpm install && pnpm --filter @show-uploader/watcher build`, copy `watcher/` (with `dist/` and `node_modules`) to `C:\show-uploader\watcher`.
3. Copy `.env.example` to `.env` and fill it in. Set `LISTEN_HOST` to the PC's Tailscale IP.
4. Install the service with WinSW (`show-uploader-recordings.xml` here): `show-uploader-recordings.exe install`, then `start`.
5. In the Tailscale admin, allow only the uploader host to reach port 8787 on this machine.

## Operate

- Logs: next to the WinSW exe. Status: the uploader's Recordings page.
- Updating: stop the service, replace `dist/`, start it.
- Deleting recordings by hand is fine at any time. The service forgets a recording once
  neither its MKV nor its MP4 master is left.
- Derived files live in `RECORDINGS_DIR\.show-uploader`. They are disposable.
- Retention: a recording is removed `RETENTION_DAYS` after its newest successful cut
  upload. A recording that was never cut is never removed automatically.
