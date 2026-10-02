import { describe, it, expect } from 'vitest';
import { cutFilename, isTerminalCutState } from '../src/recordings-contract';

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
