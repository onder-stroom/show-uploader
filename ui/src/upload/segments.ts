import type { AgendaSlot, Segment } from '@domain/recording-segments';

/**
 * The editor's working copy of a segment. Dragging and resizing on the waveform is
 * wavesurfer's Regions plugin; the server re-validates everything with the domain rules.
 */
export type Draft = Segment & { id: string; showId: string | null };

const round1 = (n: number) => Math.round(n * 10) / 10;

export function formatTimecode(s: number): string {
  const total = Math.max(0, round1(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total - h * 3600 - m * 60;
  const secText = sec.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${secText}` : `${m}:${secText}`;
}

/** h:mm:ss, m:ss, or plain seconds, each with optional decimals. Null when unreadable. */
export function parseTimecode(text: string): number | null {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  // Minutes may exceed 59 only when there is no hours part ("62:03" is an hour and two minutes).
  if ((m[1] !== undefined && min >= 60) || sec >= 60) return null;
  return h * 3600 + min * 60 + sec;
}

/**
 * The agenda stores UTC: a date (of the start) and HH:MM times. A show that ends "before"
 * it starts crosses midnight. Only ever a suggestion: real nights run over and under.
 */
export function agendaSlot(show: { id: string; date: string; startTime: string; endTime: string }): AgendaSlot | null {
  // Date.parse is lenient with garbage like "T:00Z" (V8 reads it as year 2000), so check the shape first.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(show.date) || !/^\d{2}:\d{2}$/.test(show.startTime) || !/^\d{2}:\d{2}$/.test(show.endTime)) return null;
  const startMs = Date.parse(`${show.date}T${show.startTime}:00Z`);
  let endMs = Date.parse(`${show.date}T${show.endTime}:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs += 24 * 3600_000;
  return { showId: show.id, startMs, endMs };
}
