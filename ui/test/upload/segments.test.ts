import { describe, expect, it } from 'vitest';
import {
  agendaSlot, draftKey, editorNote, formatTimecode, fromDraftSegments, newSegmentAt, parseTimecode, selectAfterRemove, showsDuringRecording,
  toDraftSegments, type Draft,
} from '../../src/upload/segments';

describe('timecodes', () => {
  it('formats with tenths, hours only when needed', () => {
    expect(formatTimecode(0)).toBe('0:00.0');
    expect(formatTimecode(65.25)).toBe('1:05.3');
    expect(formatTimecode(3723.4)).toBe('1:02:03.4');
  });

  it('parses h:mm:ss, m:ss, plain seconds and decimals; rejects nonsense', () => {
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('62:03.5')).toBe(3723.5);
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode(' 1:05 ')).toBe(65);
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:99')).toBeNull();
  });

  it('round-trips what it prints', () => {
    for (const s of [0, 59.9, 3600, 12345.6]) expect(parseTimecode(formatTimecode(s))).toBeCloseTo(s, 1);
  });
});

describe('agendaSlot', () => {
  it('reads the agenda\'s UTC date and times', () => {
    expect(agendaSlot({ id: 's', date: '2026-10-01', startTime: '20:00', endTime: '22:00' })).toEqual({
      showId: 's', startMs: Date.parse('2026-10-01T20:00:00Z'), endMs: Date.parse('2026-10-01T22:00:00Z'),
    });
  });

  it('a show that ends after midnight ends the next day', () => {
    const slot = agendaSlot({ id: 's', date: '2026-10-01', startTime: '23:00', endTime: '01:00' });
    expect(slot?.endMs).toBe(Date.parse('2026-10-02T01:00:00Z'));
  });

  it('gives null for times it cannot read, so a bad agenda entry is simply not suggested', () => {
    expect(agendaSlot({ id: 's', date: '', startTime: '', endTime: '' })).toBeNull();
  });
});

describe('newSegmentAt', () => {
  it('is 30 minutes from the playhead', () => {
    expect(newSegmentAt(100, 7200, [])).toEqual({ startS: 100, endS: 1900 });
  });
  it('stops at the next segment and at the end of the recording', () => {
    expect(newSegmentAt(100, 7200, [{ startS: 1000, endS: 2000 }])).toEqual({ startS: 100, endS: 1000 });
    expect(newSegmentAt(7000, 7200, [])).toEqual({ startS: 7000, endS: 7200 });
  });
  it('does nothing without room', () => {
    expect(newSegmentAt(1500, 7200, [{ startS: 1000, endS: 2000 }])).toBeNull();
    expect(newSegmentAt(100, 7200, [{ startS: 110, endS: 500 }])).toBeNull();
    expect(newSegmentAt(7190, 7200, [])).toBeNull();
  });
});

describe('selectAfterRemove', () => {
  const d = (id: string): Draft => ({ id, startS: 0, endS: 60, showId: null });
  const all = [d('a'), d('b'), d('c')];
  it('keeps the selection when another row is removed', () => {
    expect(selectAfterRemove(all, 'a', 'b')).toBe('b');
    expect(selectAfterRemove(all, 'a', null)).toBeNull();
  });
  it('selects the next neighbour, else the previous', () => {
    expect(selectAfterRemove(all, 'b', 'b')).toBe('c');
    expect(selectAfterRemove(all, 'c', 'c')).toBe('b');
  });
  it('selects nothing when the last row goes', () => {
    expect(selectAfterRemove([d('a')], 'a', 'a')).toBeNull();
  });
});

describe('editorNote', () => {
  const list = { reachable: true, recordings: [{ ref: 'r1' }] };
  it('is silent while the opened recording is listed', () => {
    expect(editorNote(list, 'r1')).toBeNull();
    expect(editorNote(undefined, 'r1')).toBeNull();
  });
  it('says so, without dropping the editor, when the PC is unreachable or the recording is not listed', () => {
    expect(editorNote({ reachable: false }, 'r1')).toMatch(/not reachable/);
    expect(editorNote(list, 'gone')).toMatch(/no longer listed/);
  });
});

describe('newSegmentAt at the edge of another segment', () => {
  it('lets a playhead sitting on a segment end start the next one, float noise or not', () => {
    const end = 3820.7000000000003; // what a drag leaves behind
    expect(newSegmentAt(3820.7, 15480, [{ startS: 217.6, endS: end }])).toEqual({ startS: 3820.7, endS: 5620.7 });
    expect(newSegmentAt(3820.7, 15480, [{ startS: 217.6, endS: 3820.7 }])).toEqual({ startS: 3820.7, endS: 5620.7 });
  });

  it('still refuses to start inside a segment, or a hair before its end', () => {
    expect(newSegmentAt(3820.6, 15480, [{ startS: 217.6, endS: 3820.7 }])).toBeNull();
    expect(newSegmentAt(300, 15480, [{ startS: 217.6, endS: 3820.7 }])).toBeNull();
  });
});

describe('showsDuringRecording', () => {
  const show = (id: string, date: string, startTime: string, endTime: string) => ({ id, title: id, date, startTime, endTime });
  const recordedAt = Date.UTC(2026, 9, 2, 14, 0, 0); // 14:00 UTC, 4 hours long
  const hours = 4 * 3600;

  it('lists the agenda shows that overlap the recording, in the order they start', () => {
    const shows = [show('late', '2026-10-02', '16:00', '18:00'), show('early', '2026-10-02', '14:00', '16:00'), show('other-day', '2026-10-03', '14:00', '16:00')];
    expect(showsDuringRecording(recordedAt, hours, shows).map((s) => s.id)).toEqual(['early', 'late']);
  });

  it('includes a show that only starts or ends inside the recording, and a night that crosses midnight', () => {
    const shows = [show('before', '2026-10-02', '12:00', '14:30'), show('after', '2026-10-02', '17:30', '20:00'), show('over-midnight', '2026-10-01', '23:00', '15:00')];
    // 'before' and 'over-midnight' are both already on air when the recording starts, so they tie.
    expect(showsDuringRecording(recordedAt, hours, shows).map((s) => s.id)).toEqual(['before', 'over-midnight', 'after']);
  });

  it('is empty when nothing overlaps, there is no duration yet, or a show has no usable times', () => {
    expect(showsDuringRecording(recordedAt, hours, [show('x', '2026-10-09', '14:00', '16:00')])).toEqual([]);
    expect(showsDuringRecording(recordedAt, 0, [show('x', '2026-10-02', '14:00', '16:00')])).toEqual([]);
    expect(showsDuringRecording(recordedAt, hours, [show('bad', '', '', '')])).toEqual([]);
  });

  it('degrades to an empty list, never an error, when the agenda data is missing or malformed', () => {
    expect(showsDuringRecording(recordedAt, hours, undefined)).toEqual([]);
    expect(showsDuringRecording(recordedAt, hours, null)).toEqual([]);
    expect(showsDuringRecording(recordedAt, hours, 'nope' as never)).toEqual([]);
    expect(showsDuringRecording(NaN, hours, [show('x', '2026-10-02', '14:00', '16:00')])).toEqual([]);
    const mixed = [null, undefined, { title: 'no id' }, show('ok', '2026-10-02', '14:00', '16:00')] as never[];
    expect(showsDuringRecording(recordedAt, hours, mixed).map((s) => (s as { id: string }).id)).toEqual(['ok']);
  });
});

describe('saved segments', () => {
  let n = 0;
  const newId = () => `id${++n}`;
  const rows: Draft[] = [
    { id: 'x', startS: 100, endS: 160, showId: 'b', frozen: true },
    { id: 'y', startS: 10, endS: 70, showId: null },
  ];

  it('saves without ids and without a false frozen flag', () => {
    expect(toDraftSegments(rows)).toEqual([
      { startS: 100, endS: 160, showId: 'b', frozen: true },
      { startS: 10, endS: 70, showId: null },
    ]);
    expect(toDraftSegments([{ id: 'z', startS: 1, endS: 2, showId: null, frozen: false }])).toEqual([{ startS: 1, endS: 2, showId: null }]);
  });

  it('round-trips, sorted by start, with fresh ids', () => {
    const back = fromDraftSegments(toDraftSegments(rows), newId, null);
    expect(back.map((s) => [s.startS, s.endS, s.showId, !!s.frozen])).toEqual([[10, 70, null, false], [100, 160, 'b', true]]);
    expect(new Set(back.map((s) => s.id)).size).toBe(2);
  });

  it('clears a show that is no longer to process, keeps the rest, and keeps all when the list is unknown', () => {
    const saved = toDraftSegments(rows);
    expect(fromDraftSegments(saved, newId, new Set(['other'])).map((s) => s.showId)).toEqual([null, null]);
    expect(fromDraftSegments(saved, newId, new Set(['b'])).map((s) => s.showId)).toEqual([null, 'b']);
    expect(fromDraftSegments(saved, newId, null).map((s) => s.showId)).toEqual([null, 'b']);
  });

  it('the key ignores ids and changes with anything the operator can edit', () => {
    const key = draftKey(rows);
    expect(draftKey(rows.map((r) => ({ ...r, id: `${r.id}2` })))).toBe(key);
    expect(draftKey([{ ...rows[0], endS: 161 }, rows[1]])).not.toBe(key);
    expect(draftKey([{ ...rows[0], frozen: false }, rows[1]])).not.toBe(key);
    expect(draftKey([rows[0], { ...rows[1], showId: 'c' }])).not.toBe(key);
    expect(draftKey([])).toBe('[]');
  });
});
