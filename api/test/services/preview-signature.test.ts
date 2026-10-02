import { SignJWT, decodeJwt } from 'jose';
import { describe, it, expect } from 'vitest';
import { PREVIEW_TTL_S, signPreview, verifyPreview } from '../../src/services/preview-signature';

const SECRET = 's'.repeat(24);
const NOW = 1_800_000_000_000;

describe('preview tokens', () => {
  it('accepts a fresh token for the same recording', async () => {
    const token = await signPreview('ref1', SECRET, NOW);
    expect(await verifyPreview(token, 'ref1', SECRET, NOW + 1000)).toBe(true);
  });

  it('rejects an expired one, and still accepts it just before it expires', async () => {
    const token = await signPreview('ref1', SECRET, NOW);
    expect(await verifyPreview(token, 'ref1', SECRET, NOW + (PREVIEW_TTL_S - 5) * 1000)).toBe(true);
    expect(await verifyPreview(token, 'ref1', SECRET, NOW + (PREVIEW_TTL_S + 5) * 1000)).toBe(false);
  });

  it('rejects a token reused for another recording', async () => {
    const token = await signPreview('ref1', SECRET, NOW);
    expect(await verifyPreview(token, 'ref2', SECRET, NOW)).toBe(false);
  });

  it('rejects the wrong secret, a tampered token and garbage', async () => {
    const token = await signPreview('ref1', SECRET, NOW);
    expect(await verifyPreview(token, 'ref1', 'x'.repeat(24), NOW)).toBe(false);
    expect(await verifyPreview(`${token}x`, 'ref1', SECRET, NOW)).toBe(false);
    expect(await verifyPreview('', 'ref1', SECRET, NOW)).toBe(false);
    expect(await verifyPreview('not-a-jwt', 'ref1', SECRET, NOW)).toBe(false);
  });

  it('rejects a token signed with another algorithm or unsigned', async () => {
    const hs384 = await new SignJWT({ ref: 'ref1' })
      .setProtectedHeader({ alg: 'HS384' })
      .setExpirationTime(Math.floor(NOW / 1000) + 600)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyPreview(hs384, 'ref1', SECRET, NOW)).toBe(false);

    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none' })}.${b64({ ref: 'ref1', exp: Math.floor(NOW / 1000) + 600 })}.`;
    expect(await verifyPreview(none, 'ref1', SECRET, NOW)).toBe(false);
  });

  it('issues iat and exp from the injected clock', async () => {
    const claims = decodeJwt(await signPreview('ref1', SECRET, NOW));
    expect(claims.iat).toBe(NOW / 1000);
    expect(claims.exp).toBe(NOW / 1000 + PREVIEW_TTL_S);
  });
});
