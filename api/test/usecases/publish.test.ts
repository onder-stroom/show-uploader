import { describe, it, expect } from 'vitest';
import { UseCaseError } from '../../src/usecases/errors';
import { publishToPlatform, publishUpload, retryJob } from '../../src/usecases/publish';
import { fakeDeps, uploadRow } from '../fakes';

const input = {
  showId: 'show-1',
  title: 'Palmbomen II',
  description: '',
  tags: [],
  imageUrl: null,
  videoS3Key: 'incoming/1785-rec.mkv',
  platforms: ['youtube' as const, 'mixcloud' as const],
  includeJingle: true,
  autoTrimSilence: true,
};

async function refusal(p: Promise<unknown>): Promise<UseCaseError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UseCaseError);
  return err as UseCaseError;
}

describe('publishUpload', () => {
  // Publishing twice makes a second video/cloudcast someone has to take down by
  // hand, so the record's links win over whatever the form thought.
  it('refuses a platform the agenda record already links to', async () => {
    const deps = fakeDeps({
      shows: [{ id: 'show-1', mediaLinks: [{ label: 'Youtube', type: 'video', url: 'https://youtu.be/x' }] }],
    });

    const err = await refusal(publishUpload(input, deps));

    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('youtube');
    expect(deps.uploads.create).not.toHaveBeenCalled();
  });

  it('creates every job row but enqueues only the archive; it starts the platforms itself', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-1', mediaLinks: [] }], jingleS3Key: 'jingles/intro.m4a' });

    const result = await publishUpload(input, deps);

    expect(result.deferredUntil).toBeNull();
    expect(result.jobs.map((j) => j.platform)).toEqual(['youtube', 'mixcloud']);
    expect(deps.queued.map((q) => q.kind)).toEqual(['archive']);
    expect(deps.rows.get(result.uploadId)).toMatchObject({ jingle_s3_key: 'jingles/intro.m4a' });
    expect(deps.uploads.releaseClaim).toHaveBeenCalledWith('show-1');
    expect(deps.presence.broadcastClaims).toHaveBeenCalled();
  });

  it('passes the silence checkbox through to the archive job', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-1', mediaLinks: [] }] });

    await publishUpload({ ...input, autoTrimSilence: false }, deps);

    expect(deps.queued[0].payload).toMatchObject({ delay: 0, includeJingle: true, autoTrimSilence: false });
  });

  // Heavy work would starve the live stream of CPU and bandwidth.
  it('defers the archive while a show is on air', async () => {
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
    const deps = fakeDeps({ shows: [{ id: 'show-1', mediaLinks: [] }], live: { isLive: true, resumeAt } });

    const result = await publishUpload(input, deps);

    expect(result.deferredUntil).toBe(resumeAt.toISOString());
    expect((deps.queued[0].payload as { delay: number }).delay).toBeGreaterThan(0);
  });
});

describe('retryJob', () => {
  it('refuses a platform retry before the archive has finished', async () => {
    const deps = fakeDeps({
      uploads: [uploadRow({}, [{ platform: 'archive', status: 'failed' }, { platform: 'youtube', status: 'failed' }])],
    });

    expect((await refusal(retryJob('up-1', 'youtube', deps))).code).toBe('PRECONDITION_FAILED');
    expect(deps.queued).toEqual([]);
  });

  it('refuses a job that is still running', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({}, [{ platform: 'archive', status: 'processing' }])] });
    expect((await refusal(retryJob('up-1', 'archive', deps))).code).toBe('CONFLICT');
  });

  it('re-enqueues a platform on the archived artefacts, untrimmed', async () => {
    const deps = fakeDeps({
      uploads: [uploadRow({}, [{ platform: 'archive', status: 'done' }, { platform: 'youtube', status: 'failed' }])],
    });

    await retryJob('up-1', 'youtube', deps);

    expect(deps.rows.get('up-1')!.jobs[1].status).toBe('queued');
    expect(deps.queued[0]).toMatchObject({
      kind: 'youtube',
      payload: { videoS3Key: 'shows/2026-08-08-palmbomen-ii/video.mp4', trimStart: null, trimEnd: null },
    });
  });
});

describe('retryJob for the archive', () => {
  // A first archive that failed before finishing still points at the untrimmed
  // source; the retry has to apply the operator's trim, not skip it.
  it('re-runs an unfinished archive with the stored trim and silence detection', async () => {
    const deps = fakeDeps({
      uploads: [
        uploadRow(
          { video_s3_key: 'incoming/1785-rec.mkv', trim_start: '00:05:00', trim_end: '02:00:00', jingle_s3_key: 'jingles/intro.m4a' },
          [{ platform: 'archive', status: 'failed' }]
        ),
      ],
    });

    await retryJob('up-1', 'archive', deps);

    expect(deps.queue.enqueueArchive).toHaveBeenCalledWith(
      expect.objectContaining({ trim_start: '00:05:00', trim_end: '02:00:00' }),
      { includeJingle: true, autoTrimSilence: true }
    );
    expect(deps.queue.enqueuePlatform).not.toHaveBeenCalled();
  });

  it('does not cut an already archived recording again', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({}, [{ platform: 'archive', status: 'done' }])] });

    await retryJob('up-1', 'archive', deps);

    expect(deps.queue.enqueueArchive).toHaveBeenCalledWith(expect.anything(), {
      includeJingle: false,
      autoTrimSilence: false,
    });
  });

  it('reports a conflict when the archive is already queued to run', async () => {
    const deps = fakeDeps({ uploads: [uploadRow({}, [{ platform: 'archive', status: 'failed' }])] });
    deps.queue.enqueueArchive.mockResolvedValueOnce(false);

    expect((await refusal(retryJob('up-1', 'archive', deps))).code).toBe('CONFLICT');
  });
});

describe('publishToPlatform', () => {
  const show = { id: 'show-1', mediaLinks: [], date: '2026-08-08', imageUrl: null, title: 'Palmbomen II' };

  it('refuses mixcloud when the show has no archived audio', async () => {
    const deps = fakeDeps({ shows: [show], uploads: [uploadRow({ audio_s3_key: null })] });

    expect((await refusal(publishToPlatform('show-1', 'mixcloud', deps))).code).toBe('PRECONDITION_FAILED');
  });

  it('adds the platform title suffix and the configured jingle, reusing the old job row', async () => {
    const deps = fakeDeps({
      shows: [show],
      uploads: [uploadRow({}, [{ id: 'old-mc', platform: 'mixcloud', status: 'done' }])],
      jingleS3Key: 'jingles/intro.m4a',
    });

    const { jobId } = await publishToPlatform('show-1', 'mixcloud', deps);

    expect(jobId).toBe('old-mc');
    expect(deps.uploads.createJob).not.toHaveBeenCalled();
    expect(deps.queued[0].payload).toMatchObject({
      title: 'Palmbomen II 08.08.2026 @ coming soon',
      jingleS3Key: 'jingles/intro.m4a',
      includeJingle: true,
    });
  });

  // An archived show whose upload row was deleted gets one rebuilt from S3.
  it('adopts an archived show that has no upload row', async () => {
    const deps = fakeDeps({
      shows: [{ ...show, description: '', tags: [] }],
      folders: { 'show-1': 'shows/2026-08-08-palmbomen-ii/' },
      objects: ['shows/2026-08-08-palmbomen-ii/video.mp4', 'shows/2026-08-08-palmbomen-ii/audio.m4a'],
    });

    await publishToPlatform('show-1', 'youtube', deps);

    expect(deps.uploads.create).toHaveBeenCalledWith(
      expect.objectContaining({
        video_s3_key: 'shows/2026-08-08-palmbomen-ii/video.mp4',
        audio_s3_key: 'shows/2026-08-08-palmbomen-ii/audio.m4a',
      })
    );
    expect(deps.queued.map((q) => q.kind)).toEqual(['youtube']);
  });
});
