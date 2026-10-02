import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/env', () => ({
  env: { POCKETBASE_URL: 'https://pb.test', POCKETBASE_INTERNAL_URL: 'https://pb.test', PB_SERVICE_EMAIL: 'svc@test', PB_SERVICE_PASSWORD: 'pw' },
}));

import { createArchiveDraft, listStrands } from '../../src/services/shows-api';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

function stubPocketBase(handler: (url: string, init: RequestInit) => unknown) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('_superusers/auth-with-password')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify(handler(url, init)), { status: 200 });
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('createArchiveDraft', () => {
  const rec = { id: 'new', title: 'Bosbar', notes: '', startTime: '2026-09-30 14:00:00.000Z', endTime: '2026-09-30 16:00:00.000Z', collectionId: 'c', expand: { strand: { name: 'De Bosbar', isDefault: false } } };

  it('posts a draft with UTC datetimes and the strand, and returns it as a show', async () => {
    stubPocketBase(() => rec);
    const show = await createArchiveDraft({ title: 'Bosbar', date: '2026-09-30', startTime: '14:00', endTime: '16:00', strandId: 'strand-bos' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { title: 'Bosbar', startTime: '2026-09-30 14:00:00.000Z', endTime: '2026-09-30 16:00:00.000Z', status: 'draft', strand: 'strand-bos' },
    });
    expect(calls[0].url).toContain('/api/collections/archive/records');
    expect(show).toMatchObject({ id: 'new', title: 'Bosbar', date: '2026-09-30', startTime: '14:00', strand: { name: 'De Bosbar', isDefault: false } });
  });

  it('ends the next day when the end is at or before the start, and omits an absent strand', async () => {
    stubPocketBase(() => rec);
    await createArchiveDraft({ title: 'Late', date: '2026-09-30', startTime: '23:00', endTime: '01:00', strandId: null });
    expect(calls[0].body).toMatchObject({ startTime: '2026-09-30 23:00:00.000Z', endTime: '2026-10-01 01:00:00.000Z' });
    expect(calls[0].body).not.toHaveProperty('strand');
  });

  it('throws with PocketBase\'s answer when it refuses', async () => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('auth-with-password') ? new Response(JSON.stringify({ token: 't' })) : new Response('nope', { status: 400 })
    ));
    await expect(createArchiveDraft({ title: 'x', date: '2026-09-30', startTime: '14:00', endTime: '16:00', strandId: null })).rejects.toThrow(/400 nope/);
  });
});

describe('listStrands', () => {
  it('maps id, name and the default flag, dropping nameless records', async () => {
    stubPocketBase(() => ({ items: [{ id: 'a', name: 'coming soon', isDefault: true }, { id: 'b', name: 'De Bosbar' }, { id: 'c' }] }));
    expect(await listStrands()).toEqual([
      { id: 'a', name: 'coming soon', isDefault: true },
      { id: 'b', name: 'De Bosbar', isDefault: false },
    ]);
  });
});
