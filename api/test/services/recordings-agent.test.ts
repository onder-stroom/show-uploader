import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingsAgent } from '../../src/services/recordings-agent';

let server: http.Server;
let seen: { url?: string; auth?: string; range?: string };

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  seen = {};
  server = http.createServer((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, range: req.headers.range as string | undefined };
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const closeServer = () =>
  new Promise<void>((r) => {
    if (!server) return r();
    server.closeAllConnections?.();
    server.close(() => r());
  });
afterEach(closeServer);

describe('recordings agent adapter', () => {
  it('lists recordings with the bearer token', async () => {
    const baseUrl = await serve((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify([{ ref: 'r1' }])));
    const agent = createRecordingsAgent({ baseUrl, token: 't'.repeat(20) });
    expect(await agent.list()).toEqual([{ ref: 'r1' }]);
    expect(seen).toMatchObject({ url: '/v1/recordings', auth: `Bearer ${'t'.repeat(20)}` });
  });

  it('treats an unconfigured agent as unreachable, not as an error', async () => {
    expect(await createRecordingsAgent({}).list()).toBeNull();
  });

  it('treats a refused connection, a timeout and a 401 as unreachable', async () => {
    expect(await createRecordingsAgent({ baseUrl: 'http://127.0.0.1:1', token: 't'.repeat(20) }).list()).toBeNull();

    const slow = await serve((_req, res) => void setTimeout(() => res.end(), 300));
    expect(await createRecordingsAgent({ baseUrl: slow, token: 't'.repeat(20), timeoutMs: 50 }).list()).toBeNull();
    await closeServer();

    const denied = await serve((_req, res) => void ((res.statusCode = 401), res.end()));
    expect(await createRecordingsAgent({ baseUrl: denied, token: 't'.repeat(20) }).list()).toBeNull();
  });

  it('reads peaks, and returns null when there are none', async () => {
    const ok = await serve((_req, res) => res.setHeader('content-type', 'application/json').end('[0.1,0.2]'));
    expect(await createRecordingsAgent({ baseUrl: ok, token: 't'.repeat(20) }).peaks('r 1')).toEqual([0.1, 0.2]);
    expect(seen.url).toBe('/v1/recordings/r%201/peaks');
    await closeServer();

    const none = await serve((_req, res) => void ((res.statusCode = 404), res.end()));
    expect(await createRecordingsAgent({ baseUrl: none, token: 't'.repeat(20) }).peaks('r1')).toBeNull();
  });

  it('forwards the Range header and returns the raw response so the route can stream it', async () => {
    const baseUrl = await serve((_req, res) => void ((res.statusCode = 206), res.end('0123456789')));
    const upstream = await createRecordingsAgent({ baseUrl, token: 't'.repeat(20) }).preview('r1', 'bytes=0-9');
    expect(upstream?.status).toBe(206);
    expect(await upstream?.text()).toBe('0123456789');
    expect(seen.range).toBe('bytes=0-9');
  });

  it('treats a 200 with a non-JSON body or the wrong shape as unreachable', async () => {
    const t = 't'.repeat(20);
    const html = await serve((_req, res) => res.setHeader('content-type', 'text/html').end('<html>proxy</html>'));
    expect(await createRecordingsAgent({ baseUrl: html, token: t }).list()).toBeNull();
    expect(await createRecordingsAgent({ baseUrl: html, token: t }).peaks('r1')).toBeNull();
    await closeServer();

    const obj = await serve((_req, res) => res.setHeader('content-type', 'application/json').end('{}'));
    expect(await createRecordingsAgent({ baseUrl: obj, token: t }).list()).toBeNull();
    expect(await createRecordingsAgent({ baseUrl: obj, token: t }).peaks('r1')).toBeNull();
  });

  it('passes a 404 preview through as a Response, but a refused connection is null', async () => {
    const t = 't'.repeat(20);
    const missing = await serve((_req, res) => void ((res.statusCode = 404), res.end()));
    const upstream = await createRecordingsAgent({ baseUrl: missing, token: t }).preview('r1', undefined);
    expect(upstream?.status).toBe(404);
    await upstream?.body?.cancel();
    expect(await createRecordingsAgent({ baseUrl: 'http://127.0.0.1:1', token: t }).preview('r1', undefined)).toBeNull();
  });
});
