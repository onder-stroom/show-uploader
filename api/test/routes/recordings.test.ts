// api/test/routes/recordings.test.ts
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalRecordingsRouter, createPreviewRouter } from '../../src/routes/recordings';
import { signPreview } from '../../src/services/preview-signature';
import { fakeDeps } from '../fakes';

const SECRET = 's'.repeat(24);
const NOW = 1_800_000_000_000;
const servers: Server[] = [];

async function serve(mount: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        })
    )
  );
});

describe('preview route', () => {
  const url = (base: string, ref: string, token: string) => `${base}/preview/${ref}?t=${token}`;

  it('streams the agent\'s ranged response through, with its headers', async () => {
    const deps = fakeDeps({ recordingsSecret: SECRET });
    deps.recordings.preview.mockResolvedValue(
      new Response('0123456789', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes' } })
    );
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    const token = await signPreview('r1', SECRET, NOW);

    const res = await fetch(url(base, 'r1', token), { headers: { Range: 'bytes=0-9' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
    expect(await res.text()).toBe('0123456789');
    expect(deps.recordings.preview).toHaveBeenCalledWith('r1', 'bytes=0-9', expect.anything());
  });

  it('answers 403 without calling the PC for a missing, expired or tampered signature', async () => {
    const deps = fakeDeps({ recordingsSecret: SECRET });
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    const token = await signPreview('r1', SECRET, NOW);

    expect((await fetch(`${base}/preview/r1`)).status).toBe(403);
    expect((await fetch(url(base, 'r1', 'bad'))).status).toBe(403);
    expect((await fetch(url(base, 'r2', token))).status).toBe(403);
    const old = await signPreview('r1', SECRET, NOW - 7 * 3600_000);
    expect((await fetch(url(base, 'r1', old))).status).toBe(403);
    expect(deps.recordings.preview).not.toHaveBeenCalled();
  });

  it('answers 403 when recordings are not configured', async () => {
    const off = fakeDeps({ recordingsSecret: null });
    const base = await serve((a) => a.use(createPreviewRouter(off, () => NOW)));
    const token = await signPreview('r1', SECRET, NOW);
    expect((await fetch(url(base, 'r1', token))).status).toBe(403);
  });

  it('answers 502 when the PC is unreachable', async () => {
    const deps = fakeDeps({ recordingsSecret: SECRET }); // preview() resolves null
    const base = await serve((a) => a.use(createPreviewRouter(deps, () => NOW)));
    const token = await signPreview('r1', SECRET, NOW);
    expect((await fetch(url(base, 'r1', token))).status).toBe(502);
  });
});

describe('internal worker endpoints', () => {
  const KEY = 'internal-key';
  const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const open = { showId: 'show-a', filename: 'night.mp4', size: 40 * 1024 * 1024, ref: 'r1', startS: 0, endS: 60 };

  it('rejects calls without the shared key', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-a' }] });
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));
    const res = await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(open) });
    expect(res.status).toBe(401);
    expect(deps.objects.createMultipart).not.toHaveBeenCalled();
  });

  it('opens, completes and aborts a cut session', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-a' }] });
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));

    const opened = await (await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify(open) })).json();
    expect(opened.parts).toHaveLength(3);

    const done = await fetch(`${base}/internal/sessions/${opened.sessionId}/complete`, { method: 'POST', headers: auth });
    expect(done.status).toBe(200);
    expect(deps.staged.get('show-a')?.filename).toBe('night.mp4');

    const gone = await fetch(`${base}/internal/sessions/nope/complete`, { method: 'POST', headers: auth });
    expect(gone.status).toBe(404);
  });

  it('maps a refused rule to its status and validates the body', async () => {
    const deps = fakeDeps(); // no such show
    const base = await serve((a) => a.use('/internal', createInternalRecordingsRouter(deps, KEY)));
    expect((await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify(open) })).status).toBe(404);
    expect((await fetch(`${base}/internal/cuts/c1/session`, { method: 'POST', headers: auth, body: JSON.stringify({ showId: 'x' }) })).status).toBe(400);
  });
});
