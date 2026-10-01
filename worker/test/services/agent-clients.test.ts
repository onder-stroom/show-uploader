import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingsAgent } from '../../src/services/recordings-agent';
import { createUploadSessions } from '../../src/services/upload-sessions';

let server: http.Server | undefined;
let seen: { method?: string; url?: string; auth?: string; body?: string };

async function serve(status: number, body: unknown = {}): Promise<string> {
  seen = {};
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw };
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
});

const token = 't'.repeat(20);
const req = { cutId: 'c1', ref: 'r1', startS: 0, endS: 60 };

describe('recordings agent client', () => {
  it('starts a cut with the bearer token', async () => {
    const baseUrl = await serve(202, { cutId: 'c1', state: 'cutting', sizeBytes: null, etags: null, reason: null });
    const out = await createRecordingsAgent({ baseUrl, token }).startCut(req);
    expect(out.state).toBe('cutting');
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/cuts', auth: `Bearer ${token}` });
    expect(JSON.parse(seen.body!)).toEqual(req);
  });

  it('turns "unknown recording" into source_gone, because the operator deleted it', async () => {
    const baseUrl = await serve(404, { error: 'Unknown recording r1', code: 'UNKNOWN_RECORDING' });
    const out = await createRecordingsAgent({ baseUrl, token }).startCut(req);
    expect(out).toMatchObject({ state: 'source_gone', reason: expect.stringMatching(/deleted/) });
  });

  it('reads a cut, null when the PC has no record', async () => {
    expect(await createRecordingsAgent({ baseUrl: await serve(404), token }).cut('c1')).toBeNull();
  });

  it('drop never throws', async () => {
    await expect(createRecordingsAgent({ baseUrl: 'http://127.0.0.1:1', token }).drop('c1')).resolves.toBeUndefined();
  });

  it('says clearly when it is not configured', async () => {
    await expect(createRecordingsAgent({}).startCut(req)).rejects.toThrow(/not configured/i);
  });
});

describe('upload sessions client', () => {
  it('opens a cut session through the api with the internal key', async () => {
    const reply = { sessionId: 's1', partSize: 16, parts: [{ n: 1, url: 'u' }], completed: false };
    const baseUrl = await serve(200, reply);
    const out = await createUploadSessions({ baseUrl: `${baseUrl}/api`, apiKey: 'k' }).open({
      cutId: 'c1', showId: 'show-1', filename: 'a.mp4', size: 10, ref: 'r1', startS: 0, endS: 60,
    });
    expect(out).toEqual(reply);
    expect(seen).toMatchObject({ method: 'POST', url: '/api/internal/recordings/cuts/c1/session', auth: 'Bearer k' });
  });

  it('throws with the api\'s message when it refuses', async () => {
    const baseUrl = await serve(404, { error: 'Show show-1 was not found' });
    await expect(createUploadSessions({ baseUrl: `${baseUrl}/api`, apiKey: 'k' }).complete('s1')).rejects.toThrow(/404/);
  });
});
