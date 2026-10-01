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
});
