import { otherStrandName, type ShowStrand } from '@domain/format';

/** One row of the recordings editor's show picker. */
export type ShowOption = {
  id: string;
  title: string;
  /** YYYY-MM-DD, UTC like every agenda time. */
  date: string;
  startTime: string;
  endTime: string;
  /** Only a non-default strand; the house brand needs no label. */
  strand: string | null;
  /** Already chosen by another segment of this recording. */
  taken: boolean;
};

export function toShowOption(
  show: { id: string; title: string; date: string; startTime: string; endTime: string; strand: ShowStrand | null },
  taken: boolean
): ShowOption {
  return { id: show.id, title: show.title, date: show.date, startTime: show.startTime, endTime: show.endTime, strand: otherStrandName(show.strand), taken };
}

const dmy = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('.') : date);

/** The line under the title that tells identically named shows apart: "30.09.2026 · 14:00–15:00 · De Bosbar". */
export function showOptionMeta(o: ShowOption): string {
  return [dmy(o.date), `${o.startTime}–${o.endTime}`, o.strand].filter(Boolean).join(' · ');
}

/**
 * Every word typed must appear somewhere in the title, date (as shown and as stored), times or
 * strand, in any order, so "boslabs 30.09" and "bosbar 2026-09" both find their show.
 */
export function filterShows(options: ShowOption[], query: string): ShowOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((o) => {
    const hay = `${o.title} ${dmy(o.date)} ${o.date} ${o.startTime} ${o.endTime} ${o.strand ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** What a new show starts as: this part of the recording, in the agenda's UTC. */
export function slotFromRecording(recordedAtMs: number, startS: number, endS: number): { date: string; startTime: string; endTime: string } {
  const iso = (s: number) => new Date(recordedAtMs + Math.round(s) * 1000).toISOString();
  const start = iso(startS);
  return { date: start.slice(0, 10), startTime: start.slice(11, 16), endTime: iso(endS).slice(11, 16) };
}

export type NewShowForm = { title: string; date: string; startTime: string; endTime: string };

/** The message for the first thing wrong with the form, or null. The server checks again. */
export function validateNewShow(f: NewShowForm): string | null {
  if (!f.title.trim()) return 'give the show a title';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || Number.isNaN(Date.parse(`${f.date}T00:00:00Z`))) return 'pick a date';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.endTime)) return 'fill in the start and end time';
  if (f.startTime === f.endTime) return 'the show cannot start and end at the same time';
  return null;
}
