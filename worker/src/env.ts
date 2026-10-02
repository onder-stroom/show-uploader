import { z } from 'zod';

const schema = z.object({
  DATABASE_URI: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  // Our own api (same compose network) + its shared internal key, used to write
  // the published result back onto the PocketBase archive record via the api's
  // superuser. Defaults to the in-network service address.
  INTERNAL_API_URL: z.string().url().default('http://api:3000/api'),
  // The uploader's own public base. Only used to build the permanent recording
  // links stored on the agenda records — they are opened by browsers, so the
  // internal docker host is useless here. Unset means those links are skipped.
  APP_PUBLIC_URL: z.string().url().optional(),
  WATCHER_API_KEY: z.string().default('change-me'),
  // The recordings service on the OBS PC (Tailscale). Unset means cut jobs fail with a
  // clear "not configured" message instead of hanging.
  RECORDINGS_AGENT_URL: z.string().url().optional(),
  RECORDINGS_AGENT_TOKEN: z.string().min(16).optional(),
  CUT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  // A cut is a stream copy (seconds); an upload is bound by the PC's uplink, and its
  // presigned part URLs live six hours.
  CUT_WAIT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  UPLOAD_WAIT_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REFRESH_TOKEN: z.string().optional(),
  YOUTUBE_PRIVACY_STATUS: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
  // 'auto' = dry-run only when platform creds are missing/placeholder; 'true'/'false' force it.
  PUBLISH_DRY_RUN: z.enum(['auto', 'true', 'false']).default('auto'),
  MIXCLOUD_ACCESS_TOKEN: z.string().optional(),
  // PocketBase file URLs are built with the PUBLIC host (agenda.coming-soon.space),
  // unreachable from inside the box (NAT hairpin). To fetch a record's cover image
  // for the MixCloud upload we rewrite that base to the INTERNAL host. Both come
  // from the compose env; when unset the cover fetch just uses the URL as-is.
  POCKETBASE_URL: z.string().url().optional(),
  POCKETBASE_INTERNAL_URL: z.string().url().optional(),
  ARCHIVE_VIDEO_BITRATE: z.string().default('4000k'),
  ARCHIVE_AUDIO_BITRATE: z.string().default('256k'),
  JINGLE_S3_KEY: z.string().optional(),
  // silencedetect threshold for auto edge-trim. Anything below this level counts
  // as silence, so a HIGHER (less negative) value also trims quiet room hiss /
  // tape noise, not just near-digital silence. -30 catches typical hiss; drop
  // toward -40 to be gentler on quiet fade-ins. Edges only — never mid-content.
  SILENCE_NOISE_DB: z.coerce.number().default(-30),
});

export const env = schema.parse(process.env);
