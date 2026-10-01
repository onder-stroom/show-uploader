import { describe, expect, it } from 'vitest';
import { agendaSlot, formatTimecode, parseTimecode } from '../../src/upload/segments';

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
