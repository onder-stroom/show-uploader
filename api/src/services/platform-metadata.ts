import { env } from '../env';
import { appendHashtags, htmlToText, sanitizeForYoutube, capTitle } from '@show-uploader/domain';

// Edit already-published metadata (title/description/tags) in place on each
// platform — no re-upload. Called when an operator changes an archive record.
// Every function returns null on success or an error string (never throws), so
// one platform failing doesn't abort the others or the DB write.

export type MetaEdit = { title: string; description: string; tags: string[] };

// https://www.youtube.com/watch?v=<id>  ->  <id>
function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get('v') ?? (u.pathname.startsWith('/watch') ? null : u.pathname.slice(1) || null);
  } catch {
    return null;
  }
}

// https://www.mixcloud.com/<user>/<slug>/  ->  /<user>/<slug>/  (the cloudcast key)
function mixcloudKey(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    return p.endsWith('/') ? p : `${p}/`;
  } catch {
    return null;
  }
}

async function youtubeAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID ?? '',
      client_secret: env.YOUTUBE_CLIENT_SECRET ?? '',
      refresh_token: env.YOUTUBE_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('no access_token');
  return data.access_token;
}

// Read a published YouTube video's privacy status (public/unlisted/private) so
// the UI can reflect the real state instead of always offering "set public".
export async function getYoutubePrivacyStatus(
  url: string
): Promise<{ privacyStatus: string | null; error: string | null }> {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_REFRESH_TOKEN) return { privacyStatus: null, error: 'YouTube not configured' };
  const id = youtubeVideoId(url);
  if (!id) return { privacyStatus: null, error: `couldn't parse video id from ${url}` };
  try {
    const token = await youtubeAccessToken();
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { privacyStatus: null, error: `YouTube read ${r.status}: ${await r.text()}` };
    const status = ((await r.json()) as { items?: { status?: { privacyStatus?: string } }[] }).items?.[0]?.status;
    return { privacyStatus: status?.privacyStatus ?? null, error: null };
  } catch (err) {
    return { privacyStatus: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// Flip a published YouTube video to public. Requires the youtube.force-ssl scope
// (the upload-only token returns 403 — re-authorise to enable this).
export async function setYoutubePublic(url: string): Promise<string | null> {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_REFRESH_TOKEN) return 'YouTube not configured';
  const id = youtubeVideoId(url);
  if (!id) return `couldn't parse video id from ${url}`;
  try {
    const token = await youtubeAccessToken();
    const g = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!g.ok) return `YouTube read ${g.status}: ${await g.text()}`;
    const status = ((await g.json()) as { items?: { status?: Record<string, unknown> }[] }).items?.[0]?.status ?? {};
    status.privacyStatus = 'public';
    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) return `YouTube set-public ${res.status}: ${await res.text()}`;
    return null;
  } catch (err) {
    return `YouTube: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function syncYoutubeMetadata(url: string, edit: MetaEdit): Promise<string | null> {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_REFRESH_TOKEN) return 'YouTube not configured';
  const id = youtubeVideoId(url);
  if (!id) return `couldn't parse video id from ${url}`;
  try {
    const token = await youtubeAccessToken();
    // videos.update replaces the whole snippet, so categoryId must be re-sent.
    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        snippet: {
          title: sanitizeForYoutube(capTitle(edit.title)),
          // The description is rich-text HTML (the PB master); YouTube wants plain
          // text, and rejects any `<`/`>` (a "<3" 400'd the whole sync).
          description: sanitizeForYoutube(appendHashtags(htmlToText(edit.description), edit.tags)),
          tags: edit.tags,
          categoryId: '10',
        },
      }),
    });
    if (!res.ok) return `YouTube update ${res.status}: ${await res.text()}`;
    return null;
  } catch (err) {
    return `YouTube: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// PocketBase file URLs are built with the PUBLIC host (for the browser), but the
// api container reaches PB over the INTERNAL host — the public IP isn't reachable
// from inside the box (NAT hairpin), so a server-side fetch of the public URL
// fails ("fetch failed"). Rewrite the base to the internal host for server fetches.
function internalPbUrl(url: string): string {
  return env.POCKETBASE_INTERNAL_URL && env.POCKETBASE_URL
    ? url.replace(env.POCKETBASE_URL, env.POCKETBASE_INTERNAL_URL)
    : url;
}

// imageUrl (the PocketBase record cover) is optional: when given, the cover is
// re-uploaded to MixCloud too (via multipart), so changing the agenda cover and
// hitting "update" re-syncs the artwork. Without it, only the text is edited.
export async function syncMixcloudMetadata(
  url: string,
  edit: MetaEdit,
  imageUrl?: string | null
): Promise<string | null> {
  if (!env.MIXCLOUD_ACCESS_TOKEN) return 'MixCloud not configured';
  const key = mixcloudKey(url);
  if (!key) return `couldn't parse cloudcast key from ${url}`;
  try {
    // POST /upload/<user>/<slug>/edit/ — tags are all-or-nothing, so re-send them.
    const endpoint = `https://api.mixcloud.com/upload${key}edit/?access_token=${encodeURIComponent(env.MIXCLOUD_ACCESS_TOKEN)}`;
    // The description is rich-text HTML (the PB master); MixCloud wants plain text.
    const description = htmlToText(edit.description);
    let res: Response;
    if (imageUrl) {
      // Multipart so the cover picture rides along with the metadata.
      const img = await fetch(internalPbUrl(imageUrl));
      if (!img.ok) return `MixCloud cover fetch ${img.status}`;
      const ct = img.headers.get('content-type') ?? 'image/jpeg';
      const buf = Buffer.from(await img.arrayBuffer());
      const form = new FormData();
      form.append('name', capTitle(edit.title));
      form.append('description', description);
      edit.tags.slice(0, 5).forEach((tag, i) => form.append(`tags-${i}-tag`, tag));
      form.append('picture', new Blob([new Uint8Array(buf)], { type: ct }), `cover.${ct.split('/')[1]?.split(';')[0] || 'jpg'}`);
      res = await fetch(endpoint, { method: 'POST', body: form });
    } else {
      const body = new URLSearchParams({ name: capTitle(edit.title), description });
      edit.tags.slice(0, 5).forEach((tag, i) => body.append(`tags-${i}-tag`, tag));
      res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    }
    if (!res.ok) return `MixCloud edit ${res.status}: ${await res.text()}`;
    const data = (await res.json()) as { error?: { message: string } };
    if (data.error) return `MixCloud: ${data.error.message}`;
    return null;
  } catch (err) {
    return `MixCloud: ${err instanceof Error ? err.message : String(err)}`;
  }
}
