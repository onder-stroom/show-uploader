// Render tags as hashtags and append them to a description, so they're visible
// (YouTube shows the first 3 above the title; PocketBase notes render them as
// text). Spaces/punctuation are stripped since hashtags can't contain them.
export function tagsToHashtags(tags: string[]): string {
  return tags
    .map((t) => '#' + t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((h) => h.length > 1)
    .slice(0, 10)
    .join(' ');
}

// YouTube and MixCloud both cap a title at 100 characters (400 invalidTitle /
// PostValidationError otherwise). When over, preserve the "@ <strand>" convention
// suffix ("@ coming soon", "@ De Bosbar", …) — the branding every title carries — and trim
// the show-name part instead, joining with an ellipsis. Falls back to a plain
// cap when no suffix is present.
export function capTitle(title: string, max = 100): string {
  const t = (title ?? '').trim();
  if (t.length <= max) return t;
  const m = t.match(/\s*@\s*[^@]+$/);
  const suffix = m ? m[0].trim() : '';
  if (suffix && suffix.length + 2 < max) {
    const room = max - suffix.length - 2; // 2 = ellipsis + space
    const name = t.slice(0, t.length - suffix.length).trim();
    const cut = name.slice(0, room).replace(/\s+\S*$/, '').trim() || name.slice(0, room).trim();
    return `${cut}\u2026 ${suffix}`;
  }
  return t.slice(0, max - 1).replace(/\s+\S*$/, '').trim() + '\u2026';
}

// YouTube rejects any `<` or `>` in a title or description (invalidDescription /
// invalidTitle, HTTP 400) — a "<3" heart or a stray bracket kills the whole
// sync. Swap them for the look-alike single guillemets, which YouTube accepts
// and which read almost identically. MixCloud has no such rule, so this is
// applied only on the YouTube path.
export function sanitizeForYoutube(text: string): string {
  return (text ?? '').replace(/</g, '\u2039').replace(/>/g, '\u203a');
}

export function appendHashtags(description: string, tags: string[]): string {
  const tail = tagsToHashtags(tags);
  if (!tail) return description;
  return description ? `${description}\n\n${tail}` : tail;
}

// The archive description is rich text (HTML, like the react-admin editor on the
// agenda). YouTube/MixCloud descriptions are plain text, so convert to text
// before pushing: block-level tags become line breaks, other tags are dropped,
// and the common HTML entities are decoded. Plain-text input passes through
// unchanged (no tags → nothing to strip).
export function htmlToText(html: string): string {
  if (!html || !/[<&]/.test(html)) return html ?? '';
  return html
    // Links first, before the generic tag strip eats the href. Dropping it left
    // "our mixcloud" as dead text on YouTube, where descriptions are plain text
    // and a URL has to be written out to be usable. Anchor text that already IS
    // the address isn't repeated.
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, inner: string) => {
      const url = String(href).trim();
      const text = String(inner).replace(/<[^>]+>/g, '').trim();
      if (!url) return text;
      const sameAsText = text === url || text === url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      return !text || sameAsText ? url : `${text} (${url})`;
    })
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A show's strand (channel) as the agenda stores it on the archive record. The default
// strand is the house brand ("coming soon") and needs no marking; any other strand
// (e.g. "De Bosbar") is what tells the platforms the show is not a coming soon one.
export type ShowStrand = { name: string; isDefault: boolean };

/** The strand's name when it is not the default one, else null. */
export function otherStrandName(strand: ShowStrand | null | undefined): string | null {
  const name = strand?.name?.trim();
  return strand && !strand.isDefault && name ? name : null;
}

// Strip the "<DD.MM.YYYY> @ <strand>" convention suffix so PocketBase keeps the plain
// show title — that suffix belongs only on the platform (YT/MixCloud) titles, not on
// the archive record.
export function baseTitle(title: string): string {
  // Strip the convention suffix as ONE unit. "@ coming soon" is recognised on its own;
  // any other strand needs the date directly before the "@", so a show literally
  // named "Live @ Café" or ending in a bare date keeps its name.
  return (title ?? '')
    .replace(/\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*)?@\s*coming soon\s*$/i, '')
    .replace(/\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*@\s*[^@]+$/, '')
    .trim();
}

// The inverse: the platform title convention "<name> <DD.MM.YYYY> @ <strand>" built
// from a plain PocketBase title + the show date (YYYY-MM-DD). `strand` is the name of
// a non-default strand; without one the suffix is "@ coming soon". Strips any existing
// suffix first so re-syncing never doubles it.
export function platformTitle(name: string, date: string, strand?: string | null): string {
  const [y, m, d] = (date ?? '').split('-');
  const dmy = d && m && y ? `${d}.${m}.${y}` : date;
  return `${baseTitle(name)} ${dmy} @ ${strand?.trim() || 'coming soon'}`.trim();
}

/**
 * The non-default strand a platform title names: "Radio Boslabs 30.09.2026 @ De Bosbar" is
 * "De Bosbar", "... @ coming soon" is null. The title is what the platform shows, so it is
 * the one source for the suffix and the tag alike, whichever job or edit the title rode in on.
 */
export function strandOfTitle(title: string): string | null {
  const m = /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*@\s*([^@]+?)\s*$/.exec(title ?? '');
  const name = m?.[1].trim();
  return name && name.toLowerCase() !== 'coming soon' ? name : null;
}

// The tags a platform gets: the show's own tags, with a non-default strand first. First,
// because YouTube shows only the first three hashtags above the title and MixCloud keeps
// only five tags. PocketBase's genres never get it: the strand is not a genre.
export function platformTags(tags: string[], strand?: string | null): string[] {
  const name = strand?.trim();
  if (!name) return tags;
  return [name, ...tags.filter((t) => t.trim().toLowerCase() !== name.toLowerCase())];
}
