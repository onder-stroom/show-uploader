# Moving off Neon onto the stack's own Postgres

One-time cutover. The database is small (~11 MB, a few hundred rows), so the
whole thing is a dump and a restore — the pause is a couple of minutes.

Nothing here is reversible by itself, but Neon is left untouched throughout, so
rolling back is putting the old `DATABASE_URI` back and redeploying.

## What changes

- A `postgres` service in the stack, on the isolated `default` network. It is
  never published to the host or Traefik, which is why it runs without TLS.
- Its data lives on the big disk: `/mnt/storage/postgres`.
- A `postgres-backup` sidecar writes a nightly `pg_dump` to
  `/mnt/storage/backups/postgres` and keeps 14 days. Neon did this for us;
  self-hosting means we take our own.
- The api and worker wait for the database to be healthy before starting.

## Before you start

- `master` is deployed and green (`gh run list -w "Deploy to Komodo"`).
- You have the current Neon `DATABASE_URI` (it is in the stack's `.env`).
- Publishing is idle: no job running on the jobs-queue page, nobody uploading.

## 1. Add the new credentials to the stack `.env`

In Komodo → stack `show-uploader` → Environment, add:

```env
POSTGRES_USER=show_uploader
POSTGRES_PASSWORD=<a long random password>
POSTGRES_DB=show_uploader
```

Leave `DATABASE_URI` pointing at Neon for now. Deploy the stack. The database
starts and stays empty; the api and worker keep using Neon.

## 2. Copy the data across

On the server, from the stack directory:

```bash
# The current value, straight from the stack's environment.
NEON_URI='postgresql://…neon.tech/…?sslmode=require'

# Schema and data in one file. --no-owner/--no-acl because the roles differ.
docker run --rm postgres:17-alpine \
  pg_dump --no-owner --no-acl "$NEON_URI" > /tmp/neon-dump.sql

# Sanity: expect CREATE TABLE lines and a few hundred COPY rows.
grep -c 'CREATE TABLE' /tmp/neon-dump.sql
wc -l /tmp/neon-dump.sql

docker compose exec -T postgres \
  psql -U show_uploader -d show_uploader < /tmp/neon-dump.sql
```

Check it landed:

```bash
docker compose exec postgres psql -U show_uploader -d show_uploader \
  -c "SELECT (SELECT count(*) FROM show_uploads) AS uploads,
             (SELECT count(*) FROM platform_jobs) AS jobs,
             (SELECT count(*) FROM schema_migrations) AS migrations;"
```

The counts must match Neon. `schema_migrations` carrying every filename is what
stops the api re-running migrations over restored data.

## 3. Point the app at it

In the stack `.env`, replace `DATABASE_URI`:

```env
DATABASE_URI=postgresql://show_uploader:<the password>@postgres:5432/show_uploader
```

No `sslmode`: the connection never leaves the docker network. Deploy the stack.

## 4. Check

```bash
docker compose logs api --tail 30     # "API listening", no migration errors
docker compose logs worker --tail 30  # "Worker started"
```

Then in the browser: the jobs queue lists past uploads, the archive page opens a
show, and the storage page still reports disk figures. Publishing a real show is
the only full proof — the next one you do is the real check.

## 5. Afterwards

- Keep the Neon project for a week or two as a fallback, then delete it there to
  actually stop the billing. Removing `DATABASE_URI` from the stack does not.
- Confirm the first nightly backup appeared:
  `ls -l /mnt/storage/backups/postgres`.

## Rollback

Put the Neon `DATABASE_URI` back and deploy. Neon is never written to after the
cutover, so anything published in the meantime would have to be re-entered — one
more reason to do this when nothing is queued.

## Restoring from a backup

```bash
docker compose exec -T postgres \
  psql -U show_uploader -d show_uploader < /mnt/storage/backups/postgres/show-uploader-2026-09-23.sql
```
