// watcher/test/cuts.test.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutError, CutManager, PART_ATTEMPTS, putPartViaFetch, type CutDeps } from '../src/cuts';

let dir: string;
let source: string | null;
let uploaded: { cutId: string; at: number }[];

function make(over: Partial<CutDeps> = {}) {
  const deps: CutDeps = {
    library: {
      get: vi.fn((ref: string) => (ref === 'known' ? ({ ref: 'known', videoCodec: 'hevc' } as never) : null)),
      sourceFor: vi.fn(() => source),
      recordUpload: vi.fn((_ref: string, cutId: string, at: number) => void uploaded.push({ cutId, at })),
    },
    cutFile: vi.fn(async (o) => void fs.writeFileSync(o.output, Buffer.alloc(40, 7))),
    putPart: vi.fn(async (_url: string, body: Buffer) => `"etag-${body.length}"`),
    stagingDir: dir,
    mixAudioStream: 0,
    now: () => 1000,
    sleep: async () => {},
    ...over,
  };
  return { deps, manager: new CutManager(deps) };
}

const req = { cutId: 'cut1', ref: 'known', startS: 3, endS: 7 };
const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, url: `https://s3/part/${i + 1}` }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-cuts-'));
  source = '/rec/master.mp4';
  uploaded = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('start', () => {
  it('cuts to a staging file and reports its size', async () => {
    const { manager, deps } = make();
    expect(manager.start(req).state).toBe('cutting');
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'cut', sizeBytes: 40 });
    expect(deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ input: '/rec/master.mp4', startS: 3, endS: 7, videoCodec: 'hevc' }));
  });

  it('uses audio stream 0 for an MP4 master and the configured mix track for an original', async () => {
    const a = make();
    a.manager.start(req);
    await a.manager.idle();
    expect(a.deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 0 }));

    source = '/rec/night.mkv';
    const b = make({ mixAudioStream: 2 });
    b.manager.start({ ...req, cutId: 'cut2' });
    await b.manager.idle();
    expect(b.deps.cutFile).toHaveBeenCalledWith(expect.objectContaining({ audioStream: 2 }));
  });

  it('a recording deleted by hand ends source_gone and never starts ffmpeg', async () => {
    source = null;
    const { manager, deps } = make();
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'source_gone' });
    expect(deps.cutFile).not.toHaveBeenCalled();
  });

  it('a file that vanishes while ffmpeg runs is source_gone, not a generic failure', async () => {
    const { manager } = make({
      cutFile: vi.fn(async () => {
        source = null;
        throw new Error('No such file');
      }),
    });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('source_gone');
  });

  it('is idempotent per cutId: a second start does not cut again', async () => {
    const { manager, deps } = make();
    manager.start(req);
    await manager.idle();
    manager.start(req);
    await manager.idle();
    expect(deps.cutFile).toHaveBeenCalledTimes(1);
  });

  it('a failed cut is retried when started again', async () => {
    let calls = 0;
    const { manager } = make({
      cutFile: vi.fn(async (o) => {
        if (++calls === 1) throw new Error('disk full');
        fs.writeFileSync(o.output, Buffer.alloc(40));
      }),
    });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: 'disk full' });
    manager.start(req);
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('cut');
  });

  it('refuses an unknown recording and an id that is not filesystem-safe', () => {
    const { manager } = make();
    expect(() => manager.start({ ...req, ref: 'nope' })).toThrow(CutError);
    expect(() => manager.start({ ...req, cutId: '../evil' })).toThrow(/BAD_ID|id/i);
  });
});

describe('upload', () => {
  async function cutReady() {
    const ctx = make();
    ctx.manager.start(req);
    await ctx.manager.idle();
    return ctx;
  }

  it('slices the staged file into the requested parts, collects ETags and records the upload', async () => {
    const { manager, deps } = await cutReady();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();

    expect(vi.mocked(deps.putPart).mock.calls.map(([, body]) => body.length)).toEqual([16, 16, 8]);
    expect(manager.get('cut1')).toMatchObject({
      state: 'done',
      etags: [{ n: 1, etag: '"etag-16"' }, { n: 2, etag: '"etag-16"' }, { n: 3, etag: '"etag-8"' }],
    });
    expect(uploaded).toEqual([{ cutId: 'cut1', at: 1000 }]);
  });

  it('retries a failing part with backoff, then succeeds', async () => {
    let n = 0;
    const { manager, deps } = make({
      putPart: vi.fn(async (_u: string, body: Buffer) => {
        if (++n <= 2) throw new Error('reset');
        return `"e${body.length}"`;
      }),
    });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('done');
    expect(deps.putPart).toHaveBeenCalledTimes(3);
  });

  it('gives up after PART_ATTEMPTS and reports failed, keeping the staged file for a retry', async () => {
    const { manager, deps } = make({ putPart: vi.fn(async () => { throw new Error('offline'); }) });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringContaining('offline') });
    expect(deps.putPart).toHaveBeenCalledTimes(PART_ATTEMPTS);
    expect(fs.existsSync(path.join(dir, 'cut1.mp4'))).toBe(true);
  });

  it('on retry, parts that already landed are not sent again', async () => {
    let fail = true;
    const { manager, deps } = make({
      putPart: vi.fn(async (url: string, body: Buffer) => {
        if (url.endsWith('/3') && fail) throw new Error('reset');
        return `"e${body.length}"`;
      }),
    });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('failed');

    fail = false;
    vi.mocked(deps.putPart).mockClear();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('done');
    expect(vi.mocked(deps.putPart).mock.calls.map(([u]) => u)).toEqual(['https://s3/part/3']);
  });

  it('rejects a part list that does not match the staged size', async () => {
    const { manager } = await cutReady();
    manager.upload('cut1', { partSize: 16, parts: parts(2) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/part/i) });
  });

  it('refuses to upload before the cut finished, and for an unknown cut', () => {
    const { manager } = make({ cutFile: vi.fn(() => new Promise(() => {})) });
    manager.start(req);
    expect(() => manager.upload('cut1', { partSize: 16, parts: parts(3) })).toThrow(CutError);
    expect(() => manager.upload('ghost', { partSize: 16, parts: parts(3) })).toThrow(CutError);
  });

  it('a staged file deleted by hand fails the upload cleanly', async () => {
    const { manager } = await cutReady();
    fs.rmSync(path.join(dir, 'cut1.mp4'));
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('failed');
  });
});

describe('restart and cleanup', () => {
  // The records a process leaves behind if it dies mid-cut and mid-upload, written by hand
  // so the test is deterministic rather than racing a real upload.
  const record = (over: object) => ({
    ref: 'known', startS: 0, endS: 10, sizeBytes: null, etags: null, reason: null,
    audioStream: 0, videoCodec: 'hevc', parts: [], ...over,
  });

  it('after a restart an interrupted cut is failed, and an interrupted upload is resumable with its finished parts', () => {
    fs.writeFileSync(path.join(dir, 'cut1.json'), JSON.stringify(record({ cutId: 'cut1', state: 'cutting' })));
    fs.writeFileSync(path.join(dir, 'cut2.mp4'), Buffer.alloc(40));
    fs.writeFileSync(
      path.join(dir, 'cut2.json'),
      JSON.stringify(record({ cutId: 'cut2', state: 'uploading', sizeBytes: 40, parts: [{ n: 1, etag: '"e1"' }] }))
    );

    const { manager } = make();
    manager.load();

    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/restart/) });
    expect(manager.get('cut2')).toMatchObject({ state: 'cut', sizeBytes: 40 });
  });

  it('a reloaded upload skips the part that already landed', async () => {
    fs.writeFileSync(path.join(dir, 'cut2.mp4'), Buffer.alloc(40));
    fs.writeFileSync(
      path.join(dir, 'cut2.json'),
      JSON.stringify(record({ cutId: 'cut2', state: 'uploading', sizeBytes: 40, parts: [{ n: 1, etag: '"e1"' }] }))
    );
    const { manager, deps } = make();
    manager.load();
    manager.upload('cut2', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(vi.mocked(deps.putPart).mock.calls.map(([u]) => u)).toEqual(['https://s3/part/2', 'https://s3/part/3']);
    expect(manager.get('cut2')?.state).toBe('done');
  });

  it('drop removes the staging file and the record', async () => {
    const { manager } = make();
    manager.start(req);
    await manager.idle();
    manager.drop('cut1');
    expect(manager.get('cut1')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('drop on something already gone is fine', () => {
    expect(() => make().manager.drop('ghost')).not.toThrow();
  });
});

describe('putPartViaFetch', () => {
  it('PUTs the bytes and returns the ETag', async () => {
    let seen = 0;
    const server = http.createServer((req, res) => {
      req.on('data', (c: Buffer) => (seen += c.length));
      req.on('end', () => {
        res.setHeader('ETag', '"abc"');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    expect(await putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(100))).toBe('"abc"');
    expect(seen).toBe(100);
    server.close();
  });

  it('throws on a non-2xx so the retry loop sees it', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    await expect(putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(1))).rejects.toThrow(/403/);
    server.close();
  });
});
