import { z } from 'zod';

const schema = z.object({
  DATABASE_URI: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().url().optional(),
  // Browser-reachable host for presigned upload URLs (S3_ENDPOINT is the
  // internal docker host the worker uses). Falls back to S3_ENDPOINT.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('show-uploader'),
  S3_REGION: z.string().default('us-east-1'),
  SHOWS_API_URL: z.string().url(),
  SHOWS_API_KEY: z.string(),
  GROQ_API_KEY: z.string(),
  // Providers retire models without notice: llama-3.3-70b-versatile went 404 in
  // production and every generation silently fell back to the show's own copy.
  // Overridable so the next retirement is an env change, not a deploy.
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  JINGLE_S3_KEY: z.string().optional(),
  // Public base for the permanent recording links written onto agenda records
  // (/api/public/recordings/...). Browsers open these, so this must be the
  // externally reachable host, not a docker alias. Mirrors worker's own copy —
  // the worker writes these links when an archive job finishes; the api writes
  // them for the one-time backfill covering uploads archived before that
  // existed. Unset skips the backfill entirely, same as it skips the worker.
  APP_PUBLIC_URL: z.string().url().optional(),
  // Platform creds — the api edits published metadata (title/desc/tags) in place
  // when an archive record is changed, so it needs the same tokens as the worker.
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),
  MIXCLOUD_ACCESS_TOKEN: z.string().optional(),
  WATCHER_API_KEY: z.string().default('change-me'),
  ZITADEL_DOMAIN: z.string(),
  ZITADEL_CLIENT_ID: z.string(),
  POCKETBASE_URL: z.string().url().default('https://agenda.coming-soon.space'),
  // Server-side PB calls use this; on a single host it points at the internal
  // docker alias to avoid NAT hairpinning. Falls back to POCKETBASE_URL.
  // Browser-facing file links always use the public POCKETBASE_URL.
  POCKETBASE_INTERNAL_URL: z.string().url().optional(),
  LIVE_GUARD_BUFFER_MIN: z.coerce.number().default(15),
  // An episode claiming a longer air window than this is bad schedule data —
  // the guard ignores it instead of parking the queue behind it.
  // Positive and finite: a zero/negative bound would reject every episode, and
  // Infinity would restore the unbounded behaviour this guard exists to stop.
  LIVE_GUARD_MAX_EPISODE_HOURS: z.coerce.number().positive().finite().default(12),
  // Ceiling on how far a live show can push queued work, whatever PB says.
  LIVE_GUARD_MAX_DEFER_MIN: z.coerce.number().positive().finite().default(240),
  // Superuser creds — needed at runtime to read draft archive records (gated).
  PB_SERVICE_EMAIL: z.string().optional(),
  PB_SERVICE_PASSWORD: z.string().optional(),
  PORT: z.string().default('3000'),
  NODE_ENV: z.string().default('development'),
});

export const env = schema.parse(process.env);
