import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/env', () => ({ env: { JINGLE_S3_KEY: 'jingles/intro.m4a' } }));
vi.mock('../../src/db/client', () => ({ db: {} }));
vi.mock('../../src/db/queries', () => ({
  createUpload: vi.fn(),
  createPlatformJob: vi.fn(),
  deleteStagedUpload: vi.fn(async () => {}),
  getUploadWithJobs: vi.fn(),
  releaseClaimForShow: vi.fn(async () => {}),
  resetPlatformJobForRetry: vi.fn(async () => {}),
}));
vi.mock('../../src/queue', () => ({ uploadQueue: { add: vi.fn() } }));
vi.mock('../../src/services/archive-jobs', () => ({ enqueueArchiveJob: vi.fn(async () => true) }));
vi.mock('../../src/services/live-guard', () => ({ getLiveState: vi.fn(async () => ({ isLive: false })) }));
vi.mock('../../src/services/presence-hub', () => ({ presenceHub: { broadcastClaims: vi.fn() } }));
vi.mock('../../src/services/shows-api', () => ({
  getArchiveShow: vi.fn(),
  platformOfLabel: (label: string) => (label === 'YouTube' ? 'youtube' : label === 'MixCloud' ? 'mixcloud' : null),
}));
vi.mock('../../src/usecases/archive', () => ({ adoptArchivedUpload: vi.fn() }));

import { createUpload, getUploadWithJobs, resetPlatformJobForRetry } from '../../src/db/queries';
import { uploadQueue } from '../../src/queue';
import { enqueueArchiveJob } from '../../src/services/archive-jobs';
import { getArchiveShow } from '../../src/services/shows-api';
import { adoptArchivedUpload } from '../../src/usecases/archive';
import { UseCaseError } from '../../src/usecases/errors';
import { publishToPlatform, publishUpload, retryJob } from '../../src/usecases/publish';

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

const upload = (jobs: { platform: string; status: string }[]) => ({
  id: 'up-1',
  show_id: 'show-1',
  title: 'Palmbomen II',
  description: null,
  tags: null,
  image_url: null,
  video_s3_key: 'shows/2026-08-08-palmbomen-ii/video.mp4',
  audio_s3_key: 'shows/2026-08-08-palmbomen-ii/audio.m4a',
  jingle_s3_key: null,
  jobs: jobs.map((j, i) => ({ id: `job-${i}`, result_url: null, ...j })),
});

async function refusal(p: Promise<unknown>): Promise<UseCaseError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UseCaseError);
  return err as UseCaseError;
}

describe('publishUpload', () => {
  beforeEach(() => vi.clearAllMocks());

  // Publishing twice makes a second video/cloudcast someone has to take down by
  // hand, so the record's links win over whatever the form thought.
  it('refuses a platform the agenda record already links to', async () => {
    vi.mocked(getArchiveShow).mockResolvedValue({
      mediaLinks: [{ label: 'YouTube', type: 'video', url: 'https://youtu.be/x' }],
    } as never);

    const err = await refusal(publishUpload(input));

    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('youtube');
    expect(vi.mocked(createUpload)).not.toHaveBeenCalled();
  });

  it('passes the silence checkbox through to the archive job', async () => {
    vi.mocked(getArchiveShow).mockResolvedValue({ mediaLinks: [] } as never);
    vi.mocked(createUpload).mockResolvedValue({ id: 'up-1' } as never);

    await publishUpload({ ...input, autoTrimSilence: false });

    expect(vi.mocked(enqueueArchiveJob)).toHaveBeenCalledWith({}, expect.anything(), {
      delay: 0,
      includeJingle: true,
      autoTrimSilence: false,
    });
  });

  it('enqueues only the archive job; it starts the platforms itself', async () => {
    vi.mocked(getArchiveShow).mockResolvedValue({ mediaLinks: [] } as never);
    vi.mocked(createUpload).mockResolvedValue({ id: 'up-1' } as never);

    const result = await publishUpload(input);

    expect(result).toMatchObject({ uploadId: 'up-1', deferredUntil: null });
    expect(vi.mocked(enqueueArchiveJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadQueue.add)).not.toHaveBeenCalled();
  });
});

describe('retryJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a platform retry before the archive has finished', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue(
      upload([
        { platform: 'archive', status: 'failed' },
        { platform: 'youtube', status: 'failed' },
      ]) as never
    );

    const err = await refusal(retryJob('up-1', 'youtube'));

    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(vi.mocked(uploadQueue.add)).not.toHaveBeenCalled();
  });

  it('refuses a job that is still running', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue(upload([{ platform: 'archive', status: 'processing' }]) as never);
    expect((await refusal(retryJob('up-1', 'archive'))).code).toBe('CONFLICT');
  });

  it('re-enqueues a platform on the archived artefacts, untrimmed', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue(
      upload([
        { platform: 'archive', status: 'done' },
        { platform: 'youtube', status: 'failed' },
      ]) as never
    );

    await retryJob('up-1', 'youtube');

    expect(vi.mocked(resetPlatformJobForRetry)).toHaveBeenCalledWith({}, 'job-1');
    expect(vi.mocked(uploadQueue.add)).toHaveBeenCalledWith(
      'youtube',
      expect.objectContaining({
        videoS3Key: 'shows/2026-08-08-palmbomen-ii/video.mp4',
        trimStart: null,
        trimEnd: null,
      })
    );
  });
});

describe('retryJob for the archive', () => {
  beforeEach(() => vi.clearAllMocks());

  // A first archive that failed before finishing still points at the untrimmed
  // source; the retry has to apply the operator's trim, not skip it.
  it('re-runs an unfinished archive with the stored trim and silence detection', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue({
      ...upload([{ platform: 'archive', status: 'failed' }]),
      video_s3_key: 'incoming/1785-rec.mkv',
      trim_start: '00:05:00',
      trim_end: '02:00:00',
      jingle_s3_key: 'jingles/intro.m4a',
    } as never);

    await retryJob('up-1', 'archive');

    expect(vi.mocked(enqueueArchiveJob)).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ trim_start: '00:05:00', trim_end: '02:00:00' }),
      { includeJingle: true, autoTrimSilence: true }
    );
    expect(vi.mocked(uploadQueue.add)).not.toHaveBeenCalled();
  });

  it('does not cut an already archived recording again', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue(upload([{ platform: 'archive', status: 'done' }]) as never);

    await retryJob('up-1', 'archive');

    expect(vi.mocked(enqueueArchiveJob)).toHaveBeenCalledWith({}, expect.anything(), {
      includeJingle: false,
      autoTrimSilence: false,
    });
  });

  it('reports a conflict when the archive is already queued to run', async () => {
    vi.mocked(getUploadWithJobs).mockResolvedValue(upload([{ platform: 'archive', status: 'failed' }]) as never);
    vi.mocked(enqueueArchiveJob).mockResolvedValueOnce(false);

    expect((await refusal(retryJob('up-1', 'archive'))).code).toBe('CONFLICT');
  });
});

describe('publishToPlatform', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses mixcloud when the show has no archived audio', async () => {
    vi.mocked(getArchiveShow).mockResolvedValue({ mediaLinks: [], date: '2026-08-08' } as never);
    vi.mocked(adoptArchivedUpload).mockResolvedValue({ ...upload([]), audio_s3_key: null } as never);

    expect((await refusal(publishToPlatform('show-1', 'mixcloud'))).code).toBe('PRECONDITION_FAILED');
  });

  it('adds the platform title suffix and the configured jingle', async () => {
    vi.mocked(getArchiveShow).mockResolvedValue({ mediaLinks: [], date: '2026-08-08', imageUrl: null } as never);
    vi.mocked(adoptArchivedUpload).mockResolvedValue(upload([{ platform: 'mixcloud', status: 'done' }]) as never);

    await publishToPlatform('show-1', 'mixcloud');

    expect(vi.mocked(uploadQueue.add)).toHaveBeenCalledWith(
      'mixcloud',
      expect.objectContaining({
        title: 'Palmbomen II 08.08.2026 @ coming soon',
        jingleS3Key: 'jingles/intro.m4a',
        includeJingle: true,
      })
    );
  });
});
