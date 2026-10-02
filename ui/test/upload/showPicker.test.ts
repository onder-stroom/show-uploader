import { describe, expect, it } from 'vitest';
import { filterShows, showOptionMeta, slotFromRecording, toShowOption, validateNewShow, type ShowOption } from '../../src/upload/showPicker';

const opt = (over: Partial<ShowOption> = {}): ShowOption => ({
  id: 'a', title: 'RADIO DADA', date: '2026-09-30', startTime: '14:00', endTime: '15:00', strand: null, taken: false, ...over,
});

describe('toShowOption and showOptionMeta', () => {
  it('labels a show with its date and times, and only a non-default strand', () => {
    const bosbar = toShowOption({ id: 'b', title: 'Radio Boslabs', date: '2026-09-30', startTime: '14:00', endTime: '15:00', strand: { name: 'De Bosbar', isDefault: false } }, false);
    expect(showOptionMeta(bosbar)).toBe('30.09.2026 · 14:00–15:00 · De Bosbar');

    const house = toShowOption({ id: 'c', title: 'RADIO DADA', date: '2026-09-23', startTime: '20:00', endTime: '22:00', strand: { name: 'coming soon', isDefault: true } }, true);
    expect(showOptionMeta(house)).toBe('23.09.2026 · 20:00–22:00');
    expect(house.taken).toBe(true);
  });

  it('tells apart shows with the same title', () => {
    expect(showOptionMeta(opt({ date: '2026-09-23' }))).not.toBe(showOptionMeta(opt({ date: '2026-09-30' })));
  });
});

describe('filterShows', () => {
  const list = [
    opt({ id: '1', title: 'RADIO DADA', date: '2026-09-23' }),
    opt({ id: '2', title: 'RADIO DADA', date: '2026-09-30' }),
    opt({ id: '3', title: 'Radio Boslabs', date: '2026-09-30', strand: 'De Bosbar' }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterShows(list, '  ')).toHaveLength(3);
  });

  it('matches title, date as shown or stored, and strand, case-insensitively', () => {
    expect(filterShows(list, 'bos').map((o) => o.id)).toEqual(['3']);
    expect(filterShows(list, '23.09').map((o) => o.id)).toEqual(['1']);
    expect(filterShows(list, '2026-09-30').map((o) => o.id)).toEqual(['2', '3']);
    expect(filterShows(list, 'DE BOSBAR').map((o) => o.id)).toEqual(['3']);
  });

  it('needs every word, in any order', () => {
    expect(filterShows(list, '30.09 dada').map((o) => o.id)).toEqual(['2']);
    expect(filterShows(list, 'dada boslabs')).toEqual([]);
  });
});

describe('slotFromRecording', () => {
  const recordedAt = Date.UTC(2026, 8, 30, 12, 0, 0); // 12:00 UTC

  it('turns a segment into the UTC date and times the agenda uses', () => {
    expect(slotFromRecording(recordedAt, 0, 3600)).toEqual({ date: '2026-09-30', startTime: '12:00', endTime: '13:00' });
    expect(slotFromRecording(recordedAt, 5400, 9000)).toEqual({ date: '2026-09-30', startTime: '13:30', endTime: '14:30' });
  });

  it('takes the date from the segment start, so a night running past midnight is dated by its start', () => {
    expect(slotFromRecording(recordedAt, 11.5 * 3600, 12.5 * 3600)).toEqual({ date: '2026-09-30', startTime: '23:30', endTime: '00:30' });
    expect(slotFromRecording(recordedAt, 12.5 * 3600, 13.5 * 3600)).toEqual({ date: '2026-10-01', startTime: '00:30', endTime: '01:30' });
  });
});

describe('validateNewShow', () => {
  const ok = { title: 'Bosbar', date: '2026-09-30', startTime: '14:00', endTime: '16:00' };

  it('accepts a complete form, including one that crosses midnight', () => {
    expect(validateNewShow(ok)).toBeNull();
    expect(validateNewShow({ ...ok, startTime: '23:00', endTime: '01:00' })).toBeNull();
  });

  it('names the first thing that is wrong', () => {
    expect(validateNewShow({ ...ok, title: '  ' })).toMatch(/title/);
    expect(validateNewShow({ ...ok, date: '' })).toMatch(/date/);
    expect(validateNewShow({ ...ok, date: '2026-13-45' })).toMatch(/date/);
    expect(validateNewShow({ ...ok, startTime: '' })).toMatch(/time/);
    expect(validateNewShow({ ...ok, endTime: '25:00' })).toMatch(/time/);
    expect(validateNewShow({ ...ok, endTime: '14:00' })).toMatch(/same time/);
  });
});
