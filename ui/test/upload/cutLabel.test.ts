import { describe, expect, it } from 'vitest';
import { cutLabel, isRunning, runningCuts, type CutItem } from '../../src/upload/cutLabel';

const cut = (over: Partial<CutItem> = {}): CutItem => ({
  cutId: 'c', ref: 'r1', showId: 's', startS: 0, endS: 60, filename: 'f.mp4', createdAtMs: 1, state: 'queued', error: null, ...over,
});

describe('cutLabel', () => {
  it('says plainly where a cut is', () => {
    expect(cutLabel(cut({ state: 'queued' }), null)).toMatch(/waiting its turn/);
    expect(cutLabel(cut({ state: 'cutting' }), null)).toBe('cutting on the PC…');
    expect(cutLabel(cut({ state: 'uploading' }), null)).toBe('uploading…');
    expect(cutLabel(cut({ state: 'uploading' }), 0.426)).toBe('uploading 43%');
    expect(cutLabel(cut({ state: 'finishing' }), null)).toBe('finishing…');
    expect(cutLabel(cut({ state: 'done' }), null)).toMatch(/ready to publish/);
  });

  it('carries the reason a cut failed, with a fallback', () => {
    expect(cutLabel(cut({ state: 'failed', error: 'PC unreachable' }), null)).toBe('failed: PC unreachable');
    expect(cutLabel(cut({ state: 'failed', error: null }), null)).toMatch(/did not finish/);
    expect(cutLabel(cut({ state: 'unknown' }), null)).toBe('');
  });
});

describe('runningCuts', () => {
  const list = [cut({ state: 'queued' }), cut({ state: 'uploading' }), cut({ state: 'done' }), cut({ state: 'failed' }), cut({ ref: 'r2', state: 'cutting' })];

  it('counts only the unfinished cuts of that recording', () => {
    expect(runningCuts(list, 'r1')).toBe(2);
    expect(runningCuts(list, 'r2')).toBe(1);
    expect(runningCuts(list, 'nope')).toBe(0);
    expect(runningCuts(undefined, 'r1')).toBe(0);
  });

  it('done and failed are not running', () => {
    expect(isRunning(cut({ state: 'done' }))).toBe(false);
    expect(isRunning(cut({ state: 'failed' }))).toBe(false);
    expect(isRunning(cut({ state: 'finishing' }))).toBe(true);
  });
});
