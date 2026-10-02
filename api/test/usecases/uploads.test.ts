// api/test/usecases/uploads.test.ts
import { describe, it, expect } from 'vitest';
import { UseCaseError } from '../../src/usecases/errors';
import { PART_SIZE, abortUpload, completeUpload, openUploadSession } from '../../src/usecases/uploads';
import { fakeDeps } from '../fakes';

const open = { filename: 'night one.mkv', contentType: 'video/x-matroska', size: 40 * 1024 * 1024, showId: 'show-1' };

describe('openUploadSession', () => {
  it('starts the S3 upload, binds the session to its show and reports the part count', async () => {
    const deps = fakeDeps();
    const out = await openUploadSession(open, deps);

    expect(out.partSize).toBe(PART_SIZE);
    expect(out.partCount).toBe(3);
    expect(out.key).toMatch(/^incoming\/\d+-night_one\.mkv$/);
    expect(deps.sessionRows.get(out.sessionId)).toMatchObject({ show_id: 'show-1', status: 'in_progress', s3_upload_id: 'mpu-1' });
  });

  it('records which cut a session came from', async () => {
    const deps = fakeDeps();
    const cut = { cutId: 'c1', ref: 'r1', startS: 10, endS: 20 };
    const out = await openUploadSession({ ...open, cut }, deps);
    expect(deps.sessionRows.get(out.sessionId)?.cut_id).toBe('c1');
  });

  it('an empty file still needs one part', async () => {
    expect((await openUploadSession({ ...open, size: 1 }, fakeDeps())).partCount).toBe(1);
  });

  it('abandons the S3 upload when the session row cannot be saved, so no orphan accrues', async () => {
    const deps = fakeDeps();
    deps.sessions.create.mockRejectedValueOnce(new Error('db down'));
    await expect(openUploadSession(open, deps)).rejects.toThrow('db down');
    expect(deps.objects.abortMultipart).toHaveBeenCalledWith(expect.stringMatching(/^incoming\//), 'mpu-1');
  });
});

describe('completeUpload', () => {
  it('completes the S3 object, marks the session and stages the video for its show', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);

    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });

    expect(deps.objects.completeMultipart).toHaveBeenCalledWith(key, 'mpu-1');
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
    expect(deps.staged.get('show-1')).toEqual({ key, filename: 'night one.mkv', size: open.size });
  });

  it('stages nothing for a session with no show', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession({ ...open, showId: null }, deps);
    await completeUpload(sessionId, deps);
    expect(deps.sessions.stage).not.toHaveBeenCalled();
  });

  it('is idempotent: completing a finished session answers with its key and does no more work', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    await completeUpload(sessionId, deps);
    deps.objects.completeMultipart.mockClear();

    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });
    expect(deps.objects.completeMultipart).not.toHaveBeenCalled();
  });

  it('refuses an unknown session', async () => {
    const err = await completeUpload('nope', fakeDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UseCaseError);
    expect((err as UseCaseError).code).toBe('NOT_FOUND');
  });

  it('a failed S3 completion leaves the session open and stages nothing', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    deps.objects.completeMultipart.mockRejectedValueOnce(new Error('s3 down'));

    await expect(completeUpload(sessionId, deps)).rejects.toThrow('s3 down');

    expect(deps.sessionRows.get(sessionId)?.status).toBe('in_progress');
    expect(deps.staged.size).toBe(0);
  });
});

describe('completeUpload verification and ordering', () => {
  const full = (n: number) => ({ Size: PART_SIZE, PartNumber: n });

  it('refuses a gapped part list and neither completes nor stages', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps); // 40 MiB = 3 parts
    deps.objects.uploadedParts.mockResolvedValueOnce([full(1), full(3), { Size: 8 * 1024 * 1024, PartNumber: 4 }]);
    const err = await completeUpload(sessionId, deps).catch((e: unknown) => e);
    expect((err as UseCaseError).code).toBe('PRECONDITION_FAILED');
    expect(deps.objects.completeMultipart).not.toHaveBeenCalled();
    expect(deps.staged.size).toBe(0);
    expect(deps.sessionRows.get(sessionId)?.status).toBe('in_progress');
  });

  it('refuses a short total and neither completes nor stages', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    deps.objects.uploadedParts.mockResolvedValueOnce([full(1), full(2), { Size: 1, PartNumber: 3 }]);
    const err = await completeUpload(sessionId, deps).catch((e: unknown) => e);
    expect((err as UseCaseError).code).toBe('PRECONDITION_FAILED');
    expect(deps.objects.completeMultipart).not.toHaveBeenCalled();
    expect(deps.staged.size).toBe(0);
  });

  it('refuses a missing last part', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    deps.objects.uploadedParts.mockResolvedValueOnce([full(1), full(2)]);
    await expect(completeUpload(sessionId, deps)).rejects.toBeInstanceOf(UseCaseError);
  });

  it('accepts a complete list in any order', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    deps.objects.uploadedParts.mockResolvedValueOnce([{ Size: 8 * 1024 * 1024, PartNumber: 3 }, full(2), full(1)]);
    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });
  });

  it('stages before marking: a failed stage leaves the session open and the retry succeeds', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    deps.sessions.stage.mockRejectedValueOnce(new Error('db down'));
    await expect(completeUpload(sessionId, deps)).rejects.toThrow('db down');
    expect(deps.sessionRows.get(sessionId)?.status).toBe('in_progress');

    deps.objects.info.mockResolvedValueOnce({ exists: true, size: open.size }); // S3 finished on the first attempt
    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });
    expect(deps.staged.get('show-1')).toMatchObject({ key });
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
  });

  it('a completeMultipart that throws but whose object exists goes on to stage and mark', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    deps.objects.info.mockResolvedValueOnce({ exists: false, size: null }).mockResolvedValueOnce({ exists: true, size: open.size });
    deps.objects.completeMultipart.mockRejectedValueOnce(new Error('timeout'));
    await expect(completeUpload(sessionId, deps)).resolves.toEqual({ key });
    expect(deps.staged.get('show-1')).toMatchObject({ key });
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
  });

  it('a completeMultipart that throws with no object rethrows and stages nothing', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    deps.objects.completeMultipart.mockRejectedValueOnce(new Error('timeout'));
    await expect(completeUpload(sessionId, deps)).rejects.toThrow('timeout');
    expect(deps.staged.size).toBe(0);
  });
});

describe('abortUpload', () => {
  it('aborts the S3 upload of a session in progress and marks it', async () => {
    const deps = fakeDeps();
    const { sessionId, key } = await openUploadSession(open, deps);
    await abortUpload(sessionId, deps);
    expect(deps.objects.abortMultipart).toHaveBeenCalledWith(key, 'mpu-1');
    expect(deps.sessionRows.get(sessionId)?.status).toBe('aborted');
  });

  it('a late abort leaves a completed session alone: no S3 call and its status is not rewritten', async () => {
    const deps = fakeDeps();
    const { sessionId } = await openUploadSession(open, deps);
    await completeUpload(sessionId, deps);
    await abortUpload(sessionId, deps);
    expect(deps.objects.abortMultipart).not.toHaveBeenCalled();
    expect(deps.sessionRows.get(sessionId)?.status).toBe('completed');
  });
});
