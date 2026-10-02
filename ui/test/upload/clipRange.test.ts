import { describe, expect, it } from 'vitest';
import { moveEnd, moveStart } from '../../src/upload/clipRange';

describe('moveStart', () => {
  it('moves the start normally when it stays before the end', () => {
    expect(moveStart({ start: 10, end: 30 }, 3600, 15)).toEqual({ start: 15, end: 30 });
  });

  it('slides the whole selection forward when dragged past the end, preserving length', () => {
    const result = moveStart({ start: 10, end: 30 }, 3600, 35);
    expect(result).toEqual({ start: 35, end: 55 });
    expect(result.end - result.start).toBe(20);
  });

  it('clamps the slide so the end never exceeds the video duration', () => {
    const result = moveStart({ start: 10, end: 30 }, 40, 35);
    expect(result).toEqual({ start: 20, end: 40 });
  });
});

describe('moveEnd', () => {
  it('moves the end normally when it stays after the start', () => {
    expect(moveEnd({ start: 10, end: 30 }, 3600, 25)).toEqual({ start: 10, end: 25 });
  });

  it('slides the whole selection backward when dragged before the start, preserving length', () => {
    const result = moveEnd({ start: 50, end: 70 }, 3600, 30);
    expect(result).toEqual({ start: 10, end: 30 });
    expect(result.end - result.start).toBe(20);
  });

  it('clamps the slide so the start never goes below 0', () => {
    const result = moveEnd({ start: 10, end: 30 }, 3600, -5);
    expect(result).toEqual({ start: 0, end: 20 });
  });
});
