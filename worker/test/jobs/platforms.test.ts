import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let workDir: string;

vi.mock('../../src/env', () => ({ env: { ARCHIVE_AUDIO_BITRATE: '256k' } }));
vi.mock('../../src/services/workspace', () => ({
  createWorkspace: vi.fn(() => ({ path: (n: string) => path.join(workDir, n), cleanup: vi.fn() })),
}));
vi.mock('../../src/services/ffmpeg', () => ({
  measureLoudness: vi.fn(async () => null),
  prependJingle: vi.fn(async (_jingle: string, _audio: string, out: string) => {
    fs.writeFileSync(out, 'jingle+show');
  }),
  captureSquareFrame: vi.fn(async (_video: string, out: string) => {
    fs.writeFileSync(out, 'frame');
  }),
}));

import { captureSquareFrame, prependJingle } from '../../src/services/ffmpeg';
import { processMixcloud } from '../../src/jobs/mixcloud';
import { processYoutube } from '../../src/jobs/youtube';
import type { JobPayload } from '../../src/types';
import { fakeDeps, fakeJob } from '../fakes';

const VIDEO = 'shows/2026-08-08-palmbomen-ii/video.mp4';
const AUDIO = 'shows/2026-08-08-palmbomen-ii/audio.m4a';
const JINGLE = 'jingles/intro.m4a';

const payload = (over: Partial<JobPayload> = {}): JobPayload => ({
  jobId: 'job-1',
  uploadId: 'up-1',
  platform: 'youtube',
  videoS3Key: VIDEO,
  audioS3Key: AUDIO,
  title: 'Palmbomen II 08.08.2026 @ coming soon',
  description: '<p>Two hours of <b>boogie</b></p>',
  tags: ['disco'],
  imageUrl: null,
  jingleS3Key: null,
  includeJingle: false,
  trimStart: null,
  trimEnd: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-test-'));
});
afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('youtube job', () => {
  it('uploads the archived video as plain text and writes the link back', async () => {
    const deps = fakeDeps({ objects: { [VIDEO]: 10 } });

    await processYoutube(fakeJob(payload()), deps);

    expect(deps.youtube.upload).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Two hours of boogie', tags: ['disco'] })
    );
    expect(deps.finalStatus()).toBe('done');
    // The agenda keeps the plain title and the rich-text notes; only the
    // platform title carries the date suffix.
    expect(deps.agenda.finalize).toHaveBeenCalledWith('show-1', {
      title: 'Palmbomen II',
      notes: '<p>Two hours of <b>boogie</b></p>',
      tags: ['disco'],
      mediaLinks: [{ label: 'YouTube', type: 'video', url: 'https://youtu.be/new' }],
    });
  });

  it('marks the job failed and writes nothing back when the upload fails', async () => {
    const deps = fakeDeps({ objects: { [VIDEO]: 10 } });
    deps.youtube.upload.mockRejectedValueOnce(new Error('quotaExceeded'));

    await expect(processYoutube(fakeJob(payload()), deps)).rejects.toThrow('quotaExceeded');

    expect(deps.finalStatus()).toBe('failed');
    expect(deps.agenda.finalize).not.toHaveBeenCalled();
  });
});

describe('mixcloud job', () => {
  const mixcloud = (over: Partial<JobPayload> = {}) => payload({ platform: 'mixcloud', ...over });

  it('refuses to run without archived audio', async () => {
    const deps = fakeDeps();

    await expect(processMixcloud(fakeJob(mixcloud({ audioS3Key: null })), deps)).rejects.toThrow(/archive job first/);

    expect(deps.finalStatus()).toBe('failed');
    expect(deps.mixcloud.upload).not.toHaveBeenCalled();
  });

  it('prepends the jingle when asked and one is configured', async () => {
    const deps = fakeDeps({ objects: { [AUDIO]: 10, [VIDEO]: 10, [JINGLE]: 5 } });

    await processMixcloud(fakeJob(mixcloud({ jingleS3Key: JINGLE, includeJingle: true })), deps);

    expect(vi.mocked(prependJingle)).toHaveBeenCalledOnce();
    expect(deps.mixcloud.upload).toHaveBeenCalledWith(
      expect.objectContaining({ audioPath: path.join(workDir, 'merged.m4a') })
    );
  });

  // A missing jingle is a config slip, not a reason to hold back the show.
  it('publishes without the jingle when it cannot be fetched', async () => {
    const deps = fakeDeps({ objects: { [AUDIO]: 10, [VIDEO]: 10 } });

    await processMixcloud(fakeJob(mixcloud({ jingleS3Key: JINGLE, includeJingle: true })), deps);

    expect(vi.mocked(prependJingle)).not.toHaveBeenCalled();
    expect(deps.mixcloud.upload).toHaveBeenCalledWith(
      expect.objectContaining({ audioPath: path.join(workDir, 'audio.m4a') })
    );
    expect(deps.finalStatus()).toBe('done');
  });

  it('uses the agenda cover and skips the frame grab', async () => {
    const deps = fakeDeps({ objects: { [AUDIO]: 10 }, cover: Buffer.from('cover') });

    await processMixcloud(fakeJob(mixcloud({ imageUrl: 'https://agenda.test/cover.jpg' })), deps);

    expect(deps.agenda.fetchCover).toHaveBeenCalledWith('https://agenda.test/cover.jpg');
    expect(vi.mocked(captureSquareFrame)).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(workDir, 'cover.jpg'), 'utf8')).toBe('cover');
  });

  it('falls back to a video frame when the agenda cover is unavailable', async () => {
    const deps = fakeDeps({ objects: { [AUDIO]: 10, [VIDEO]: 10 }, cover: null });

    await processMixcloud(fakeJob(mixcloud({ imageUrl: 'https://agenda.test/cover.jpg' })), deps);

    expect(vi.mocked(captureSquareFrame)).toHaveBeenCalledOnce();
    expect(deps.mixcloud.upload).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: path.join(workDir, 'cover.jpg') })
    );
  });

  it('writes the MixCloud link back to the agenda', async () => {
    const deps = fakeDeps({ objects: { [AUDIO]: 10, [VIDEO]: 10 } });

    await processMixcloud(fakeJob(mixcloud()), deps);

    expect(deps.agenda.finalize).toHaveBeenCalledWith(
      'show-1',
      expect.objectContaining({
        mediaLinks: [{ label: 'MixCloud', type: 'audio', url: 'https://www.mixcloud.com/coming_soon/new/' }],
      })
    );
  });
});
