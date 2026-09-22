/**
 * Turn a recording's filename into a readable show folder name.
 *
 * Source names carry four things stacked together, e.g.
 *   1783776608000-misharog_10.07.2026__coming_soon__2026-07-10_15-52-25
 * an upload-time epoch prefix, the show name, the show date, the boilerplate
 * from the title convention, and OBS's capture timestamp. As a folder that is
 * noise: the date appears twice and the epoch means nothing to a human.
 *
 * Target: 2026-07-10-misharog
 *
 * Shared by the api (renaming existing folders) and the worker (newly published
 * shows), so both land a recording in the same folder.
 */

/** `1786…-` upload prefixes, sometimes stacked when a recording was replaced. */
const EPOCH_PREFIX = /^(\d{10,}-)+/;

/** The show date as written in the title: 10.07.2026, 8.8.2026. */
const DOTTED_DATE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;

/** OBS's capture stamp: 2026-07-10_15-52-25, optionally with a _1 dedupe tail. */
const CAPTURE_STAMP = /(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}(_\d+)?$/;

/** Already `2026-07-10-name`, i.e. this has been through here before. */
const ALREADY_SLUG = /^\d{4}-\d{2}-\d{2}-/;

const pad = (n: string) => n.padStart(2, '0');

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * `YYYY-MM-DD-name` for a recording basename (no directory, no extension).
 *
 * The date comes from the **title**, not from the capture stamp, because they
 * genuinely differ: a show billed as 8.8.2026 is recorded the evening before.
 * The billed date is the one worth filing under. The capture stamp is only a
 * fallback for names that carry no date of their own.
 *
 * Idempotent — feeding a slug back in returns it unchanged, which is what makes
 * re-running the rename safe.
 */
export function showSlug(basename: string): string {
  if (ALREADY_SLUG.test(basename)) return basename;

  const withoutPrefix = basename.replace(EPOCH_PREFIX, '');

  const dotted = withoutPrefix.match(DOTTED_DATE);
  if (dotted) {
    const [, d, m, y] = dotted;
    // Everything from the date onward is date + boilerplate + capture stamp.
    const name = withoutPrefix.slice(0, dotted.index);
    const slug = slugify(name);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    return slug ? `${date}-${slug}` : date;
  }

  const capture = withoutPrefix.match(CAPTURE_STAMP);
  if (capture) {
    const [, y, m, d] = capture;
    const slug = slugify(withoutPrefix.slice(0, capture.index));
    const date = `${y}-${m}-${d}`;
    return slug ? `${date}-${slug}` : date;
  }

  // No date anywhere — keep the name rather than inventing one, so the folder is
  // still identifiable and the operator can see it needs attention.
  return slugify(withoutPrefix) || basename;
}

/**
 * Make a slug unique within one run.
 *
 * Two shows on the same date with the same name are possible (a repeat, or a
 * re-upload), and silently merging them into one folder would overwrite one
 * show's artefacts with the other's.
 */
export function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
