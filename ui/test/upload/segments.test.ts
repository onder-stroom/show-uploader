import { describe, expect, it } from 'vitest';
import { agendaSlot, editorNote, formatTimecode, newSegmentAt, parseTimecode, selectAfterRemove, type Draft } from '../../src/upload/segments';

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
