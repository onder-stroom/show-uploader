import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
  decodeProtectedHeader: vi.fn(() => ({ alg: 'RS256', kid: 'key-1' })),
}));

vi.mock('../../src/env', () => ({
  env: { ZITADEL_DOMAIN: 'test.zitadel.cloud', ZITADEL_CLIENT_ID: 'test-client-id' },
}));

import { jwtVerify } from 'jose';
import { verifyToken } from '../../src/auth/verify-token';

const memberPayload = {
  payload: {
    sub: 'user-1',
    name: 'Koray',
    'urn:zitadel:iam:org:project:roles': { member: { orgId: 'org' } },
  },
} as any;

describe('verifyToken', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('accepts a member token and returns the identity', async () => {
    vi.mocked(jwtVerify).mockResolvedValue(memberPayload);
    await expect(verifyToken('t', 'query trpc')).resolves.toEqual({
      ok: true,
      user: { sub: 'user-1', name: 'Koray' },
    });
  });

  // Zitadel and this host keep their own clocks; a second of drift used to
  // reject a token that had just been issued.
  it('allows for clock drift', async () => {
    vi.mocked(jwtVerify).mockResolvedValue(memberPayload);
    await verifyToken('t', 'ctx');
    expect(vi.mocked(jwtVerify)).toHaveBeenCalledWith('t', 'mock-jwks', {
      issuer: 'https://test.zitadel.cloud',
      audience: 'test-client-id',
      clockTolerance: '30s',
    });
  });

  it('reports a missing member role as 403', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: { sub: 'u' } } as any);
    await expect(verifyToken('t', 'ctx')).resolves.toMatchObject({ ok: false, status: 403 });
  });

  // Zitadel allows one grant per user per project, so an admin can't also
  // hold member — admin alone has to be enough.
  it('accepts an admin token without member', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'u', 'urn:zitadel:iam:org:project:roles': { admin: { orgId: 'org' } } },
    } as any);
    await expect(verifyToken('t', 'ctx')).resolves.toMatchObject({ ok: true });
  });

  it('rejects a token whose only roles grant nothing here', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'u', 'urn:zitadel:iam:org:project:roles': { 'website-admin': {} } },
    } as any);
    await expect(verifyToken('t', 'ctx')).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it('reports a rejected token as 401 with its jose code', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(
      Object.assign(new Error('exp'), { code: 'ERR_JWT_EXPIRED' })
    );
    await expect(verifyToken('t', 'ctx')).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'ERR_JWT_EXPIRED',
    });
  });

  // The loop's engine when it lived in tRPC: a key-set fetch that failed says
  // nothing about the token, but answering 401 makes the UI sign out and bounce.
  it('reports a key-set failure as 503, not 401', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(
      Object.assign(new Error('timeout'), { code: 'ERR_JWKS_TIMEOUT' })
    );
    await expect(verifyToken('t', 'ctx')).resolves.toMatchObject({ ok: false, status: 503 });
  });

  it('logs every rejection with the caller that asked, so neither path is silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(jwtVerify).mockRejectedValue(
      Object.assign(new Error('bad'), { code: 'ERR_JWS_INVALID' })
    );
    await verifyToken('t', 'POST /api/trpc/uploads.list');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('POST /api/trpc/uploads.list'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ERR_JWS_INVALID'));
  });
});
