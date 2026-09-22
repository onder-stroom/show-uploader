import { objectInfo } from './s3';
import { browse } from './storage-browse';
import { slugify } from '@show-uploader/domain';

/**
 * Which `shows/` folder holds a given agenda record's recording.
 *
 * Only needed for recordings archived before the folder was stored in the
 * agenda link itself (see routes/public.ts). Everything archived since knows
 * its folder outright, and this is what migrates the rest — so it runs once
 * per record, not on every read.
 *
 * Three things make the folder name unreliable on its own:
 *   - it comes from the recording's filename, not the agenda title, so "Lina
 *     Ejdaa" can sit in 2026-07-31-leena and "Into the ether (SAWT)" in
 *     2026-07-17-sawt;
 *   - several shows air on a given date, so the date alone never identifies
 *     one;
 *   - a show billed for one date is often recorded the evening before, so the
 *     folder may carry either date ("Palmbomen II" is billed 2026-08-07 and
 *     filed under 2026-08-08).
 *
 * So: take folders within a day of the billed date, and score them on words
 * shared with the title. Refuse on a tie rather than hand back another show's
 * recording — the caller leaves that record alone.
 *
 * There is deliberately one copy of this. It previously existed twice, and the
 * copies drifted: the backfill kept an exact-date, exactly-one-folder rule
 * that silently skipped six of fifteen records.
 */
export async function findShowFolder(show: { date: string; title: string }): Promise<string | null> {
  // The convention every recent folder follows — try it before listing.
  const guess = `shows/${show.date}-${slugify(show.title)}/`;
  if ((await objectInfo(`${guess}video.mp4`)).exists) return guess;

  const listing = await browse('shows/');
  const dates = [0, -1, 1].map((offset) => {
    const d = new Date(`${show.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });
  const candidates = listing.folders.filter((f) => dates.some((d) => f.name.startsWith(d)));
  if (candidates.length === 0) return null;

  // Two-character words ("II", "w") carry no signal and match too eagerly.
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const titleWords = words(show.title);
  const score = (folderName: string) => {
    // Strip whichever date prefix the folder carries, not the billed one.
    const folderWords = words(folderName.replace(/^\d{4}-\d{2}-\d{2}-?/, ''));
    return folderWords.filter((w) => titleWords.some((t) => t.startsWith(w) || w.startsWith(t))).length;
  };

  const ranked = candidates
    .map((folder) => ({ folder, score: score(folder.name) }))
    .sort((a, b) => b.score - a.score);

  if (ranked[0].score === 0) return null;
  if (ranked[1] && ranked[1].score === ranked[0].score) return null;
  return ranked[0].folder.key;
}
