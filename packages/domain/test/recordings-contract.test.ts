import { describe, it, expect } from 'vitest';
import { cutFilename, isTerminalCutState, MAX_DRAFT_SEGMENTS, parseDraftSegments } from '../src/recordings-contract';

describe('isTerminalCutState', () => {
  it('treats done, failed and source_gone as final, the rest as in flight', () => {
    expect(['done', 'failed', 'source_gone'].every((s) => isTerminalCutState(s as never))).toBe(true);
    expect(['cutting', 'cut', 'uploading'].some((s) => isTerminalCutState(s as never))).toBe(false);
  });
});

describe('cutFilename', () => {
  it('keeps the recording identity and adds the in/out so two cuts never collide', () => {
    expect(cutFilename('2026-10-01_20-00-00.mkv', 3600, 7260)).toBe('2026-10-01_20-00-00__1h00m00s-2h01m00s.mp4');
  });

  it('drops any extension and unsafe characters', () => {
    expect(cutFilename('night one.mp4', 0, 90)).toBe('night_one__0h00m00s-0h01m30s.mp4');
  });
});

describe('parseDraftSegments', () => {
  const ok = { startS: 10, endS: 70.5, showId: 'abc123', frozen: true };

  it('keeps well-formed segments, in order, dropping unknown keys and a false frozen flag', () => {
    expect(parseDraftSegments([ok, { startS: 0, endS: 5, showId: null, frozen: false, extra: 'x' }])).toEqual([
      { startS: 10, endS: 70.5, showId: 'abc123', frozen: true },
      { startS: 0, endS: 5, showId: null },
    ]);
    expect(parseDraftSegments([])).toEqual([]);
  });

  it('lets work in progress through: overlaps, an end before the start, no show chosen', () => {
    expect(parseDraftSegments([{ startS: 50, endS: 20, showId: null }, { startS: 10, endS: 60, showId: null }])).toHaveLength(2);
  });

  it('refuses anything that is not the right shape, wholesale', () => {
    for (const bad of [
      null, 'x', {}, [null], [1], [{}], [{ ...ok, startS: -1 }], [{ ...ok, endS: NaN }], [{ ...ok, startS: Infinity }],
      [{ ...ok, startS: '1' }], [{ ...ok, showId: 5 }], [{ ...ok, showId: '' }], [{ ...ok, showId: 'x'.repeat(65) }],
      [{ ...ok, frozen: 'yes' }], [{ ...ok, endS: 8 * 24 * 3600 }], [ok, { startS: 1 }],
    ]) expect(parseDraftSegments(bad), JSON.stringify(bad)).toBeNull();
  });

  it('caps how many segments a night may hold', () => {
    expect(parseDraftSegments(Array.from({ length: MAX_DRAFT_SEGMENTS }, () => ok))).toHaveLength(MAX_DRAFT_SEGMENTS);
    expect(parseDraftSegments(Array.from({ length: MAX_DRAFT_SEGMENTS + 1 }, () => ok))).toBeNull();
  });
});
