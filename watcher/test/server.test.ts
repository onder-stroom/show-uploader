import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutManager } from '../src/cuts';
import { Library } from '../src/library';
import { createServer } from '../src/server';

const TOKEN = 't'.repeat(24);
let root: string | undefined;
let lib: Library;
let cuts: CutManager;
let base: string;
let server: ReturnType<ReturnType<typeof createServer>['listen']> | undefined;
const NOW = 1_800_000_000_000;
let cutFileImpl: (o: { output: string }) => Promise<void>;
let releaseCut: () => void;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-srv-'));
  lib = new Library({ recordingsDir: root, workDir: path.join(root, '.w'), stableWindowMs: 20_000 });
  const p = path.join(root, '2026-10-01_20-00-00.mkv');
  fs.writeFileSync(p, 'src');
  fs.utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
  cutFileImpl = () => new Promise<void>((r) => { releaseCut = r; });
  releaseCut = () => {};
  lib.sync(NOW);
  const [s] = lib.list();
  fs.mkdirSync(lib.paths(s.ref).dir, { recursive: true });
  fs.writeFileSync(lib.paths(s.ref).preview, Buffer.alloc(1000, 1));
  fs.writeFileSync(lib.paths(s.ref).peaks, JSON.stringify([0.1, 0.2]));
  lib.save({ ...s, state: 'ready', hasPreview: true, hasPeaks: true, durationS: 3600 });

  cuts = new CutManager({
    library: lib, cutFile: vi.fn((o) => cutFileImpl(o)), putPart: vi.fn(async () => 'etag'),
    stagingDir: path.join(root, '.w', 'cuts'), mixAudioStream: 0, now: () => NOW, sleep: async () => {},
  });
  const app = createServer({ token: TOKEN, library: lib, cuts, status: () => ({ recordingActive: false }) });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  releaseCut?.(); // let a still-running cut finish so idle() settles
  await cuts?.idle();
  vi.restoreAllMocks();
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, 'Content-Type': 'application/json' };

describe('body limit', () => {
  it('accepts a part list for a segment of tens of GB (3 MB of JSON), not a 413', async () => {
    const parts = Array.from({ length: 4000 }, (_, i) => ({ n: i + 1, url: `https://s3/${'x'.repeat(700)}/${i}` }));
    const res = await fetch(`${base}/v1/cuts/nope/upload`, { method: 'POST', headers: json, body: JSON.stringify({ partSize: 16, parts }) });
    expect(res.status).toBe(404); // reached the handler: unknown cut
  });
});

describe('auth', () => {
  it('rejects a missing and a wrong token', async () => {
    expect((await fetch(`${base}/v1/recordings`)).status).toBe(401);
    expect((await fetch(`${base}/v1/recordings`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('rejects a wrong scheme and a same-length wrong token', async () => {
    expect((await fetch(`${base}/v1/recordings`, { headers: { Authorization: 'Basic xxx' } })).status).toBe(401);
    const same = { Authorization: `Bearer ${'x'.repeat(TOKEN.length)}` };
    expect((await fetch(`${base}/v1/recordings`, { headers: same })).status).toBe(401);
  });

  it('answers 401, not a parse error, to an unauthenticated malformed body', async () => {
    const res = await fetch(`${base}/v1/cuts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
    });
    expect(res.status).toBe(401);
  });
});

describe('errors', () => {
  it('answers authenticated malformed JSON with a JSON 400 and no stack', async () => {
    const res = await fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: '{nope' });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'invalid body' });
    expect(text).not.toMatch(/at |node_modules/);
  });

  it('answers a synchronous throw with a bare JSON 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(lib, 'list').mockImplementation(() => {
      throw new Error('boom /secret/path');
    });
    const res = await fetch(`${base}/v1/recordings`, { headers: auth });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toMatch(/secret|boom|node_modules/);
  });
});

describe('recordings', () => {
  it('lists recordings with the contract fields', async () => {
    const res = await fetch(`${base}/v1/recordings`, { headers: auth });
    const [r] = (await res.json()) as Record<string, unknown>[];
    expect(r).toMatchObject({ filename: '2026-10-01_20-00-00.mkv', state: 'ready', hasPreview: true, durationS: 3600 });
    expect(typeof r.ref).toBe('string');
    expect(r.recordedAtMs).toBe(new Date(2026, 9, 1, 20, 0, 0).getTime());
  });

  it('serves the preview with Range support so scrubbing works', async () => {
    const [s] = lib.list();
    const res = await fetch(`${base}/v1/recordings/${s.ref}/preview`, { headers: { ...auth, Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('serves peaks, and 404s for an unknown or unprepared recording', async () => {
    const [s] = lib.list();
    expect(await (await fetch(`${base}/v1/recordings/${s.ref}/peaks`, { headers: auth })).json()).toEqual([0.1, 0.2]);
    expect((await fetch(`${base}/v1/recordings/ghost/preview`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v1/recordings/ghost/peaks`, { headers: auth })).status).toBe(404);
  });

  it('404s the preview when it is not marked, or its file was deleted by hand', async () => {
    const [s] = lib.list();
    fs.rmSync(lib.paths(s.ref).preview);
    expect((await fetch(`${base}/v1/recordings/${s.ref}/preview`, { headers: auth })).status).toBe(404);
    lib.save({ ...s, hasPreview: false });
    expect((await fetch(`${base}/v1/recordings/${s.ref}/preview`, { headers: auth })).status).toBe(404);
  });

  it('reports health with whether OBS is recording', async () => {
    expect(await (await fetch(`${base}/v1/health`, { headers: auth })).json()).toMatchObject({ ok: true, ready: 1, recordingActive: false });
  });
});

describe('cuts', () => {
  it('validates the body', async () => {
    const [s] = lib.list();
    const bad = (body: unknown) => fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await bad({ cutId: '../x', ref: s.ref, startS: 0, endS: 10 })).status).toBe(400);
    expect((await bad({ cutId: 'c1', ref: s.ref, startS: 10, endS: 5 })).status).toBe(400);
    expect((await bad({ cutId: 'c1', ref: s.ref, startS: 'a', endS: 5 })).status).toBe(400);
  });

  it('404s an unknown recording, accepts a good cut with 202, and 404s an unknown cut', async () => {
    const [s] = lib.list();
    const post = (ref: string) =>
      fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify({ cutId: 'c1', ref, startS: 0, endS: 60 }) });
    expect((await post('ghost')).status).toBe(404);
    const ok = await post(s.ref);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ cutId: 'c1', state: 'cutting' });
    expect((await fetch(`${base}/v1/cuts/c1`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/v1/cuts/ghost`, { headers: auth })).status).toBe(404);
  });

  it('answers 409 to an upload request while the cut is still running', async () => {
    const [s] = lib.list();
    await fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify({ cutId: 'c1', ref: s.ref, startS: 0, endS: 60 }) });
    const res = await fetch(`${base}/v1/cuts/c1/upload`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ partSize: 16, parts: [{ n: 1, url: 'https://s3/x' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('accepts an upload for a ready cut and validates its body', async () => {
    const [s] = lib.list();
    cutFileImpl = async (o) => fs.writeFileSync(o.output, Buffer.alloc(10, 1));
    await fetch(`${base}/v1/cuts`, { method: 'POST', headers: json, body: JSON.stringify({ cutId: 'c1', ref: s.ref, startS: 0, endS: 60 }) });
    await cuts.idle();
    const up = (body: unknown) =>
      fetch(`${base}/v1/cuts/c1/upload`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await up({ partSize: 16 })).status).toBe(400);
    expect((await up({ partSize: 16, parts: [{ n: 1, url: 'https://s3/x' }] })).status).toBe(202);
    await cuts.idle();
  });

  it('deleting a cut that is already gone is fine', async () => {
    expect((await fetch(`${base}/v1/cuts/ghost`, { method: 'DELETE', headers: auth })).status).toBe(204);
  });
});
