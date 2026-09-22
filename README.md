# Show Uploader

Upload recorded DJ sets and live shows to YouTube and MixCloud simultaneously. Pick a show from your agenda, select a video file (or let the drop-folder watcher handle it), trim if needed, and publish — all in one click.

## What it does

- Pulls upcoming shows from your agenda API (title, description, tags)
- Generates platform-appropriate copy via Groq AI
- Archives first: trims, loudness-normalises, remuxes the recording to MP4 and extracts an AAC 256kbps (m4a) audio track, both stored in Minio under the show's folder
- Then uploads the archived video to **YouTube** and the archived audio to **MixCloud**
- Writes the YouTube, MixCloud and archive links back to the agenda (PocketBase)
- Windows drop-folder watcher: drag a recording to a local folder and it uploads to S3 automatically

---

## Architecture

```
Windows PC (OBS)
  └─ watcher script  ──upload──►  Minio S3 (in Docker)
                     ──notify──►  API

Cloud server (Docker Compose)
  ├─ api      (Express, port 3000) — REST + SSE + serves UI
  ├─ worker   (BullMQ) — ffmpeg, YouTube, MixCloud, archive jobs
  ├─ redis    — job queue
  └─ minio    — S3-compatible storage (ports 9000, 9001)

External
  ├─ Neon     — managed Postgres
  ├─ Groq     — AI copy generation
  ├─ YouTube  — OAuth2 upload
  └─ MixCloud — OAuth2 upload
```

---

## Prerequisites

- Docker + Docker Compose (on the cloud server)
- Node.js 20+ and pnpm (on the Windows machine, for the watcher)
- A [Neon](https://neon.tech) Postgres database
- A [Groq](https://console.groq.com) API key (free tier)
- YouTube Data API v3 credentials
- MixCloud app credentials

---

## Cloud server setup

### 1. Clone the repo

```bash
git clone https://github.com/onder-stroom/show-uploader.git
cd show-uploader
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — every variable is documented inline. At minimum fill in:

| Variable | Description |
|---|---|
| `DATABASE_URI` | Neon connection string |
| `SHOWS_API_URL` | Your agenda API base URL |
| `SHOWS_API_KEY` | Bearer token for the agenda API |
| `S3_ACCESS_KEY` | Minio root user (min 3 chars) |
| `S3_SECRET_KEY` | Minio root password (min 8 chars) |
| `S3_BUCKET` | `show-uploader` (or whatever you prefer) |
| `GROQ_API_KEY` | Groq API key |
| `YOUTUBE_CLIENT_ID` | See YouTube setup below |
| `YOUTUBE_CLIENT_SECRET` | See YouTube setup below |
| `YOUTUBE_REFRESH_TOKEN` | See YouTube setup below |
| `MIXCLOUD_ACCESS_TOKEN` | See MixCloud setup below |
| `WATCHER_API_KEY` | Random secret — paste same value into watcher `.env` |
| `UI_USERNAME` | HTTP Basic Auth username for the web UI |
| `UI_PASSWORD` | HTTP Basic Auth password for the web UI |

### 3. Run database migrations

```bash
# From the repo root — run once on first deploy, re-run safely after updates
psql "$DATABASE_URI" -f api/src/db/migrations/001_initial.sql
psql "$DATABASE_URI" -f api/src/db/migrations/002_pending_videos_and_trim.sql
```

### 4. Start the stack

```bash
docker compose up -d
```

On first run `minio-init` creates the bucket and folder structure (`uploads/`, `archive/`, `jingles/`, `images/`) and exits. Check with:

```bash
docker compose logs minio-init
```

### 5. Expose the app

Put a reverse proxy (Nginx, Caddy, Traefik) in front of port 3000. Example Caddy config:

```
your-domain.com {
  reverse_proxy localhost:3000
}
```

Minio S3 API (port 9000) should also be publicly accessible for the Windows watcher to upload files directly. Keep the Minio console (port 9001) private or firewall it.

### 6. Updating

```bash
git pull
docker compose build
docker compose up -d
# run any new migration files
```

### Production deploys

Production runs as the Komodo stack `show-uploader`, built from `docker-compose.prod.yml` on the `master` branch of [onder-stroom/show-uploader](https://github.com/onder-stroom/show-uploader). Every push to `master` triggers the **Deploy to Komodo** GitHub Action (`.github/workflows/deploy.yml`), which asks Komodo to redeploy and waits for the result. It needs the `KOMODO_URL`, `KOMODO_API_KEY` and `KOMODO_API_SECRET` repo secrets.

Komodo's own git webhook is switched off on the stack (it skipped merges silently), so the Action is the only automatic deploy path. After a push, confirm that Komodo's deployed commit matches `master` rather than assuming it shipped.

---

## YouTube OAuth2 setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable **YouTube Data API v3**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download the JSON — note the `client_id` and `client_secret`
7. Run the one-time OAuth flow to get a refresh token:

```bash
# Install the Google auth library temporarily
npx --yes google-auth-library-nodejs-token-cli \
  --client-id YOUR_CLIENT_ID \
  --client-secret YOUR_CLIENT_SECRET \
  --scope https://www.googleapis.com/auth/youtube.upload
```

Follow the browser prompt. Paste the resulting `refresh_token` into `.env`.

> Alternatively use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) — select the YouTube Upload scope, exchange the auth code, and copy the refresh token.

---

## MixCloud OAuth2 setup

1. Go to [mixcloud.com/developers](https://www.mixcloud.com/developers/) and create an app
2. Note the **Client ID** and **Client Secret**
3. Perform the OAuth2 Authorization Code flow once to get an access token:

```
https://www.mixcloud.com/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code
```

4. Exchange the code:

```bash
curl "https://www.mixcloud.com/oauth/access_token" \
  -d "client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&client_secret=CLIENT_SECRET&code=CODE"
```

5. Paste the `access_token` into `.env` as `MIXCLOUD_ACCESS_TOKEN`

> MixCloud access tokens do not expire in the traditional sense, but if uploads start failing re-run this flow.

---

## Jingle setup (optional)

A jingle is a short audio clip prepended to every MixCloud upload.

1. Open the Minio console at `http://your-server:9001` (login with `S3_ACCESS_KEY` / `S3_SECRET_KEY`)
2. Browse to the `show-uploader` bucket → `jingles/` folder
3. Upload your file (AAC/M4A recommended, e.g. `intro.m4a`)
4. Set in `.env`:

```
JINGLE_S3_KEY=jingles/intro.m4a
```

Restart the worker: `docker compose restart worker`

---

## Windows drop-folder watcher

The watcher is a standalone Node.js script that runs on your Windows machine (where OBS saves recordings). It watches a local folder and automatically uploads new files to Minio.

### Setup

```powershell
cd watcher
cp .env.example .env
```

Edit `watcher/.env`:

```env
WATCH_FOLDER=C:\Users\you\obs-drop
S3_ENDPOINT=https://minio.your-domain.com   # public Minio URL (port 9000)
S3_ACCESS_KEY=your-minio-root-user
S3_SECRET_KEY=your-minio-root-password
S3_BUCKET=show-uploader
API_URL=https://your-show-uploader.example.com
API_KEY=same-value-as-WATCHER_API_KEY-in-cloud-env
```

### Run

```powershell
pnpm install
pnpm run dev
```

To run at Windows startup, create a scheduled task that runs:
```
node C:\path\to\show-uploader\watcher\dist\index.js
```

### How it works

1. New file appears in the watch folder → watcher waits until the file size is stable for 20 seconds (so OBS has finished writing)
2. Uploads to Minio under `uploads/{timestamp}-{filename}`
3. POSTs to `/api/watcher/notify` — the cloud API records it in the database
4. In the web UI, the file appears at the top of the **New Upload** page under "Videos from drop folder"
5. Click the file to select it, fill in metadata, publish

---

## Using the web UI

Open `https://your-domain.com` in your browser. You'll be redirected to Zitadel to log in. If your account hasn't been granted the `member` (or `admin`) role yet, you'll see an "Access pending approval" screen.

### New Upload

1. **Videos from drop folder** (top of page) — click a file to use it. Or use the file dropzone below to upload manually.
2. **Pick a show** — select from your upcoming agenda. Title, description, and tags are pre-filled and AI-refined.
3. **Edit metadata** — adjust title, description, tags, and cover image URL as needed.
4. **Trim** (optional) — enter Start and/or End times in `HH:MM:SS` format to cut the beginning or end. Applied to all outputs (YouTube, MixCloud, archive).
5. **Platforms** — toggle YouTube / MixCloud. The jingle toggle appears when a jingle is configured.
6. Click **Publish**.

You're redirected to the History page where you can watch per-platform progress bars update in real time.

### History

Shows all uploads with live progress. Each platform shows its status and, once done, a link to the result URL.

---

## Testing

```bash
pnpm --filter @show-uploader/api test   # unit tests (same for worker, ui, domain)
pnpm e2e                                # end-to-end against the built output
```

`pnpm e2e` starts a throwaway MinIO, Postgres and Redis in docker (on ports that
can't collide with a running `docker compose up`), builds the api and worker, and
runs a real recording through the whole pipeline: preview, publish, archive,
both platform uploads, retry, metadata edit and shrink. YouTube and MixCloud are
simulated and PocketBase is a stub, so nothing is ever published and no agenda
record is touched. It needs docker and ffmpeg, and takes a couple of minutes.
Details in `scripts/e2e/README.md`.

---

## Working on the UI

The interface is [MUI](https://mui.com) themed to `DESIGN.md` — square corners, monospace, no shadows. Colours, spacing and component defaults all live in `ui/src/theme.ts`; change them there rather than at the call site, and anything that starts looking like stock Material is a gap in that file.

### Offline preview

```bash
pnpm dev:ui
# then open http://localhost:5173/?mock=1
```

`?mock=1` swaps the backend for fixtures in `ui/src/dev/` — no API, no database, no login, and **no chance of a click reaching production data**. Use it to check layout at real viewport sizes (resize the window, or use the browser's device toolbar); every page works, including a mid-flight upload, a failed job, a missing source file and a published show.

The mock is behind `import.meta.env.DEV` and a dynamic import, so none of it ships in a production build.

---

## Authentication

| Route | Auth |
|---|---|
| Web UI + all `/api/*` routes | Zitadel OIDC — valid JWT with the `member` or `admin` project role |
| `POST /api/watcher/notify` | Bearer token (`WATCHER_API_KEY`) — unaffected by Zitadel |

Users who sign up via Zitadel but hold neither role see "Access pending approval" and cannot use the app. To grant access: Zitadel console → Projects → Team → Users → find the user → assign role `member` (or `admin`). Other roles on the project, like `website-admin`, don't grant access here.

Zitadel keeps **one grant per user per project**. If the user already has a grant on Team, don't click **New** — that fails with `User grant already exists`. Open the existing grant and tick the extra role there. The user has to sign out and back in afterwards: roles are baked into the token at sign-in.

UI env vars — set in `ui/.env` (not committed to git):

```
VITE_ZITADEL_DOMAIN=your-org.eu1.zitadel.cloud
VITE_ZITADEL_CLIENT_ID=your-client-id
```

The `ZITADEL_DOMAIN` and `ZITADEL_CLIENT_ID` variables (without `VITE_` prefix) are also required in the root `.env` for the API server.

### Session length — required Zitadel console setup

The UI requests the `offline_access` scope so it can renew the session in the background instead of
bouncing you through the login screen. **Zitadel ignores that scope silently — no error, no refresh
token — unless the app is configured for it.** In the Zitadel console, on the app:

| Setting | Value | Why |
|---|---|---|
| Grant Types → **Refresh Token** | enabled | Without it, no refresh token is issued and the session dies with the access token. |
| Token Settings → **Refresh Token Idle Expiration** | `30 days` | How long you can stay away and still come back signed in. |
| Token Settings → **Refresh Token Expiration** | `90 days` | Hard cap; a full login is required after this regardless of activity. |
| Redirect URIs | add `<origin>/silent-renew` | Target of the hidden renewal iframe, used whenever no refresh token is available. Add it for production *and* `http://localhost:5173`. |
| Auth Token Type | **JWT** | The API verifies tokens locally against JWKS. Opaque tokens would fail every request. |

To check it is working: sign in, then in DevTools → Application → Local Storage look for
`oidc.user:https://<domain>:<client-id>`. If that entry has no `refresh_token`, the Refresh Token
grant is still off.

Note the tradeoff: the session is kept in `localStorage` (it has to survive closing the browser), so
the refresh token is readable by any script running on the app's origin.

---

## Archive quality

Control the output bitrates for the archived MP4:

```env
ARCHIVE_VIDEO_BITRATE=4000k   # video bitrate
ARCHIVE_AUDIO_BITRATE=256k    # audio bitrate
```

The raw MKV is deleted from S3 after the archive job succeeds. The MP4 is stored under `archive/` in Minio.

---

## Troubleshooting

**Worker not processing jobs**
```bash
docker compose logs worker -f
```

**Minio bucket missing**
```bash
docker compose run --rm minio-init
```

**YouTube upload fails with "invalid_grant"**
Re-run the OAuth flow to get a fresh refresh token.

**MixCloud upload fails**
Check that `MIXCLOUD_ACCESS_TOKEN` is set and not expired. Re-run the OAuth flow if needed.

**Watcher not picking up files**
Make sure `WATCH_FOLDER` exists and the path uses backslashes (Windows). Check `API_URL` is reachable from the Windows machine.
