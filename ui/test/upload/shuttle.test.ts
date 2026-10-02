import { describe, expect, it } from 'vitest';
import { isControlTarget, MAX_RATE, nextShuttleRate, reverseStep, shuttleLabel } from '../../src/upload/shuttle';

describe('nextShuttleRate', () => {
  it('L plays forward at 1x, then adds half a step per press up to the cap', () => {
    let r = 0;
    const seen: number[] = [];
    for (let i = 0; i < 17; i++) seen.push((r = nextShuttleRate(r, 'l')));
    expect(seen.slice(0, 4)).toEqual([1, 1.5, 2, 2.5]);
    expect(seen[seen.length - 1]).toBe(MAX_RATE);
    expect(Math.max(...seen)).toBe(MAX_RATE);
  });

  it('J plays backwards the same way', () => {
    let r = 0;
    const seen: number[] = [];
    for (let i = 0; i < 17; i++) seen.push((r = nextShuttleRate(r, 'j')));
    expect(seen.slice(0, 4)).toEqual([-1, -1.5, -2, -2.5]);
    expect(seen[seen.length - 1]).toBe(-MAX_RATE);
  });

  it('the opposite key goes straight to 1x the other way', () => {
    expect(nextShuttleRate(3, 'j')).toBe(-1);
    expect(nextShuttleRate(-3, 'l')).toBe(1);
  });

  it('K pauses, and Space toggles between paused and 1x forward', () => {
    expect(nextShuttleRate(4, 'k')).toBe(0);
    expect(nextShuttleRate(-4, 'k')).toBe(0);
    expect(nextShuttleRate(0, 'space')).toBe(1);
    expect(nextShuttleRate(2.5, 'space')).toBe(0);
    expect(nextShuttleRate(-2, 'space')).toBe(0);
  });
});

describe('shuttleLabel', () => {
  it('names the state', () => {
    expect(shuttleLabel(0)).toBe('paused');
    expect(shuttleLabel(1)).toBe('▶ 1×');
    expect(shuttleLabel(2.5)).toBe('▶ 2.5×');
    expect(shuttleLabel(-1.5)).toBe('◀ 1.5×');
  });
});

describe('reverseStep', () => {
  it('moves the playhead back by rate times elapsed time', () => {
    expect(reverseStep(100, 0.5, -2)).toEqual({ time: 99, done: false });
  });

  it('stops at the start and never goes negative', () => {
    expect(reverseStep(0.4, 0.5, -2)).toEqual({ time: 0, done: true });
  });
});

describe('isControlTarget', () => {
  it('is false for no target, and follows what the element is inside of', () => {
    expect(isControlTarget(null)).toBe(false);
    expect(isControlTarget({ closest: () => null })).toBe(false);
    expect(isControlTarget({ closest: () => ({}) })).toBe(true);
  });
});
