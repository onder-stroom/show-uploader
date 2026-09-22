import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/db/client', () => ({ db: {} }));
vi.mock('../../src/db/queries', () => ({
  takeStagedUpload: vi.fn(),
  isVideoKeyClaimed: vi.fn(async () => false),
}));
vi.mock('../../src/services/s3', () => ({ deleteObject: vi.fn(async () => {}) }));

import { takeStagedUpload, isVideoKeyClaimed } from '../../src/db/queries';
import { deleteObject } from '../../src/services/s3';
import { deleteStagedVideo } from '../../src/services/staged-video';

describe('deleteStagedVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isVideoKeyClaimed).mockResolvedValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('deletes the S3 object a staged row pointed at', async () => {
    vi.mocked(takeStagedUpload).mockResolvedValue('incoming/1785-rec.mkv');

    await deleteStagedVideo('show-1');

    expect(vi.mocked(deleteObject)).toHaveBeenCalledWith('incoming/1785-rec.mkv');
  });

  // The other caller of takeStagedUpload's sibling, deleteStagedUpload, is the
  // post-publish path in `create` — where the key has just become
  // show_uploads.video_s3_key and an S3 delete here would destroy the video
  // the show now points at. This function must only ever be reached from the
  // operator's explicit "replace" action, never from that path.
  it('touches nothing when there was no staged row to abandon', async () => {
    vi.mocked(takeStagedUpload).mockResolvedValue(null);

    await deleteStagedVideo('show-1');

    expect(vi.mocked(deleteObject)).not.toHaveBeenCalled();
  });

  it('does not throw when the row lookup itself fails', async () => {
    vi.mocked(takeStagedUpload).mockRejectedValue(new Error('db down'));

    await expect(deleteStagedVideo('show-1')).resolves.toBeUndefined();
    expect(vi.mocked(deleteObject)).not.toHaveBeenCalled();
  });

  // A failed S3 delete must not surface as a failed replace — it degrades to
  // an orphan the storage page can catch later, not a broken UI action.
  it('does not throw when the S3 delete fails', async () => {
    vi.mocked(takeStagedUpload).mockResolvedValue('incoming/1785-rec.mkv');
    vi.mocked(deleteObject).mockRejectedValue(new Error('s3 down'));

    await expect(deleteStagedVideo('show-1')).resolves.toBeUndefined();
  });

  // The race this guards: a publish overlapping this replace can have already
  // written this exact key into a show_uploads row before the delete below
  // would otherwise run.
  it('does not delete a key a show_uploads row has since claimed', async () => {
    vi.mocked(takeStagedUpload).mockResolvedValue('incoming/1785-rec.mkv');
    vi.mocked(isVideoKeyClaimed).mockResolvedValue(true);

    await deleteStagedVideo('show-1');

    expect(vi.mocked(isVideoKeyClaimed)).toHaveBeenCalledWith(expect.anything(), 'incoming/1785-rec.mkv');
    expect(vi.mocked(deleteObject)).not.toHaveBeenCalled();
  });
});
