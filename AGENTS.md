# AGENTS.md

Show Uploader publishes recorded DJ sets / live shows from the coming soon agenda to
YouTube and MixCloud and keeps an archive copy. User-facing setup lives in `README.md`;
this file is the working brief for coding agents.

## Layout

pnpm workspace, Node 20, TypeScript everywhere.

| Path | What |
|---|---|
| `api/` | Express + tRPC, serves the UI build. Auth, PocketBase sync, S3 signing. |
| `worker/` | BullMQ jobs: ffmpeg, YouTube, MixCloud, archive. |
| `ui/` | React + Vite + MUI, themed per `DESIGN.md` via `ui/src/theme.ts`. |
| `watcher/` | Windows drop-folder watcher (runs on the OBS machine, not in Docker). |
| `packages/domain/` | Pure rules shared by api and worker: show slugs, S3 key layout, platform title/description formatting. |
| `docs/architecture/` | Design rules that code must keep, e.g. `video-lifecycle.md`. |
| `docs/superpowers/` | Historical specs and plans. Point-in-time; code wins where they disagree. |

## Architecture

Ports and adapters in both the worker and the api. Infrastructure sits behind
interfaces, the real ones are built once, and tests use in-memory fakes:

| | worker | api |
|---|---|---|
| Rules | `worker/src/jobs/` | `api/src/usecases/` |
| Ports (interfaces) | `worker/src/ports.ts` | `api/src/ports.ts` |
| Real adapters | `worker/src/adapters.ts` | `api/src/adapters.ts` |
| Built once in | `worker/src/index.ts` | `api/src/deps.ts` |
| Test fakes | `worker/test/fakes.ts` | `api/test/fakes.ts` |

- Jobs and use cases take a `deps` argument and never import `db`, the queue,
  `s3`, `shows-api`, a platform client or `env`. They may import pure code:
  `@show-uploader/domain`, `services/video-preview`, ffmpeg and the workspace (the
  last two are local tools, not ports; the worker's tests `vi.mock` them).
- Routers and REST routes are the driving side: they validate input, call a use
  case with `deps` and map its `UseCaseError`. Plain reads may still call a
  service directly.
- A new outside system gets a port and an adapter first. A pure rule both sides
  need goes in `packages/domain`.

**Publish pipeline.** The UI creates an upload bound to its show. The worker's
**archive job always runs first** (`worker/src/jobs/archive.ts`): one download, trim,
loudness pass, MP4 remux, m4a extraction, agenda links written to PB. Only then does
it enqueue the queued YouTube / MixCloud jobs, which are thin uploads of those
archived files. Don't add a platform job that re-downloads or re-trims the source.
Read `docs/architecture/video-lifecycle.md` before touching upload/video state.

**Where things live**

| Concern | Use |
|---|---|
| Auth (REST + tRPC) | `api/src/auth/verify-token.ts` |
| New API endpoints | tRPC routers in `api/src/trpc/routers/`. REST (`api/src/routes/`) only for what tRPC can't do: multipart upload, raw cover bytes, SSE, presence, `/api/public`, watcher. |
| Rules behind an endpoint | `api/src/usecases/` (publish, retry, archive actions, metadata edit, preview). Routers only validate input, call a use case and map its `UseCaseError` to a tRPC code. |
| PocketBase reads/writes | `api/src/services/shows-api.ts` (token cache, retries, genre mapping) |
| Postgres | `api/src/db/queries.ts` (takes `db` as a parameter) and `worker/src/db.ts` |
| S3 keys and folders | `@show-uploader/domain` (`storage-layout.ts`, `show-slug.ts`) |
| S3 access / signing | `api/src/services/s3.ts`, `worker/src/services/s3.ts`; UI signs through the `storage.signObject` query |
| ffmpeg / ffprobe | `worker/src/services/ffmpeg.ts` (trim, remux, loudness, `probeDuration`) |
| Per-job scratch dirs | `worker/src/services/workspace.ts` |
| Queues | `api/src/queue/index.ts` (producers), `worker/src/index.ts` (consumers, concurrency 1 on purpose) |
| UI data hooks | `ui/src/api/hooks.ts` (tRPC + React Query) |
| UI video/show status | `ui/src/upload/resolveVideo.ts`, `resolveShowStatus.ts`, the single derivation rules |
| Lists with search + paging | `usePaged` / `Pager` in `ui/src/components/Pager.tsx` (URL-backed; add `pagedSearch` to the route's `validateSearch`) |
| Formatting (size, duration, hashtags) | `ui/src/format.ts`; platform copy in `@show-uploader/domain` (`format.ts`) |
| Styling | `ui/src/theme.ts` tokens and component defaults, never per-call-site styles |

**Routers stay thin.** A procedure that does more than one call plus error handling
gets its logic moved into a `usecases/` function, which throws
`UseCaseError('NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED', message)` for a
refused rule, never a `TRPCError`. See `api/test/usecases/` for the test style.

**Reuse before you write.** Before adding a helper, hook, query, component or job,
search for an existing one (`grep` the concern, check the table above) and extend it.
A second copy of a rule is how this codebase has broken before: two token verifiers
caused a sign-in loop, and a component-level URL pin duplicated the query cache. If
something almost fits, generalise it, and keep every caller on the one version.

**Logic both the api and the worker need goes in `packages/domain`**, not in a copy on
each side. It holds pure functions only: no env, no I/O, no infrastructure clients.
The api and worker `build`/`dev`/`test` scripts build it first, and it's compiled to
`dist/`, so run it through those scripts (or `pnpm --filter @show-uploader/domain build`)
after changing it.

## Commands

```bash
pnpm dev                                   # api + worker + ui
pnpm dev:ui   # then http://localhost:5173/?mock=1 — fixtures, no backend, no login
pnpm --filter @show-uploader/api test      # vitest (same for worker, ui, domain)
pnpm --filter @show-uploader/api exec tsc --noEmit
pnpm e2e                                   # end-to-end, on the built output (docker + ffmpeg)
```

Run the tests and typecheck for every package you touch before committing.

**After a refactor of the jobs, the use cases or the adapters, run `pnpm e2e`.**
It builds both packages and runs them against a throwaway MinIO + Postgres +
Redis: real ffmpeg, real S3 and queue, platforms in dry-run, PocketBase stubbed.
Unit tests pass happily while the wiring is wrong, and production has no safe way
to try a job — no work runs for days, the dry-run flag is global, and there is no
exec into the running containers. See `scripts/e2e/README.md`.

## Deploying

- Repo: **github.com/onder-stroom/show-uploader** (moved from `koraysels/show-uploader`
  on 2026-09-22), branch `master`.
- Production = Komodo stack `show-uploader`, built from `docker-compose.prod.yml`.
- A push to `master` runs `.github/workflows/deploy.yml`, which redeploys the stack
  through the Komodo API and waits for the result. Komodo's own webhook is disabled on
  the stack; the Action is the only automatic path.
- Never assume a push shipped: compare Komodo's deployed commit to `master`
  (`gh run list -w "Deploy to Komodo"` plus the stack's deployed hash).

### Branching — `master` is production

**A push to `master` deploys, within about a minute. Treat pushing to it as
pressing the deploy button.**

- Work on a branch: `feat/<thing>`, `fix/<thing>`, `chore/<thing>`. Commit and
  push there as often as you like — nothing deploys.
- Open a PR into `master` (`gh pr create`). The Claude review workflow runs on it.
- Merge only when the change is meant to be live **and** someone is around to
  watch it: after `pnpm e2e`, the unit tests and a typecheck.
- Push straight to `master` only when the owner has asked for exactly that
  change to go out now. If you are unsure whether it should deploy, it shouldn't:
  branch and open a PR instead.
- Don't merge a risky change late in the day or right before a show is due to be
  published — a bad deploy blocks the operator's only publishing route.

## Auth

Zitadel OIDC. The API verifies JWTs locally (`api/src/auth/verify-token.ts` — the only
verifier; REST and tRPC both go through it). Access needs the `member` **or** `admin`
role on the Team project. Zitadel allows one grant per user per project, so an admin
can't also be given `member`, which is why admin alone passes. Other project roles
(e.g. `website-admin`) grant nothing here. `POST /api/watcher/notify` uses
`WATCHER_API_KEY` instead.

## Rules that have bitten before

- **PocketBase is the data master.** The PB archive record owns title, notes, genres
  (= tags), media links and image; Postgres `show_uploads` is a working copy. Where they
  disagree, PB wins. Platform titles are derived from the PB title by appending
  `<DD.MM.YYYY> @ coming soon`, and that suffix never goes back into PB.
- **Covers go into PB's `image` field**, never S3. The api proxies the upload
  (`POST /api/shows/:id/cover`). S3/MinIO holds only video/audio.
- **PB returns 404/400, not 401, to an anonymous caller.** An empty "to process" list,
  PB sync 404s or genres that won't save mean the api's PB superuser token went bad, not
  that data is missing. The token is cached with a 15-minute TTL for this reason; keep it.
- **No endpoint returns a signed URL.** A presigned URL differs on every call; in a
  polled response it swaps `<video src>` mid-playback. Return keys and sign through the
  `storage.signObject` query keyed by the object. Keep the dev mock re-signing on every
  call so this stays visible in `?mock=1`.
- **Audio is AAC 256k (m4a), never MP3.**
- **AI copy (Groq) stays short and human**: 2–3 lines, no hype, no keyword stuffing.
- **Config comes from env vars**, documented in `.env.example`. No hardcoded endpoints or
  credentials.

## Commits

Conventional Commits (`fix(auth): …`). A one-line subject, and a body of a few lines at
most explaining why. No AI/Claude attribution lines (`Co-Authored-By`, session links).

Commit on a branch, not on `master` — see **Branching** above.
