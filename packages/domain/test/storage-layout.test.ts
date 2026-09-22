import { describe, it, expect } from 'vitest';
import {
  baseName,
  incomingKey,
  showVideoKey,
  showAudioKey,
  planMigration,
} from '../src/storage-layout';

describe('key construction', () => {
  it('keeps the timestamped basename', () => {
    expect(baseName('uploads/1785677613218-obs-2026-07-31.mkv')).toBe('1785677613218-obs-2026-07-31');
  });

  it('handles a name containing dots', () => {
    expect(baseName('uploads/1785-show 8.8.2026 coming soon.mkv')).toBe('1785-show 8.8.2026 coming soon');
  });

  it('handles a key with no extension', () => {
    expect(baseName('uploads/recording')).toBe('recording');
  });

  it('sanitises filenames into incoming keys', () => {
    expect(incomingKey('obs recording (final).mkv')).toMatch(/^incoming\/\d+-obs_recording__final_\.mkv$/);
  });

  it('groups a published show video and audio in one folder', () => {
    const src = 'uploads/1785-rec.mp4';
    expect(showVideoKey(src)).toBe('shows/1785-rec/video.mp4');
    expect(showAudioKey(src)).toBe('shows/1785-rec/audio.m4a');
  });

  it('preserves a non-mp4 container on the video key', () => {
    expect(showVideoKey('uploads/1785-rec.mkv')).toBe('shows/1785-rec/video.mkv');
  });
});

describe('planMigration', () => {
  it('moves a published pair into one show folder', () => {
    const moves = planMigration({
      published: [{ videoKey: 'uploads/1785-rec.mp4', audioKey: 'archive/1785-rec.m4a' }],
      pendingKeys: [],
      stagedKeys: [],
    });

    expect(moves).toEqual([
      { from: 'uploads/1785-rec.mp4', to: 'shows/1785-rec/video.mp4', field: 'video_s3_key', reason: 'published master' },
      { from: 'archive/1785-rec.m4a', to: 'shows/1785-rec/audio.m4a', field: 'audio_s3_key', reason: 'published audio' },
    ]);
  });

  // The m4a sits under archive/ with no show grouping of its own, so its
  // destination has to be derived from the video it belongs to.
  it('files audio under its video folder even when the basenames differ', () => {
    const moves = planMigration({
      published: [{ videoKey: 'uploads/1785-rec.mp4', audioKey: 'archive/something-else.m4a' }],
      pendingKeys: [],
      stagedKeys: [],
    });

    expect(moves[1].to).toBe('shows/1785-rec/audio.m4a');
  });

  it('moves unpublished recordings to incoming, keeping the filename', () => {
    const moves = planMigration({
      published: [],
      pendingKeys: ['uploads/1785-drop.mkv'],
      stagedKeys: ['uploads/1786-staged.mkv'],
    });

    expect(moves).toEqual([
      { from: 'uploads/1785-drop.mkv', to: 'incoming/1785-drop.mkv', field: 'pending_s3_key', reason: 'awaiting publication' },
      { from: 'uploads/1786-staged.mkv', to: 'incoming/1786-staged.mkv', field: 'staged_s3_key', reason: 'uploaded, not yet published' },
    ]);
  });

  // Re-running must not produce a second round of churn.
  it('is a no-op for objects already in the right place', () => {
    const moves = planMigration({
      published: [{ videoKey: 'shows/1785-rec/video.mp4', audioKey: 'shows/1785-rec/audio.m4a' }],
      pendingKeys: ['incoming/1785-drop.mkv'],
      stagedKeys: [],
    });

    expect(moves).toEqual([]);
  });

  it('never plans the same source object twice', () => {
    const moves = planMigration({
      published: [],
      // The same recording can be both a pending drop and the staged pick.
      pendingKeys: ['uploads/1785-rec.mkv'],
      stagedKeys: ['uploads/1785-rec.mkv'],
    });

    expect(moves).toHaveLength(1);
  });

  // The first migration filed folders under the raw filename. Re-running now
  // renames them to the readable slug, in place.
  it('renames an already-migrated show folder to the readable slug', () => {
    const moves = planMigration({
      published: [
        {
          videoKey: 'shows/1783776608000-misharog_10.07.2026__coming_soon__2026-07-10_15-52-25/video.mp4',
          audioKey: 'shows/1783776608000-misharog_10.07.2026__coming_soon__2026-07-10_15-52-25/audio.m4a',
        },
      ],
      pendingKeys: [],
      stagedKeys: [],
    });

    expect(moves.map((m) => m.to)).toEqual([
      'shows/2026-07-10-misharog/video.mp4',
      'shows/2026-07-10-misharog/audio.m4a',
    ]);
  });

  // Both artefacts must land in the SAME folder, including when a collision
  // suffix is applied — otherwise a show's audio ends up beside another show.
  it('keeps video and audio together when two shows slug alike', () => {
    const moves = planMigration({
      published: [
        { videoKey: 'uploads/1783776608000-mills_17.07.2026__coming_soon__2026-07-17_18-00-31.mp4', audioKey: 'archive/a.m4a' },
        { videoKey: 'uploads/1784493571380-mills_17.07.2026__coming_soon__2026-07-17_18-00-31.mp4', audioKey: 'archive/b.m4a' },
      ],
      pendingKeys: [],
      stagedKeys: [],
    });

    expect(moves.map((m) => m.to)).toEqual([
      'shows/2026-07-17-mills/video.mp4',
      'shows/2026-07-17-mills/audio.m4a',
      'shows/2026-07-17-mills-2/video.mp4',
      'shows/2026-07-17-mills-2/audio.m4a',
    ]);
  });

  it('handles a published upload whose audio archive is missing', () => {
    const moves = planMigration({
      published: [{ videoKey: 'uploads/1785-rec.mp4', audioKey: null }],
      pendingKeys: [],
      stagedKeys: [],
    });

    expect(moves).toHaveLength(1);
    expect(moves[0].field).toBe('video_s3_key');
  });
});
