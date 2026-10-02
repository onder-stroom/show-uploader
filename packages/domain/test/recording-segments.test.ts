import { describe, it, expect } from 'vitest';
import { validateSegments, suggestSegments, matchShowForSegment, MIN_SEGMENT_SECONDS } from '../src/recording-segments';

describe('validateSegments', () => {
  it('accepts ordered, non-overlapping segments inside the recording', () => {
    expect(validateSegments([{ startS: 0, endS: 3600 }, { startS: 3600, endS: 7200 }], 7200)).toEqual([]);
  });

  it('rejects an empty or reversed segment', () => {
    const problems = validateSegments([{ startS: 100, endS: 100 }, { startS: 500, endS: 400 }], 7200);
    expect(problems.map((p) => [p.index, p.code])).toEqual([[0, 'EMPTY'], [1, 'EMPTY']]);
  });

  it('rejects a segment shorter than the minimum', () => {
    const problems = validateSegments([{ startS: 0, endS: MIN_SEGMENT_SECONDS - 1 }], 7200);
    expect(problems[0].code).toBe('TOO_SHORT');
  });

  it('rejects negative starts and ends past the duration', () => {
    const problems = validateSegments([{ startS: -1, endS: 100 }, { startS: 7000, endS: 7300 }], 7200);
    expect(problems.map((p) => p.code)).toEqual(['OUT_OF_RANGE', 'OUT_OF_RANGE']);
  });

  it('rejects overlap regardless of input order and flags the later segment', () => {
    const problems = validateSegments([{ startS: 1000, endS: 2000 }, { startS: 0, endS: 1500 }], 7200);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 0, code: 'OVERLAP' });
  });

  it('allows segments that touch end-to-start', () => {
    expect(validateSegments([{ startS: 0, endS: 100 }, { startS: 100, endS: 200 }], 7200)).toEqual([]);
  });

  it('rejects a non-finite number', () => {
    expect(validateSegments([{ startS: 0, endS: Number.NaN }], 7200)[0].code).toBe('EMPTY');
  });
});

describe('suggestSegments / matchShowForSegment', () => {
  const t0 = Date.parse('2026-10-01T20:00:00Z');
  const slots = [
    { showId: 'a', startMs: t0, endMs: t0 + 3600_000 },
    { showId: 'b', startMs: t0 + 3600_000, endMs: t0 + 7200_000 },
  ];

  it('turns agenda slots into recording-relative segments', () => {
    expect(suggestSegments(t0, 7200, slots)).toEqual([
      { startS: 0, endS: 3600, showId: 'a' },
      { startS: 3600, endS: 7200, showId: 'b' },
    ]);
  });

  it('clamps a slot that starts before or ends after the recording', () => {
    const early = [{ showId: 'x', startMs: t0 - 600_000, endMs: t0 + 1800_000 }];
    expect(suggestSegments(t0, 3600, early)).toEqual([{ startS: 0, endS: 1800, showId: 'x' }]);
  });

  it('drops slots entirely outside the recording', () => {
    const outside = [{ showId: 'x', startMs: t0 + 9000_000, endMs: t0 + 9900_000 }];
    expect(suggestSegments(t0, 3600, outside)).toEqual([]);
  });

  it('matches a segment to the slot it overlaps most', () => {
    expect(matchShowForSegment(t0, { startS: 3000, endS: 5400 }, slots)).toBe('b');
  });

  it('returns null when nothing overlaps, so bad agenda times never force a match', () => {
    expect(matchShowForSegment(t0, { startS: 20000, endS: 21000 }, slots)).toBeNull();
  });
});
