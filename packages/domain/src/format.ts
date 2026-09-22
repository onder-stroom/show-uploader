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
// PostValidationError otherwise). When over, preserve the "@ coming soon <date>"
// convention suffix — the branding + date that every title carries — and trim
// the show-name part instead, joining with an ellipsis. Falls back to a plain
// cap when no suffix is present.
export function capTitle(title: string, max = 100): string {
  const t = (title ?? '').trim();
  if (t.length <= max) return t;
  const m = t.match(/\s*@\s*coming soon.*$/i);
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

// Strip the "<DD.MM.YYYY> @ coming soon" convention suffix so PocketBase keeps
// the plain show title — that suffix belongs only on the platform (YT/MixCloud)
// titles, not on the archive record.
export function baseTitle(title: string): string {
  // Strip the convention suffix as ONE unit: an optional "<date>" immediately
  // before "@ coming soon". Never strips a bare trailing date (a show literally
  // named "... 31.12.2025" keeps its name).
  return (title ?? '')
    .replace(/\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\s*)?@\s*coming soon\s*$/i, '')
    .trim();
}

// The inverse: the platform title convention "<name> <DD.MM.YYYY> @ coming soon"
// built from a plain PocketBase title + the show date (YYYY-MM-DD). Strips any
// existing suffix first so re-syncing never doubles it.
export function platformTitle(name: string, date: string): string {
  const [y, m, d] = (date ?? '').split('-');
  const dmy = d && m && y ? `${d}.${m}.${y}` : date;
  return `${baseTitle(name)} ${dmy} @ coming soon`.trim();
}
