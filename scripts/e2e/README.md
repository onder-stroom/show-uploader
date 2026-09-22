# End-to-end checks

Proves a change actually works, against the **built** output rather than mocks:
the real ffmpeg, S3, Postgres and Redis, on a throwaway local stack.

```bash
pnpm e2e              # build, start the stack, run both suites, tear it down
pnpm e2e worker       # only the worker suite
pnpm e2e api --keep   # only the api suite, leaving the containers up
```

Needs `docker` and `ffmpeg` on the machine. A full run takes a couple of minutes,
most of it ffmpeg.

## What runs

| File | What it proves |
|---|---|
| `worker.mjs` | The built worker consumes a real archive job: trims, remuxes, extracts audio, hands off to the platform jobs, writes the agenda links back, then shrink and preview. |
| `api.mjs` | The built api use cases on their real adapters, with the worker consuming what they queue: preview, publish, retry, metadata edit, shrink, and the duplicate-publish guard. |
| `lib.mjs` | The stack, fixtures and the reporter. |

## Why it is safe

- The containers are named `e2e-*` and listen on 19000 / 15432 / 16379, so a
  running `docker compose up` is untouched.
- `PUBLISH_DRY_RUN=true`, so YouTube and MixCloud are simulated by the worker's
  own dry-run path however the shell is configured.
- PocketBase is a local stub that records the write-backs; no agenda record is
  read or written.
- Nothing reads the production `.env`.

## Gotchas

- Postgres runs with `-c ssl=on` and the image's snakeoil certificate, because
  both database clients connect with `ssl: 'require'`.
- BullMQ remembers completed job ids, so the preview job id includes a timestamp.
  Re-running against a kept stack otherwise silently skips the remux.
- The MixCloud cover frame is grabbed 20s in, so on these short test clips it
  fails and falls back — that warning in the log is expected.
