import { describe, it, expect } from 'vitest';
import { readyToArchive } from '../src/jobs';

describe('readyToArchive', () => {
  it('waits until every platform job is done', () => {
    expect(readyToArchive([{ platform: 'youtube', status: 'done' }, { platform: 'mixcloud', status: 'processing' }])).toBe(false);
    expect(readyToArchive([{ platform: 'youtube', status: 'done' }, { platform: 'mixcloud', status: 'done' }])).toBe(true);
  });

  it('ignores the archive job itself', () => {
    expect(readyToArchive([{ platform: 'archive', status: 'failed' }, { platform: 'youtube', status: 'done' }])).toBe(true);
  });

  it('is not ready with no platform jobs at all', () => {
    expect(readyToArchive([{ platform: 'archive', status: 'done' }])).toBe(false);
  });
});
