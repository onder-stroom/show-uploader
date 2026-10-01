// watcher/src/cuts.ts
import fs from 'node:fs';
import path from 'node:path';
import type { AgentCut, CutRequest, UploadRequest } from '@show-uploader/domain';
import type { Library } from './library';

/**
 * Cuts one segment out of a recording and uploads it, part by part, to presigned
 * URLs it was handed. It holds no credentials: every URL is scoped to one object.
 *
 * One record per cutId on disk, so a restart can say what happened. A cut that was
 * running is reported failed (the worker re-requests it); an upload that was running
 * is resumable, because the staged file and the ETags of finished parts survive.
 */

export const PART_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export class CutError extends Error {
  constructor(
    readonly code: 'UNKNOWN_RECORDING' | 'NOT_CUT_YET' | 'UNKNOWN_CUT' | 'BAD_ID',
    message: string
  ) {
    super(message);
    this.name = 'CutError';
  }
}

export type CutDeps = {
  library: Pick<Library, 'get' | 'sourceFor' | 'recordUpload'>;
  cutFile(o: {
    input: string; output: string; startS: number; endS: number; audioStream: number; videoCodec: string | null;
  }): Promise<void>;
  /** PUT one part, return its ETag. Throws on failure. */
  putPart(url: string, body: Buffer): Promise<string>;
  stagingDir: string;
  mixAudioStream: number;
  now(): number;
  sleep(ms: number): Promise<void>;
};

type Record_ = AgentCut & {
  ref: string;
  startS: number;
  endS: number;
  audioStream: number;
  videoCodec: string | null;
  parts: { n: number; etag: string }[];
  /** Split the finished parts belong to; ETags from another split are useless. */
  partSize?: number;
  /** Set by drop(): in-flight work must stop and write nothing. Never persisted. */
  dropped?: boolean;
};

export async function putPartViaFetch(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`part upload failed: ${res.status}`);
  return res.headers.get('etag') ?? '';
}

export class CutManager {
  private readonly cuts = new Map<string, Record_>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly d: CutDeps) {}

  /** Reload records after a restart. */
  load(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.d.stagingDir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.d.stagingDir, name), 'utf8')) as Record_;
        // A running cut is gone with the process. A running upload resumes: its staged
        // file and finished parts are still here.
        if (rec.state === 'cutting') {
          rec.state = 'failed';
          rec.reason = 'interrupted by a restart';
        } else if (rec.state === 'uploading') {
          rec.state = 'cut';
        }
        this.cuts.set(rec.cutId, rec);
      } catch {
        // An unreadable record is simply not resumable.
      }
    }
  }

  start(req: CutRequest): AgentCut {
    if (!ID.test(req.cutId)) throw new CutError('BAD_ID', 'cutId must be 1-80 of A-Z a-z 0-9 _ -');
    if (!this.d.library.get(req.ref)) throw new CutError('UNKNOWN_RECORDING', `Unknown recording ${req.ref}`);

    const existing = this.cuts.get(req.cutId);
    if (existing && existing.state !== 'failed' && existing.state !== 'source_gone') return view(existing);

    const sidecar = this.d.library.get(req.ref)!;
    const rec: Record_ = {
      cutId: req.cutId, ref: req.ref, startS: req.startS, endS: req.endS,
      state: 'cutting', sizeBytes: null, etags: null, reason: null,
      audioStream: 0, videoCodec: sidecar.videoCodec, parts: [],
    };
    this.cuts.set(rec.cutId, rec);
    this.persist(rec);
    this.track(rec, this.runCut(rec));
    return view(rec);
  }

  get(cutId: string): AgentCut | null {
    const rec = this.cuts.get(cutId);
    return rec ? view(rec) : null;
  }

  upload(cutId: string, req: UploadRequest): AgentCut {
    const rec = this.cuts.get(cutId);
    if (!rec) throw new CutError('UNKNOWN_CUT', `Unknown cut ${cutId}`);
    if (rec.state === 'done') return view(rec);
    if (rec.state === 'uploading') return view(rec);
    if (rec.state !== 'cut' && rec.state !== 'failed') throw new CutError('NOT_CUT_YET', 'The cut has not finished');
    if (rec.state === 'failed' && (rec.sizeBytes === null || !fs.existsSync(this.stagedPath(rec)))) {
      throw new CutError('NOT_CUT_YET', 'Nothing staged to upload; start the cut again');
    }
    rec.state = 'uploading';
    rec.reason = null;
    this.persist(rec);
    this.track(rec, this.runUpload(rec, req));
    return view(rec);
  }

  drop(cutId: string): void {
    const rec = this.cuts.get(cutId);
    if (rec) rec.dropped = true;
    this.cuts.delete(cutId);
    if (!ID.test(cutId)) return;
    // A file still held open (Windows) can refuse deletion; drop must not throw.
    for (const ext of ['mp4', 'json']) {
      try {
        fs.rmSync(path.join(this.d.stagingDir, `${cutId}.${ext}`), { force: true });
      } catch (err) {
        console.warn(`drop ${cutId}.${ext}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Resolves when no cut or upload is running. For tests and a clean shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private async runCut(rec: Record_): Promise<void> {
    const out = this.stagedPath(rec);
    try {
      const source = this.d.library.sourceFor(rec.ref);
      if (!source) return this.finish(rec, { state: 'source_gone', reason: 'The recording was deleted from the PC' });

      // The master has one audio stream; an original still has every OBS track.
      rec.audioStream = path.basename(source) === 'master.mp4' ? 0 : this.d.mixAudioStream;
      fs.mkdirSync(this.d.stagingDir, { recursive: true });
      await this.d.cutFile({
        input: source, output: out, startS: rec.startS, endS: rec.endS,
        audioStream: rec.audioStream, videoCodec: rec.videoCodec,
      });
      if (rec.dropped) return this.discard(rec, out);
      this.finish(rec, { state: 'cut', sizeBytes: fs.statSync(out).size });
    } catch (err) {
      if (rec.dropped) return this.discard(rec, out);
      fs.rmSync(out, { force: true });
      // ffmpeg failing because its input disappeared is not a bug to chase.
      if (!this.d.library.sourceFor(rec.ref)) {
        this.finish(rec, { state: 'source_gone', reason: 'The recording was deleted from the PC' });
      } else {
        this.finish(rec, { state: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Remove what a dropped cut left behind, unless a fresh cut with the same id owns the file now. */
  private discard(rec: Record_, file: string): void {
    if (this.cuts.has(rec.cutId)) return;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn(`discard ${rec.cutId}:`, err instanceof Error ? err.message : err);
    }
  }

  private async runUpload(rec: Record_, req: UploadRequest): Promise<void> {
    const file = this.stagedPath(rec);
    let handle: fs.promises.FileHandle | undefined;
    try {
      fs.statSync(file);
      const size = rec.sizeBytes ?? 0;
      const count = Math.max(1, Math.ceil(size / req.partSize));
      const numbers = req.parts.map((p) => p.n).sort((a, b) => a - b);
      if (!(req.partSize > 0) || numbers.length !== count || numbers.some((n, i) => n !== i + 1)) {
        return this.finish(rec, { state: 'failed', reason: `Part list does not match the file size (${size} bytes, part size ${req.partSize})` });
      }
      if (rec.partSize !== undefined && rec.partSize !== req.partSize) rec.parts = [];
      rec.partSize = req.partSize;

      handle = await fs.promises.open(file, 'r');
      for (const part of [...req.parts].sort((a, b) => a.n - b.n)) {
        if (rec.dropped) return;
        if (rec.parts.some((p) => p.n === part.n)) continue; // landed on an earlier attempt
        const offset = (part.n - 1) * req.partSize;
        const length = Math.min(req.partSize, size - offset);
        const body = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(body, read, length - read, offset + read);
          if (bytesRead === 0) throw new Error('The staged cut is shorter than expected; start the cut again');
          read += bytesRead;
        }
        const etag = await this.putWithRetry(part.url, body);
        if (rec.dropped) return;
        rec.parts.push({ n: part.n, etag });
        this.persist(rec);
      }
      const etags = [...rec.parts].sort((a, b) => a.n - b.n).map((p) => ({ n: p.n, etag: p.etag }));
      this.d.library.recordUpload(rec.ref, rec.cutId, this.d.now());
      this.finish(rec, { state: 'done', etags });
    } catch (err) {
      const gone = !fs.existsSync(file);
      this.finish(rec, {
        state: 'failed',
        reason: gone ? 'The staged cut is gone; start the cut again' : err instanceof Error ? err.message : String(err),
      });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async putWithRetry(url: string, body: Buffer): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      try {
        return await this.d.putPart(url, body);
      } catch (err) {
        last = err;
        if (attempt < PART_ATTEMPTS) await this.d.sleep(Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
    throw new Error(`part upload gave up after ${PART_ATTEMPTS} attempts: ${last instanceof Error ? last.message : last}`);
  }

  private finish(rec: Record_, patch: Partial<AgentCut>): void {
    Object.assign(rec, patch);
    this.persist(rec);
  }

  /** Tracked work never rejects: an escaped error marks the record failed and is logged. */
  private track(rec: Record_, work: Promise<void>): void {
    const p: Promise<void> = work
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`cut ${rec.cutId}:`, reason);
        if (rec.dropped) return;
        rec.state = 'failed';
        rec.reason = reason;
        try {
          this.persist(rec);
        } catch {
          // The in-memory state is still right; there is nowhere to write it.
        }
      })
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  private stagedPath(rec: Pick<Record_, 'cutId'>): string {
    return path.join(this.d.stagingDir, `${rec.cutId}.mp4`);
  }

  private persist(rec: Record_): void {
    if (rec.dropped) return;
    fs.mkdirSync(this.d.stagingDir, { recursive: true });
    const file = path.join(this.d.stagingDir, `${rec.cutId}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...rec, dropped: undefined }));
    fs.renameSync(`${file}.tmp`, file);
  }
}

function view(r: Record_): AgentCut {
  return { cutId: r.cutId, state: r.state, sizeBytes: r.sizeBytes, etags: r.etags, reason: r.reason };
}
