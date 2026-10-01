import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/auth/verify-token', () => ({ verifyToken: vi.fn() }));
vi.mock('../../src/env', () => ({ env: {} }));
vi.mock('../../src/deps', () => ({ deps: {} }));
vi.mock('../../src/usecases/recording-cuts', () => ({
  listRecordings: vi.fn(), recordingPeaks: vi.fn(), signPreviewPath: vi.fn(), startCuts: vi.fn(), cutStatuses: vi.fn(),
}));

import { TRPCError } from '@trpc/server';
import { recordingsRouter } from '../../src/trpc/routers/recordings';
import { UseCaseError } from '../../src/usecases/errors';
import { startCuts } from '../../src/usecases/recording-cuts';

const caller = recordingsRouter.createCaller({ user: { sub: 'u', name: 'Operator' }, authStatus: null, headers: {} });
const input = { ref: 'r1', segments: [{ startS: 0, endS: 60, showId: 's1' }] };

beforeEach(() => vi.clearAllMocks());

describe('recordings router', () => {
  it('maps a refused rule to its tRPC code and keeps the message', async () => {
    vi.mocked(startCuts).mockRejectedValue(new UseCaseError('NOT_FOUND', 'That recording is no longer on the OBS PC'));
    const err = await caller.startCuts(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('NOT_FOUND');
    expect((err as TRPCError).message).toMatch(/no longer/);
  });

  it('validates input before reaching the use case', async () => {
    await expect(caller.startCuts({ ref: '', segments: [] })).rejects.toThrow();
    await expect(caller.startCuts({ ref: 'r', segments: [{ startS: Number.NaN, endS: 1, showId: 's' }] })).rejects.toThrow();
    expect(startCuts).not.toHaveBeenCalled();
  });

  it('refuses anonymous callers', async () => {
    const anon = recordingsRouter.createCaller({ user: null, authStatus: 401, headers: {} });
    await expect(anon.list()).rejects.toThrow();
  });
});
