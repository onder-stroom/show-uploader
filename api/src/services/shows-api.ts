import { env } from '../env';
import type { ArchiveRecord } from '../pocketbase-types';
import { platformTitle } from '@show-uploader/domain';
import { syncYoutubeMetadata, syncMixcloudMetadata } from './platform-metadata';

// Server-side calls prefer the internal host (no NAT hairpin on a single box).
const pbBase = env.POCKETBASE_INTERNAL_URL ?? env.POCKETBASE_URL;

export type AgendaShow = {
  id: string;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  imageUrl: string | null;
  tags: string[] | null;
  // Links already on the record (YouTube/MixCloud), so the UI can show what's
  // published and pre-select only the missing platform on a re-publish.
  mediaLinks: MediaLink[];
  // The linked series blurb (archive.series → series.description). Context for
  // the upload description: seed from it when the episode has no notes of its own,
  // and feed it to the AI suggestion. Null when there's no linked show.
  showDescription: string | null;
  // PocketBase's own record timestamp — when anything on the record last
  // changed. Drives the "last updated" sort on the archive catalogue.
  updated: string;
};

// PocketBase serialises datetimes as "YYYY-MM-DD HH:MM:SS.sssZ".
function splitDateTime(ts: string | undefined): { date: string; time: string } {
  const [date = '', rest = ''] = (ts ?? '').split(' ');
  return { date, time: rest.slice(0, 5) };
}

type ArchiveItem = Pick<
  ArchiveRecord,
  'id' | 'title' | 'notes' | 'startTime' | 'endTime' | 'image' | 'genres' | 'mediaLinks'
> & {
  collectionId: string;
  updated?: string;
  expand?: { genres?: { name: string }[]; series?: { description?: string } };
};

// The relation-expand string used everywhere we read an archive record — the
// genre names for tags + the linked show's description for the upload context.
const ARCHIVE_EXPAND = 'genres,series';
const ARCHIVE_FIELDS =
  'id,title,notes,startTime,endTime,image,genres,mediaLinks,collectionId,updated,expand.genres.name,expand.series.description';

export function toAgendaShow(rec: ArchiveItem): AgendaShow {
  const start = splitDateTime(rec.startTime);
  const end = splitDateTime(rec.endTime);
  return {
    id: rec.id,
    title: rec.title ?? '',
    description: rec.notes ?? '',
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    imageUrl: rec.image
      ? `${env.POCKETBASE_URL}/api/files/${rec.collectionId}/${rec.id}/${rec.image}`
      : null,
    // Genres are a relation; use the expanded names (not the raw record IDs).
    tags: rec.expand?.genres?.length ? rec.expand.genres.map((g) => g.name).filter(Boolean) : null,
    mediaLinks: Array.isArray(rec.mediaLinks) ? (rec.mediaLinks as MediaLink[]) : [],
    showDescription: rec.expand?.series?.description || null,
    updated: rec.updated ?? '',
  };
}

// Draft archive records are gated behind superuser auth, so we hold a token and
// re-authenticate on demand (and once on a 401).
let cachedToken: string | null = null;
let cachedTokenAt = 0;
// Re-auth well within PocketBase's token lifetime. Crucially, an EXPIRED token is
// treated by PB as anonymous — draft reads/writes then come back 404/400 (not
// 401/403), so the "retry on 401/403" path never fires and a long-lived process
// would stay stuck as anonymous. A short TTL sidesteps that entirely.
const TOKEN_TTL_MS = 15 * 60 * 1000;

// Fresh cached token, or a newly authenticated one.
async function getToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken;
  return authenticate();
}

async function authenticate(): Promise<string> {
  if (!env.PB_SERVICE_EMAIL || !env.PB_SERVICE_PASSWORD) {
    throw new Error('PB_SERVICE_EMAIL / PB_SERVICE_PASSWORD required to read archive drafts');
  }
  const res = await fetch(`${pbBase}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: env.PB_SERVICE_EMAIL, password: env.PB_SERVICE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`PocketBase auth failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  cachedToken = token;
  cachedTokenAt = Date.now();
  return token;
}

async function fetchDrafts(token: string): Promise<Response> {
  const filter = `(status='draft')`;
  const url =
    `${pbBase}/api/collections/archive/records` +
    `?perPage=200&sort=-startTime&expand=${ARCHIVE_EXPAND}&fields=${ARCHIVE_FIELDS}&filter=${encodeURIComponent(filter)}`;
  return fetch(url, { headers: { Authorization: token } });
}

/**
 * The "to process" list: draft records in the PocketBase `archive` collection —
 * past shows whose recording still needs uploading. Requires superuser auth.
 */
export async function listShows(): Promise<AgendaShow[]> {
  let token = await getToken();
  let res = await fetchDrafts(token);
  if (res.status === 401 || res.status === 403) {
    token = await authenticate();
    res = await fetchDrafts(token);
  }
  if (!res.ok) throw new Error(`PocketBase archive error: ${res.status}`);
  const body = (await res.json()) as { items: ArchiveItem[] };
  return body.items.map(toAgendaShow);
}

async function fetchPublished(token: string): Promise<Response> {
  const filter = `(status='published')`;
  const url =
    `${pbBase}/api/collections/archive/records` +
    // listShows caps at 200, fine for the draft backlog. A multi-year
    // published history can exceed that, so this uses the same 500 cap
    // listArchiveStates already accepts for "every published record".
    `?perPage=500&sort=-startTime&expand=${ARCHIVE_EXPAND}&fields=${ARCHIVE_FIELDS}&filter=${encodeURIComponent(filter)}`;
  return fetch(url, { headers: { Authorization: token } });
}

/**
 * Published records in the PocketBase `archive` collection — the pool the
 * "attach a recording" picker draws from (ui/src/pages/Attach.tsx). Same
 * shape as listShows, different filter: this app never otherwise sees these
 * once they're published.
 */
export async function listPublishedShows(): Promise<AgendaShow[]> {
  let token = await getToken();
  let res = await fetchPublished(token);
  if (res.status === 401 || res.status === 403) {
    token = await authenticate();
    res = await fetchPublished(token);
  }
  if (!res.ok) throw new Error(`PocketBase archive error: ${res.status}`);
  const body = (await res.json()) as { items: ArchiveItem[] };
  return body.items.map(toAgendaShow);
}

/**
 * The whole archive, as PocketBase holds it — every record, any status,
 * archived here or not. The archive page is the catalogue view over this;
 * which links a record carries decides what its card can offer, not whether
 * it appears. Sourced from PocketBase, never from job rows: jobs are units of
 * work that ran once, and clearing one must not hide a record.
 */
export async function listAllArchiveShows(): Promise<AgendaShow[]> {
  const path =
    `/api/collections/archive/records` +
    `?perPage=500&sort=-startTime&expand=${ARCHIVE_EXPAND}&fields=${ARCHIVE_FIELDS}`;
  const res = await pbFetch(path);
  if (!res.ok) throw new Error(`PocketBase archive error: ${res.status}`);
  const body = (await res.json()) as { items: ArchiveItem[] };
  return body.items.map(toAgendaShow);
}

// Fetch a single archive record (any status) as an AgendaShow — used to read the
// current PocketBase metadata (title/notes/genres/image/mediaLinks) when syncing
// a published show to its platforms, PB being the master.
export async function getArchiveShow(id: string): Promise<AgendaShow | null> {
  const res = await pbFetch(`/api/collections/archive/records/${id}?expand=${ARCHIVE_EXPAND}&fields=${ARCHIVE_FIELDS}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PocketBase archive get error (${id}): ${res.status}`);
  return toAgendaShow((await res.json()) as ArchiveItem);
}

/**
 * Re-sync a published show's PocketBase metadata (title/description/tags, plus
 * the cover to MixCloud) to its linked platforms. `only` narrows which platforms
 * (undefined/null = all linked). Returns { youtube?, mixcloud? } — 'ok' or an
 * error string per platform. Returns null if the show doesn't exist.
 */
export async function syncShowToPlatforms(
  id: string,
  only?: string[] | null
): Promise<Record<string, string> | null> {
  const show = await getArchiveShow(id);
  if (!show) return null;
  const edit = {
    title: platformTitle(show.title, show.date),
    description: show.description ?? '',
    tags: show.tags ?? [],
  };
  const results: Record<string, string> = {};
  for (const link of show.mediaLinks) {
    const p = platformOfLabel(link.label);
    if (!p || (only && !only.includes(p))) continue;
    results[p] =
      (p === 'youtube'
        ? await syncYoutubeMetadata(link.url, edit)
        : await syncMixcloudMetadata(link.url, edit, show.imageUrl)) ?? 'ok';
  }
  return results;
}

/**
 * Cover image URL per archive record, for ALL statuses (draft AND published) —
 * unlike listShows (drafts only), so the archive/history thumbnails resolve for
 * shows that have since been published. Keyed by record id (= show_id).
 */
export type ArchiveState = { cover: string | null; status: 'draft' | 'published' };

/**
 * Cover + live publish status for every archive record, keyed by show id.
 *
 * Status is the point: without it the UI can only report what the operator
 * clicked in this browser session, which is wrong after a reload and wrong for
 * everyone on another machine. Deliberately unfiltered — a record with no cover
 * still has a status worth showing.
 */
export async function listArchiveStates(): Promise<Record<string, ArchiveState>> {
  // perPage caps at 500 records; the agenda is nowhere near that.
  const path = `/api/collections/archive/records?perPage=500&fields=id,image,collectionId,status`;
  const res = await pbFetch(path);
  if (!res.ok) throw new Error(`PocketBase archive states error: ${res.status}`);
  const body = (await res.json()) as {
    items: { id: string; image: string; collectionId: string; status: string }[];
  };
  const out: Record<string, ArchiveState> = {};
  for (const r of body.items) {
    out[r.id] = {
      // 160x160 = 2× the 64px list thumbnail (retina), a tiny fraction of the original.
      cover: r.image ? imageFileUrl(r.collectionId, r.id, r.image, '160x160') : null,
      status: r.status === 'published' ? 'published' : 'draft',
    };
  }
  return out;
}

// One entry in the archive record's `mediaLinks` JSON array, matching the shape
// the agenda site already stores/renders, e.g. { label:'YouTube', type:'video', url }.
export type MediaLink = { label: string; type: string; url: string };

/**
 * Which platform a media link's label refers to, or null for anything else.
 *
 * Case-insensitive because these labels are hand-typed in the agenda admin and
 * production genuinely holds "Youtube" and "Mixcloud" beside "YouTube" and
 * "MixCloud". Matching exactly meant a show that WAS on YouTube looked
 * unpublished, which is how a duplicate upload gets created.
 */
export function platformOfLabel(label: string): 'youtube' | 'mixcloud' | null {
  const n = label.trim().toLowerCase();
  return n === 'youtube' ? 'youtube' : n === 'mixcloud' ? 'mixcloud' : null;
}

export type ArchivePatch = {
  title?: string;
  notes?: string;
  mediaLinks?: MediaLink[];
  // Genre record IDs — the archive record's tag relation. Resolve free-text tag
  // names to IDs with resolveGenreIds() before passing them here.
  genres?: string[];
  // draft | published — only set by the explicit "publish to agenda" action.
  status?: string;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

async function pbFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = (token: string) => ({ ...(init?.headers ?? {}), Authorization: token });
  let token = await getToken();
  let res = await fetch(`${pbBase}${path}`, { ...init, headers: headers(token) });
  if (res.status === 401 || res.status === 403) {
    token = await authenticate();
    res = await fetch(`${pbBase}${path}`, { ...init, headers: headers(token) });
  }
  return res;
}

// All genre names, for tag autocomplete in the UI.
export async function listGenres(): Promise<string[]> {
  const res = await pbFetch(`/api/collections/genres/records?perPage=500&sort=name&fields=name`);
  if (!res.ok) throw new Error(`PocketBase genres error: ${res.status}`);
  const body = (await res.json()) as { items: { name: string }[] };
  return body.items.map((g) => g.name).filter(Boolean);
}

// Map free-text tag names to genre record IDs so the archive's `genres` relation
// mirrors the tags exactly. PocketBase is the master list: unknown tags become
// new genre records. Matching is case-insensitive on name; a failed create is
// logged and skipped (never aborts the surrounding write-back).
export async function resolveGenreIds(names: string[]): Promise<string[]> {
  // Dedup case-insensitively (matching below is case-insensitive too), so "House"
  // and "house" don't resolve to the same genre id twice.
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    wanted.push(n);
  }
  if (!wanted.length) return [];

  const listRes = await pbFetch(`/api/collections/genres/records?perPage=500&fields=id,name`);
  const byName = new Map<string, string>();
  if (listRes.ok) {
    const body = (await listRes.json()) as { items: { id: string; name: string }[] };
    for (const g of body.items) byName.set(g.name.toLowerCase(), g.id);
  }

  const ids: string[] = [];
  for (const name of wanted) {
    const key = name.toLowerCase();
    let id = byName.get(key);
    if (!id) {
      const res = await pbFetch(`/api/collections/genres/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug: slugify(name) }),
      });
      if (res.ok) {
        id = ((await res.json()) as { id: string }).id;
        byName.set(key, id);
      } else {
        console.error(`Failed to create genre "${name}": ${res.status} ${await res.text()}`);
        continue;
      }
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

// Merge incoming links into the existing ones by label: an incoming link
// replaces a same-label entry and others are kept. So publishing MixCloud onto a
// record that already has a YouTube link keeps both, rather than clobbering it.
function mergeMediaLinks(existing: MediaLink[], incoming: MediaLink[]): MediaLink[] {
  const byLabel = new Map(existing.map((l) => [l.label, l]));
  for (const l of incoming) byLabel.set(l.label, l);
  return [...byLabel.values()];
}

/**
 * Write the published result back onto a draft archive record: the platform
 * links (mediaLinks) plus any metadata the operator finalised (title, notes).
 * mediaLinks are MERGED with whatever's already on the record (so you can add a
 * second platform later); title/notes overwrite. Deliberately never touches
 * `status` — a human flips draft→published in the agenda admin after reviewing.
 * Uses the same superuser auth as listShows.
 */
export async function updateArchiveRecord(id: string, patch: ArchivePatch): Promise<void> {
  const recUrl = `${pbBase}/api/collections/archive/records/${id}`;

  const run = async (token: string): Promise<Response> => {
    let mediaLinks = patch.mediaLinks;
    if (mediaLinks && mediaLinks.length) {
      const cur = await fetch(`${recUrl}?fields=mediaLinks`, { headers: { Authorization: token } });
      if (cur.ok) {
        const existing = (await cur.json()).mediaLinks as MediaLink[] | null;
        mediaLinks = mergeMediaLinks(Array.isArray(existing) ? existing : [], mediaLinks);
      }
    }
    return fetch(recUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ ...patch, ...(mediaLinks ? { mediaLinks } : {}) }),
    });
  };

  let token = await getToken();
  let res = await run(token);
  if (res.status === 401 || res.status === 403) {
    token = await authenticate();
    res = await run(token);
  }
  if (!res.ok) {
    throw new Error(`PocketBase archive update failed (${id}): ${res.status} ${await res.text()}`);
  }
}

/**
 * Remove a single platform link from an archive record's mediaLinks by label.
 * Replaces the whole array (so it can actually drop an entry — unlike the merge
 * in updateArchiveRecord). Un-links only; the platform content stays live.
 */
export async function removeArchiveMediaLink(id: string, label: string): Promise<void> {
  const recPath = `/api/collections/archive/records/${id}`;
  const cur = await pbFetch(`${recPath}?fields=mediaLinks`);
  const existing = cur.ok ? ((await cur.json()).mediaLinks as MediaLink[] | null) : null;
  const next = (Array.isArray(existing) ? existing : []).filter((l) => l.label !== label);
  const res = await pbFetch(recPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaLinks: next }),
  });
  if (!res.ok) {
    throw new Error(`PocketBase remove media link failed (${id}): ${res.status} ${await res.text()}`);
  }
}

// Build the public file URL for a record's image (same shape as toAgendaShow).
// `thumb` (e.g. '160x160') asks PocketBase for an on-the-fly cropped thumbnail —
// far smaller than the original, for fast list rendering.
function imageFileUrl(collectionId: string, recordId: string, filename: string, thumb?: string): string {
  const base = `${env.POCKETBASE_URL}/api/files/${collectionId}/${recordId}/${filename}`;
  return thumb ? `${base}?thumb=${thumb}` : base;
}

/**
 * Set the archive record's cover image directly in PocketBase (the master) — no
 * S3. The api proxies the operator's uploaded file to PB's `image` file field.
 * Rebuilds the FormData per attempt so the 401/403 retry can re-send the body.
 * Returns the new public image URL (or null if PB stored none).
 */
export async function uploadArchiveImage(
  id: string,
  file: Buffer,
  filename: string,
  contentType: string
): Promise<string | null> {
  const recUrl = `${pbBase}/api/collections/archive/records/${id}`;
  const run = (token: string): Promise<Response> => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(file)], { type: contentType }), filename);
    return fetch(recUrl, { method: 'PATCH', headers: { Authorization: token }, body: form });
  };
  let token = await getToken();
  let res = await run(token);
  if (res.status === 401 || res.status === 403) {
    token = await authenticate();
    res = await run(token);
  }
  if (!res.ok) throw new Error(`PocketBase cover upload failed (${id}): ${res.status} ${await res.text()}`);
  const rec = (await res.json()) as { collectionId?: string; image?: string };
  return rec.image && rec.collectionId ? imageFileUrl(rec.collectionId, id, rec.image) : null;
}

// Clear the archive record's cover image in PocketBase.
export async function clearArchiveImage(id: string): Promise<void> {
  const res = await pbFetch(`/api/collections/archive/records/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: null }),
  });
  if (!res.ok) throw new Error(`PocketBase cover clear failed (${id}): ${res.status} ${await res.text()}`);
}
