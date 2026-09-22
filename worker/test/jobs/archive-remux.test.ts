import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock every side effect: this exercises the branching around the remux, not
// ffmpeg or S3 themselves.
vi.mock('../../src/services/ffmpeg', async (importOriginal) => ({
  hms: (await importOriginal<typeof import('../../src/services/ffmpeg')>()).hms,
  extractAudio: vi.fn(async () => {}),
  remuxToMp4: vi.fn(async () => {}),
  trimVideoCopy: vi.fn(async () => {}),
  resolveTrim: vi.fn(async () => ({ trimStart: null, trimEnd: null })),
  measureLoudness: vi.fn(async () => null),
  probeDuration: vi.fn(async () => 3600),
  cleanup: vi.fn(),
}));

const MEASURED = {
  input_i: '-9.42',
  input_tp: '-0.21',
  input_lra: '6.30',
  input_thresh: '-19.68',
  target_offset: '0.01',
};

vi.mock('../../src/services/s3', () => ({
  downloadFromS3: vi.fn(async () => {}),
  uploadToS3: vi.fn(async () => {}),
  deleteFromS3: vi.fn(async () => {}),
  objectSize: vi.fn(async () => 1234),
}));

vi.mock('../../src/env', () => ({ env: { ARCHIVE_AUDIO_BITRATE: '256k', APP_PUBLIC_URL: 'https://uploader.test' } }));

// Agenda write-back is best-effort and asserted separately; stub it so these
// tests stay about the remux branching.
vi.mock('../../src/services/shows-api', () => ({ finalizeArchiveRecord: vi.fn(async () => {}) }));

vi.mock('../../src/db', () => ({
  setJobStatus: vi.fn(async () => {}),
  setAudioKey: vi.fn(async () => {}),
  setVideoKey: vi.fn(async () => {}),
  setVideoDuration: vi.fn(async () => {}),
  getPlatformJobsForUpload: vi.fn(async () => []),
  createArchiveJobRecord: vi.fn(async () => null),
  getUploadRow: vi.fn(async () => ({ show_id: 'show-1', jingle_s3_key: null })),
}));

vi.mock('../../src/queue', () => ({ uploadQueue: { add: vi.fn() }, previewQueue: { add: vi.fn() } }));

// Per-job scratch dir; paths stay predictable so the assertions below can name them.
vi.mock('../../src/services/workspace', () => ({
  createWorkspace: vi.fn(() => ({ path: (n: string) => `/tmp/${n}`, cleanup: vi.fn() })),
}));

import { remuxToMp4, trimVideoCopy, resolveTrim, measureLoudness, extractAudio } from '../../src/services/ffmpeg';
import { deleteFromS3, uploadToS3 } from '../../src/services/s3';
import { finalizeArchiveRecord } from '../../src/services/shows-api';
import { uploadQueue } from '../../src/queue';
import { getPlatformJobsForUpload } from '../../src/db';
import { processArchive } from '../../src/jobs/archive';

function makeJob(over: Record<string, unknown> = {}) {
  return {
    data: {
      jobId: 'job-1',
      uploadId: 'up-1',
      platform: 'archive',
      videoS3Key: 'uploads/rec.mkv',
      title: 't',
      description: 'd',
      tags: [],
      imageUrl: null,
      jingleS3Key: null,
      includeJingle: false,
      trimStart: null,
      trimEnd: null,
      ...over,
    },
    updateProgress: vi.fn(async () => {}),
  } as any;
}

describe('archive video remux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTrim).mockResolvedValue({ trimStart: null, trimEnd: null });
    vi.mocked(measureLoudness).mockResolvedValue(null);
  });

  it('remuxes an mkv source and deletes the original', async () => {
    await processArchive(makeJob());

    expect(vi.mocked(remuxToMp4)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trimVideoCopy)).not.toHaveBeenCalled();
    expect(vi.mocked(uploadToS3)).toHaveBeenCalledWith(expect.any(String), 'shows/rec/video.mp4', 'video/mp4');
    expect(vi.mocked(deleteFromS3)).toHaveBeenCalledWith('uploads/rec.mkv');
  });

  // The preview remux already produced this MP4, so there is nothing to rewrap.
  it('does no video work for an untrimmed mp4 source', async () => {
    await processArchive(makeJob({ videoS3Key: 'uploads/rec.mp4' }));

    expect(vi.mocked(remuxToMp4)).not.toHaveBeenCalled();
    expect(vi.mocked(trimVideoCopy)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteFromS3)).not.toHaveBeenCalled();
  });

  // Without this branch, pre-converting a recording for preview would silently
  // drop the operator's trim from the archived video.
  it('trims an already-mp4 source with a stream copy instead of skipping it', async () => {
    vi.mocked(resolveTrim).mockResolvedValue({ trimStart: '00:00:10', trimEnd: '01:00:00' });

    await processArchive(makeJob({ videoS3Key: 'uploads/rec.mp4', trimStart: '00:00:10', trimEnd: '01:00:00' }));

    // faststart matters: this writes a new container, and the archive is played
    // in the browser, so it has to stay progressively seekable.
    expect(vi.mocked(trimVideoCopy)).toHaveBeenCalledWith('/tmp/input.mp4', '/tmp/archive.mp4', {
      trimStart: '00:00:10',
      trimEnd: '01:00:00',
      faststart: true,
      loudness: null,
    });
    expect(vi.mocked(remuxToMp4)).not.toHaveBeenCalled();
    expect(vi.mocked(uploadToS3)).toHaveBeenCalledWith(expect.any(String), 'shows/rec/video.mp4', 'video/mp4');
  });

  describe('loudness normalisation', () => {
    beforeEach(() => vi.mocked(measureLoudness).mockResolvedValue(MEASURED as any));

    // One measurement, both artefacts: the downloadable audio and the archived
    // video have to sit at the same level, and measuring twice risks drift.
    it('measures once and applies it to both archives', async () => {
      await processArchive(makeJob());

      expect(vi.mocked(measureLoudness)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(extractAudio).mock.calls[0][2]).toMatchObject({ loudness: MEASURED });
      expect(vi.mocked(remuxToMp4).mock.calls[0][2]).toMatchObject({ loudness: MEASURED });
    });

    // Normalising is real work even when the container is already right, so the
    // "already mp4, nothing to do" shortcut must not swallow it.
    it('still processes an untrimmed mp4 source', async () => {
      await processArchive(makeJob({ videoS3Key: 'uploads/rec.mp4' }));

      expect(vi.mocked(trimVideoCopy)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(trimVideoCopy).mock.calls[0][2]).toMatchObject({ loudness: MEASURED });
    });

    // Measured over the published range: dead air at the edges shifts the
    // integrated figure, so measuring the untrimmed file targets the wrong thing.
    it('measures the trimmed range, not the whole recording', async () => {
      vi.mocked(resolveTrim).mockResolvedValue({ trimStart: '00:00:10', trimEnd: '01:00:00' });

      await processArchive(makeJob({ trimStart: '00:00:10', trimEnd: '01:00:00' }));

      expect(vi.mocked(measureLoudness)).toHaveBeenCalledWith('/tmp/input.mkv', {
        trimStart: '00:00:10',
        trimEnd: '01:00:00',
      });
    });

    // A failed measurement must not fail the publish.
    it('publishes unmodified when measurement fails', async () => {
      vi.mocked(measureLoudness).mockResolvedValue(null);

      await processArchive(makeJob());

      expect(vi.mocked(remuxToMp4).mock.calls[0][2]).toMatchObject({ loudness: null });
    });
  });


  describe('platform hand-off', () => {
    // The inversion's contract: platforms upload archive artefacts, so their
    // queued rows are started by the archive job, with the archived keys —
    // never the source key the archive was itself given.
    it('enqueues queued platform rows with the archived keys', async () => {
      vi.mocked(getPlatformJobsForUpload).mockResolvedValue([
        { id: 'yt-1', platform: 'youtube', status: 'queued', result_url: null },
        { id: 'mc-1', platform: 'mixcloud', status: 'queued', result_url: null },
        { id: 'done-1', platform: 'youtube', status: 'done', result_url: 'x' },
      ] as any);

      await processArchive(makeJob());

      const adds = vi.mocked(uploadQueue.add).mock.calls;
      expect(adds).toHaveLength(2);
      for (const [name, payload] of adds as any) {
        expect(['youtube', 'mixcloud']).toContain(name);
        expect(payload.videoS3Key).toBe('shows/rec/video.mp4');
        expect(payload.audioS3Key).toBe('shows/rec/audio.m4a');
        // Applied while archiving — a platform re-trimming would cut twice.
        expect(payload.trimStart).toBeNull();
        expect(payload.autoTrimSilence).toBe(false);
      }
    });

    it('enqueues nothing when no platform rows are queued', async () => {
      // clearAllMocks resets calls, not implementations — undo the previous
      // test's mockResolvedValue explicitly.
      vi.mocked(getPlatformJobsForUpload).mockResolvedValue([] as any);
      await processArchive(makeJob());
      expect(vi.mocked(uploadQueue.add)).not.toHaveBeenCalled();
    });
  });

  describe('agenda write-back', () => {
    // Permanent links, not presigned ones: PocketBase stores these forever and a
    // signed URL would be dead within hours. Keyed by the show's S3 folder —
    // which this job just wrote — so resolving one later needs no upload row.
    it('attaches stable recording links to the agenda record', async () => {
      await processArchive(makeJob());

      expect(vi.mocked(finalizeArchiveRecord)).toHaveBeenCalledWith('show-1', {
        mediaLinks: [
          { label: 'cs-archive-video', type: 'cs-archive-video', url: 'https://uploader.test/api/public/shows/rec/video' },
          { label: 'cs-archive-audio', type: 'cs-archive-audio', url: 'https://uploader.test/api/public/shows/rec/audio' },
        ],
      });
    });

    // The archive is already safely on S3 by this point, so a PocketBase outage
    // must not fail the job and trigger a retry of the whole transcode.
    it('does not fail the job when the write-back errors', async () => {
      vi.mocked(finalizeArchiveRecord).mockRejectedValueOnce(new Error('pocketbase down'));

      await expect(processArchive(makeJob())).resolves.toBeTruthy();
    });
  });

  // Re-archiving something already in the show layout must not nest it again
  // (shows/x/video.mp4 -> shows/video/video.mp4), and must not delete the file
  // it just wrote back over its own key.
  it('is idempotent for a source already in the show layout', async () => {
    vi.mocked(resolveTrim).mockResolvedValue({ trimStart: '00:00:10', trimEnd: null });

    await processArchive(makeJob({ videoS3Key: 'shows/rec/video.mp4', trimStart: '00:00:10' }));

    expect(vi.mocked(uploadToS3)).toHaveBeenCalledWith(
      expect.any(String),
      'shows/rec/video.mp4',
      'video/mp4'
    );
    expect(vi.mocked(deleteFromS3)).not.toHaveBeenCalled();
  });
});
