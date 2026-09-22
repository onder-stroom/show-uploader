import { vi, describe, it, expect, beforeEach } from 'vitest';

// Everything the router touches below the use cases is stubbed: this is about
// how it maps outcomes, not what the use cases do.
vi.mock('../../src/auth/verify-token', () => ({ verifyToken: vi.fn() }));
vi.mock('../../src/env', () => ({ env: {} }));
vi.mock('../../src/db/client', () => ({ db: {} }));
vi.mock('../../src/db/queries', () => ({}));
vi.mock('../../src/services/archive-jobs', () => ({}));
vi.mock('../../src/services/s3', () => ({}));
vi.mock('../../src/services/staged-video', () => ({}));
vi.mock('../../src/services/upload-urls', () => ({}));
vi.mock('../../src/services/shows-api', () => ({}));
vi.mock('../../src/usecases/publish', () => ({ retryJob: vi.fn(), publishUpload: vi.fn(), publishToPlatform: vi.fn() }));
vi.mock('../../src/usecases/archive', () => ({}));
vi.mock('../../src/usecases/metadata', () => ({}));
vi.mock('../../src/usecases/recordings', () => ({}));
vi.mock('../../src/deps', () => ({ deps: {} }));

import { TRPCError } from '@trpc/server';
import { uploadsRouter } from '../../src/trpc/routers/uploads';
import { UseCaseError } from '../../src/usecases/errors';
import { retryJob } from '../../src/usecases/publish';

const caller = uploadsRouter.createCaller({
  user: { sub: 'u', name: 'Operator' },
  authStatus: null,
  headers: {},
});

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TRPCError);
  return err as TRPCError;
}

describe('uploads router error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // The UI shows these messages to the operator; a refused rule turning into a
  // generic 500 hides why nothing happened.
  it('keeps a refused rule as its own code and message', async () => {
    vi.mocked(retryJob).mockRejectedValue(new UseCaseError('PRECONDITION_FAILED', 'retry the archive first'));

    const err = await trpcError(caller.retryJob({ uploadId: 'up-1', platform: 'youtube' }));

    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toBe('retry the archive first');
  });

  it('turns an unexpected failure into a logged 500', async () => {
    vi.mocked(retryJob).mockRejectedValue(new Error('redis down'));

    const err = await trpcError(caller.retryJob({ uploadId: 'up-1', platform: 'youtube' }));

    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).toBe('Failed to retry job');
    expect(console.error).toHaveBeenCalled();
  });

  it('returns ok when the use case succeeds', async () => {
    vi.mocked(retryJob).mockResolvedValue();
    await expect(caller.retryJob({ uploadId: 'up-1', platform: 'archive' })).resolves.toEqual({ ok: true });
  });
});
