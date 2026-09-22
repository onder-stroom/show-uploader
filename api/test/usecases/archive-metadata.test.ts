import { describe, it, expect } from 'vitest';
import { compressArchivedVideo, remuxBackfill } from '../../src/usecases/archive';
import { UseCaseError } from '../../src/usecases/errors';
import { updateMetadata } from '../../src/usecases/metadata';
import { fakeDeps, uploadRow } from '../fakes';

describe('compressArchivedVideo', () => {
  // Shrinking rewrites the object in place; a job still reading it would break.
  it('refuses while any job on the recording is still in flight', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({}, [{ platform: 'youtube', status: 'processing' }])] });

    const err = await compressArchivedVideo('show-1', deps).catch((e: UseCaseError) => e);

    expect((err as UseCaseError).code).toBe('PRECONDITION_FAILED');
    expect(deps.queued).toEqual([]);
  });

  it('refuses a recording that is not an archived mp4 yet', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({ video_s3_key: 'incoming/rec.mkv' })] });
    const err = await compressArchivedVideo('show-1', deps).catch((e: UseCaseError) => e);
    expect((err as UseCaseError).code).toBe('PRECONDITION_FAILED');
  });

  it('queues the shrink for an idle archived mp4', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({}, [{ platform: 'youtube', status: 'done' }])] });
    await compressArchivedVideo('show-1', deps);
    expect(deps.queued.map((q) => q.kind)).toEqual(['compress']);
  });
});

describe('remuxBackfill', () => {
  // The archive replaces the source; a platform still uploading it must finish first.
  it('only re-archives uploads whose platform work is done', async () => {
    const deps = fakeDeps({
      uploads: [
        uploadRow({ id: 'ready', video_s3_key: 'uploads/a.mkv' }, [{ platform: 'youtube', status: 'done' }]),
        uploadRow({ id: 'busy', video_s3_key: 'uploads/b.mkv' }, [{ platform: 'youtube', status: 'processing' }]),
      ],
    });

    await expect(remuxBackfill(deps)).resolves.toEqual({ enqueued: 1, skipped: 1 });
    expect(deps.queued).toEqual([{ kind: 'archive', payload: { uploadId: 'ready' } }]);
  });
});

describe('updateMetadata', () => {
  const published = () =>
    uploadRow({}, [
      { platform: 'youtube', status: 'done', result_url: 'https://youtu.be/x' },
      { platform: 'mixcloud', status: 'done', result_url: 'https://mixcloud.com/y/' },
    ]);
  const edit = { title: 'Palmbomen II 08.08.2026 @ coming soon', description: '<p>new</p>', tags: ['disco'] };

  it('reports each target separately; one failing platform does not stop the rest', async () => {
    const deps = fakeDeps({ uploads: [published()] });
    deps.platforms.syncMixcloud.mockResolvedValueOnce('token expired');

    const { sync } = await updateMetadata('up-1', edit, deps);

    expect(sync).toEqual({ youtube: 'ok', mixcloud: 'token expired', pocketbase: 'ok' });
    expect(deps.uploads.updateMetadata).toHaveBeenCalledWith('up-1', edit);
  });

  // PocketBase keeps the plain title; the date suffix is only for the platforms.
  it('writes the plain title, genre ids and platform links to the agenda', async () => {
    const deps = fakeDeps({ uploads: [published()] });

    await updateMetadata('up-1', edit, deps);

    expect(deps.agenda.update).toHaveBeenCalledWith('show-1', {
      title: 'Palmbomen II',
      notes: '<p>new</p>',
      genres: ['genre-disco'],
      mediaLinks: [
        { label: 'YouTube', type: 'video', url: 'https://youtu.be/x' },
        { label: 'MixCloud', type: 'audio', url: 'https://mixcloud.com/y/' },
      ],
    });
  });

  it('never wipes curated genres when the edit clears the tags', async () => {
    const deps = fakeDeps({ uploads: [published()] });
    await updateMetadata('up-1', { ...edit, tags: [] }, deps);
    expect(deps.agenda.update).toHaveBeenCalledWith('show-1', expect.not.objectContaining({ genres: expect.anything() }));
  });
});
