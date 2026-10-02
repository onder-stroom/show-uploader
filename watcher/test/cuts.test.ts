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
      pin: vi.fn(() => () => {}),
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

  it('keeps the recording pinned while ffmpeg reads it, and releases it however the cut ends', async () => {
    const release = vi.fn();
    const pin = vi.fn(() => release);
    const a = make({ library: { ...make().deps.library, pin } });
    a.manager.start(req);
    expect(pin).toHaveBeenCalledWith('known');
    expect(release).not.toHaveBeenCalled();
    await a.manager.idle();
    expect(release).toHaveBeenCalledTimes(1);

    release.mockClear();
    const b = make({
      library: { ...make().deps.library, pin },
      cutFile: vi.fn(async () => { throw new Error('boom'); }),
    });
    b.manager.start({ ...req, cutId: 'cut2' });
    await b.manager.idle();
    expect(release).toHaveBeenCalledTimes(1);
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
    expect(() => manager.start({ ...req, cutId: '../evil' })).toThrow(expect.objectContaining({ code: 'BAD_ID' }));
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

describe('upload validation and resume', () => {
  async function ready(over: Partial<CutDeps> = {}) {
    const ctx = make(over);
    ctx.manager.start(req);
    await ctx.manager.idle();
    return ctx;
  }

  it('discards ETags from a different part size', async () => {
    let fail = true;
    const { manager, deps } = await ready({
      putPart: vi.fn(async (url: string, body: Buffer) => {
        if (url.endsWith('/3') && fail) throw new Error('reset');
        return `"e${body.length}"`;
      }),
    });
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    fail = false;
    vi.mocked(deps.putPart).mockClear();
    manager.upload('cut1', { partSize: 20, parts: parts(2) });
    await manager.idle();
    expect(manager.get('cut1')?.state).toBe('done');
    expect(vi.mocked(deps.putPart)).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate or non-contiguous part numbers and a zero part size', async () => {
    const { manager } = await ready();
    manager.upload('cut1', { partSize: 16, parts: [{ n: 1, url: 'u1' }, { n: 1, url: 'u1' }, { n: 2, url: 'u2' }] });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/part list/i) });
    manager.upload('cut1', { partSize: 0, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/part list/i) });
  });

  it('fails instead of uploading zero-filled data when the staged file is shorter than recorded', async () => {
    fs.writeFileSync(path.join(dir, 'cut2.mp4'), Buffer.alloc(10));
    fs.writeFileSync(
      path.join(dir, 'cut2.json'),
      JSON.stringify({ cutId: 'cut2', ref: 'known', startS: 0, endS: 1, state: 'cut', sizeBytes: 40, etags: null, reason: null, audioStream: 0, videoCodec: null, parts: [] })
    );
    const { manager, deps } = make();
    manager.load();
    manager.upload('cut2', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut2')).toMatchObject({ state: 'failed', reason: expect.stringMatching(/shorter/) });
    expect(deps.putPart).not.toHaveBeenCalled();
  });

  it('refuses to upload a cut that failed mid-ffmpeg, even if a partial file is on disk', async () => {
    const { manager } = await ready({
      cutFile: vi.fn(async (o) => {
        fs.writeFileSync(o.output, Buffer.alloc(5));
        throw new Error('ffmpeg died');
      }),
    });
    fs.writeFileSync(path.join(dir, 'cut1.mp4'), Buffer.alloc(5));
    expect(manager.get('cut1')?.state).toBe('failed');
    expect(() => manager.upload('cut1', { partSize: 16, parts: parts(1) })).toThrow(CutError);
  });
});

describe('drop with work in flight', () => {
  it('a cut dropped while ffmpeg runs leaves nothing behind, and the id can be started again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { manager } = make({
      cutFile: vi.fn(async (o) => {
        await gate;
        fs.writeFileSync(o.output, Buffer.alloc(40));
      }),
    });
    manager.start(req);
    manager.drop('cut1');
    release();
    await manager.idle();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(manager.get('cut1')).toBeNull();
  });

  it('an upload dropped between parts stops sending and leaves nothing behind', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { manager, deps } = make({ putPart: vi.fn(async () => (await gate, '"e"')) });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await vi.waitFor(() => expect(deps.putPart).toHaveBeenCalledTimes(1));
    manager.drop('cut1');
    release();
    await manager.idle();
    expect(deps.putPart).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(manager.get('cut1')).toBeNull();
    expect(uploaded).toEqual([]);
  });

  it('drop of an unsafe id leaves other files alone', () => {
    fs.writeFileSync(path.join(dir, 'keep.json'), '{}');
    make().manager.drop('../evil');
    expect(fs.readdirSync(dir)).toEqual(['keep.json']);
  });
});

describe('errors that escape the happy path', () => {
  it('a record that cannot be written ends failed, and idle() still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager } = make({
      cutFile: vi.fn(async (o) => {
        fs.writeFileSync(o.output, Buffer.alloc(40));
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(dir, 'now a file');
      }),
    });
    manager.start(req);
    await expect(manager.idle()).resolves.toBeUndefined();
    expect(manager.get('cut1')?.state).toBe('failed');
    expect(warn).toHaveBeenCalled();
    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir);
    warn.mockRestore();
  });

  it('a putPart that throws synchronously is a failed upload', async () => {
    const { manager } = make({
      putPart: vi.fn(() => {
        throw new Error('sync boom');
      }),
    });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 40, parts: parts(1) });
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'failed', reason: expect.stringContaining('sync boom') });
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
    try {
      expect(await putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(100))).toBe('"abc"');
      expect(seen).toBe(100);
    } finally {
      server.close();
    }
  });

  it('throws on a non-2xx so the retry loop sees it', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      await expect(putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(1))).rejects.toThrow(/403/);
    } finally {
      server.close();
    }
  });
});

describe('putPartViaFetch timeout', () => {
  it('fails instead of hanging when the server never answers', async () => {
    const server = http.createServer(() => {}); // accepts the request and never replies
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      await expect(putPartViaFetch(`http://127.0.0.1:${port}/x`, Buffer.alloc(1), 100)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('sweep', () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const old = (file: string, ageMs: number) => fs.utimesSync(path.join(dir, file), new Date(NOW - ageMs), new Date(NOW - ageMs));
  const put = (file: string, ageMs: number, content = '{}') => {
    fs.writeFileSync(path.join(dir, file), content);
    old(file, ageMs);
  };
  const rec = (cutId: string, state: string) => JSON.stringify({
    cutId, ref: 'known', startS: 0, endS: 10, state, sizeBytes: 40, etags: null, reason: null, audioStream: 0, videoCodec: 'hevc', parts: [],
  });

  it('removes an old untracked pair, a stray old mp4 and nothing newer', () => {
    put('gone.json', 15 * DAY); put('gone.mp4', 15 * DAY);
    put('young.json', 1 * DAY); put('young.mp4', 1 * DAY);
    put('stray.mp4', 2 * 3_600_000);
    put('fresh.mp4', 60_000);
    make({ now: () => NOW }).manager.sweep(14 * DAY);
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh.mp4', 'young.json', 'young.mp4']);
  });

  it('a tracked cut touched within maxAgeMs is never swept, however it is tracked', () => {
    put('live.json', 1 * DAY, rec('live', 'uploading')); put('live.mp4', 30 * DAY);
    const { manager } = make({ now: () => NOW });
    manager.load();
    manager.sweep(14 * DAY);
    expect(fs.readdirSync(dir).sort()).toEqual(['live.json', 'live.mp4']);
    expect(manager.get('live')).not.toBeNull();
  });

  it('a cut or uploading record abandoned for maxAgeMs (its drop never reached the PC) is swept', () => {
    put('c.json', 30 * DAY, rec('c', 'cut')); put('c.mp4', 30 * DAY);
    put('u.json', 30 * DAY, rec('u', 'uploading')); put('u.mp4', 30 * DAY);
    const { manager } = make({ now: () => NOW });
    manager.load();
    manager.sweep(14 * DAY);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(manager.get('c')).toBeNull();
  });

  it('after a restart, a finished record whose drop once failed is swept by age', () => {
    put('left.json', 30 * DAY, rec('left', 'done')); put('left.mp4', 30 * DAY);
    const { manager } = make({ now: () => NOW });
    manager.load();
    manager.sweep(14 * DAY);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(manager.get('left')).toBeNull();
  });

  it('never throws, even when the staging dir is missing or removal fails', () => {
    const { manager } = make({ now: () => NOW, stagingDir: path.join(dir, 'nope') });
    expect(() => manager.sweep(1)).not.toThrow();
    put('a.json', 30 * DAY);
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY'); });
    try {
      expect(() => make({ now: () => NOW }).manager.sweep(DAY)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isBusy: pause while OBS records', () => {
  it('a cut waits while busy, then runs', async () => {
    let busyFor = 3;
    const sleep = vi.fn(async () => void busyFor--);
    const { manager, deps } = make({ isBusy: () => busyFor > 0, sleep });
    manager.start(req);
    await manager.idle();
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(deps.cutFile).toHaveBeenCalledTimes(1);
    expect(manager.get('cut1')).toMatchObject({ state: 'cut' });
  });

  it('a cut is not started at all while busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let busy = true;
    const { manager, deps } = make({ isBusy: () => busy, sleep: () => gate });
    manager.start(req);
    await Promise.resolve();
    expect(deps.cutFile).not.toHaveBeenCalled();
    busy = false;
    release();
    await manager.idle();
    expect(deps.cutFile).toHaveBeenCalledTimes(1);
  });

  it('an upload waits between parts while busy, and the cut stays uploading, not failed', async () => {
    let busy = false;
    let waits = 0;
    const sleep = vi.fn(async () => { waits++; if (waits >= 2) busy = false; });
    const { manager, deps } = make({ isBusy: () => busy, sleep, putPart: vi.fn(async () => { busy = true; return '"e"'; }) });
    manager.start(req);
    await manager.idle();
    manager.upload('cut1', { partSize: 16, parts: parts(3) });
    await manager.idle();
    expect(deps.putPart).toHaveBeenCalledTimes(3);
    expect(waits).toBeGreaterThanOrEqual(2);
    expect(manager.get('cut1')).toMatchObject({ state: 'done' });
  });

  it('reports paused while it waits for OBS, and not after', async () => {
    let busy = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { manager } = make({ isBusy: () => busy, sleep: () => gate });
    manager.start(req);
    await Promise.resolve();
    expect(manager.get('cut1')).toMatchObject({ state: 'cutting', paused: true });
    busy = false;
    release();
    await manager.idle();
    expect(manager.get('cut1')).toMatchObject({ state: 'cut', paused: false });
    expect(fs.readFileSync(path.join(dir, 'cut1.json'), 'utf8')).not.toContain('paused');
  });

  it('drop while paused ends cleanly and leaves nothing behind', async () => {
    const { manager, deps } = make({ isBusy: () => true, sleep: async () => { await new Promise((r) => setImmediate(r)); } });
    manager.start(req);
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'cut1.json'))).toBe(true));
    manager.drop('cut1');
    await manager.idle();
    expect(deps.cutFile).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
