import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDraftSegments, type DraftSegment, type RecordingDraft, type RecordingState } from '@show-uploader/domain';

/**
 * The recordings on disk, as the service sees them. The folder is the source of
 * truth: there is no database. A recording is whatever file OBS left behind, plus
 * a disposable sidecar of derived state. The operator may delete the MKV or the
 * derived MP4 at any time, and nothing here treats that as an error.
 */

const VIDEO_EXT = new Set(['.mkv', '.mp4']);
/** Exactly what recordingRef produces; anything else must never reach the filesystem. */
const REF_RE = /^[0-9a-f]{16}$/;

export type Original = {
  ref: string;
  filename: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  birthMs: number;
};

export type Sidecar = {
  ref: string;
  filename: string;
  originalPath: string;
  recordedAtMs: number;
  sizeBytes: number;
  mtimeMs: number;
  state: RecordingState;
  error: string | null;
  durationS: number | null;
  videoCodec: string | null;
  hasMaster: boolean;
  hasPreview: boolean;
  hasPeaks: boolean;
  cuts: { cutId: string; uploadedAtMs: number }[];
};

export type WorkPaths = { dir: string; master: string; preview: string; peaks: string; state: string; draft: string };

export function recordingRef(filename: string, sizeBytes: number, mtimeMs: number): string {
  return createHash('sha1').update(`${filename}\0${sizeBytes}\0${Math.floor(mtimeMs)}`).digest('hex').slice(0, 16);
}

/**
 * OBS names files "2026-10-01 20-05-09" or, with "Generate file name without space",
 * "2026-10-01_20-05-09", in the PC's local time. That is when recording started.
 */
export function parseRecordedAt(filename: string, fallbackMs: number): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/.exec(filename);
  if (!m) return fallbackMs;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

export class Library {
  /** Recordings that ffmpeg is reading or writing right now, with how many holders each has. */
  private readonly pins = new Map<string, number>();

  constructor(private readonly o: { recordingsDir: string; workDir: string; stableWindowMs: number }) {}

  /**
   * Mark a recording as in use, so a sync cannot delete its work folder under a running
   * ffmpeg. Returns the release; call it when the work ends, however it ends.
   */
  pin(ref: string): () => void {
    this.pins.set(ref, (this.pins.get(ref) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.pins.get(ref) ?? 1) - 1;
      if (n > 0) this.pins.set(ref, n);
      else this.pins.delete(ref);
    };
  }

  paths(ref: string): WorkPaths {
    if (!REF_RE.test(ref)) throw new Error(`invalid recording ref: ${JSON.stringify(ref)}`);
    const dir = path.join(this.o.workDir, 'recordings', ref);
    return {
      dir,
      master: path.join(dir, 'master.mp4'),
      preview: path.join(dir, 'preview.mp4'),
      peaks: path.join(dir, 'peaks.json'),
      state: path.join(dir, 'state.json'),
      // Its own file, not part of the sidecar: preparing rewrites the whole sidecar from its own copy and
      // would overwrite a draft saved meanwhile.
      draft: path.join(dir, 'draft.json'),
    };
  }

  /**
   * Scan the folder, register new stable files, and forget recordings whose original was
   * deleted. The derived files go with it: the operator removed the recording, so a card
   * for it is noise. A recording in use is left for the next scan.
   */
  sync(nowMs: number): { recordingActive: boolean } {
    const { ready, growing } = this.scan(nowMs);

    // A ref directory without a readable sidecar is garbage: derived files are disposable.
    // If the original still exists, it is re-registered and re-prepared.
    for (const ref of this.refDirs()) {
      if (!this.get(ref)) this.remove(ref);
    }

    const known = new Set(this.list().map((s) => s.ref));

    for (const o of ready) {
      if (known.has(o.ref)) continue;
      // Same file, new size/mtime: the content changed, so the old derived files are stale.
      for (const old of this.list()) {
        if (old.originalPath === o.path && old.ref !== o.ref) this.remove(old.ref);
      }
      this.save({
        ref: o.ref,
        filename: o.filename,
        originalPath: o.path,
        recordedAtMs: parseRecordedAt(o.filename, o.birthMs),
        sizeBytes: o.sizeBytes,
        mtimeMs: o.mtimeMs,
        state: 'preparing',
        error: null,
        durationS: null,
        videoCodec: null,
        hasMaster: false,
        hasPreview: false,
        hasPeaks: false,
        cuts: [],
      });
    }

    for (const s of this.list()) {
      if (fs.existsSync(s.originalPath) || this.pins.has(s.ref)) continue;
      try {
        this.remove(s.ref);
      } catch (err) {
        // A file a player still holds open (Windows) refuses deletion; the next scan tries again.
        console.warn(`could not forget ${s.filename}:`, err instanceof Error ? err.message : err);
      }
    }
    return { recordingActive: growing.length > 0 };
  }

  /** Ref-named directories under the work folder, valid sidecar or not. */
  private refDirs(): string[] {
    try {
      return fs.readdirSync(path.join(this.o.workDir, 'recordings')).filter((n) => REF_RE.test(n));
    } catch {
      return [];
    }
  }

  list(): Sidecar[] {
    const out: Sidecar[] = [];
    for (const ref of this.refDirs()) {
      const s = this.get(ref);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.recordedAtMs - a.recordedAtMs);
  }

  get(ref: string): Sidecar | null {
    if (!REF_RE.test(ref)) return null;
    try {
      const s = JSON.parse(fs.readFileSync(this.paths(ref).state, 'utf8'));
      const ok =
        s && typeof s === 'object' && typeof s.ref === 'string' && typeof s.originalPath === 'string' && Array.isArray(s.cuts);
      return ok ? (s as Sidecar) : null;
    } catch {
      return null;
    }
  }

  save(s: Sidecar): void {
    const p = this.paths(s.ref);
    fs.mkdirSync(p.dir, { recursive: true });
    // Write-then-rename so a crash never leaves a half-written sidecar.
    const tmp = `${p.state}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p.state);
  }

  /** The operator's saved segments for this recording; null when there are none or the file is unreadable. */
  getDraft(ref: string): RecordingDraft | null {
    if (!REF_RE.test(ref)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.paths(ref).draft, 'utf8')) as { segments?: unknown; savedAtMs?: unknown };
      const segments = parseDraftSegments(raw.segments);
      return segments && typeof raw.savedAtMs === 'number' ? { segments, savedAtMs: raw.savedAtMs } : null;
    } catch {
      return null; // a missing or corrupt draft is simply no draft
    }
  }

  hasDraft(ref: string): boolean {
    return REF_RE.test(ref) && fs.existsSync(this.paths(ref).draft);
  }

  /** Save the operator's segments next to the recording. An empty list clears the draft. Null for an unknown recording. */
  saveDraft(ref: string, segments: DraftSegment[], nowMs: number): RecordingDraft | null {
    if (!this.get(ref)) return null;
    const p = this.paths(ref);
    const draft: RecordingDraft = { segments, savedAtMs: nowMs };
    if (segments.length === 0) {
      fs.rmSync(p.draft, { force: true });
      return draft;
    }
    // Write-then-rename, like the sidecar: a crash never leaves half a draft.
    const tmp = `${p.draft}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(draft));
    fs.renameSync(tmp, p.draft);
    return draft;
  }

  /** The file a cut reads: the MP4 master if there is one, else the original, else nothing. */
  sourceFor(ref: string): string | null {
    const s = this.get(ref);
    if (!s) return null;
    const master = this.paths(ref).master;
    if (s.hasMaster && fs.existsSync(master)) return master;
    return fs.existsSync(s.originalPath) ? s.originalPath : null;
  }

  recordUpload(ref: string, cutId: string, atMs: number): void {
    const s = this.get(ref);
    if (!s || s.cuts.some((c) => c.cutId === cutId)) return;
    this.save({ ...s, cuts: [...s.cuts, { cutId, uploadedAtMs: atMs }] });
  }

  remove(ref: string): void {
    if (!REF_RE.test(ref)) return;
    fs.rmSync(this.paths(ref).dir, { recursive: true, force: true });
  }

  private scan(nowMs: number): { ready: Original[]; growing: Original[] } {
    const ready: Original[] = [];
    const growing: Original[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.o.recordingsDir);
    } catch {
      return { ready, growing };
    }
    for (const filename of names) {
      if (filename.startsWith('.')) continue;
      if (!VIDEO_EXT.has(path.extname(filename).toLowerCase())) continue;
      const full = path.join(this.o.recordingsDir, filename);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (!st.isFile()) continue;
      const o: Original = {
        ref: recordingRef(filename, st.size, st.mtimeMs),
        filename,
        path: full,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        birthMs: st.birthtimeMs || st.mtimeMs,
      };
      (nowMs - st.mtimeMs >= this.o.stableWindowMs ? ready : growing).push(o);
    }
    return { ready, growing };
  }
}
