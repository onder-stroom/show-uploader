import { describe, expect, it } from 'vitest';
import { resolveSegment } from '../../src/upload/resolveSegment';

const staged = { s3_key: 'incoming/1-a.mp4', filename: 'a.mp4' };
const cut = (state: string, error: string | null = null) => ({ state, error }) as never;

describe('resolveSegment', () => {
  it('is a draft when nothing has been started and nothing is staged', () => {
    expect(resolveSegment({})).toEqual({ state: 'draft' });
    expect(resolveSegment({ cut: cut('unknown') })).toEqual({ state: 'draft' });
  });

  it('shows the cut\'s own progress while it runs', () => {
    expect(resolveSegment({ cut: cut('queued') })).toEqual({ state: 'queued' });
    expect(resolveSegment({ cut: cut('cutting') })).toEqual({ state: 'cutting' });
    expect(resolveSegment({ cut: cut('finishing') })).toEqual({ state: 'finishing' });
  });

  it('reports the real upload fraction from S3, or null when unknown', () => {
    expect(resolveSegment({ cut: cut('uploading'), uploadFraction: 0.4 })).toEqual({ state: 'uploading', fraction: 0.4 });
    expect(resolveSegment({ cut: cut('uploading') })).toEqual({ state: 'uploading', fraction: null });
  });

  it('is ready once the matching video is staged, even after the job has expired from the queue', () => {
    expect(resolveSegment({ cut: cut('done'), staged })).toEqual({ state: 'ready', filename: 'a.mp4' });
    expect(resolveSegment({ cut: cut('unknown'), staged })).toEqual({ state: 'ready', filename: 'a.mp4' });
  });

  it('a finished job whose video is not on the show says so, instead of "finishing" forever', () => {
    expect(resolveSegment({ cut: cut('done') })).toEqual({ state: 'unstaged', other: null });
  });

  it('and names the different video that is there, so a wrong match can be told from a missing one', () => {
    expect(resolveSegment({ cut: cut('done'), otherStaged: 'older.mp4' })).toEqual({ state: 'unstaged', other: 'older.mp4' });
    expect(resolveSegment({ cut: cut('done'), staged, otherStaged: 'a.mp4' })).toEqual({ state: 'ready', filename: 'a.mp4' });
  });

  it('a failed attempt is shown as failed with its reason, even if an older video is staged', () => {
    expect(resolveSegment({ cut: cut('failed', 'The recording was deleted from the PC'), staged })).toEqual({
      state: 'failed', message: 'The recording was deleted from the PC',
    });
    expect(resolveSegment({ cut: cut('failed') })).toEqual({ state: 'failed', message: 'The cut failed' });
  });

  it('an active cut wins over an older staged video that it is about to replace', () => {
    expect(resolveSegment({ cut: cut('cutting'), staged })).toEqual({ state: 'cutting' });
  });
});
