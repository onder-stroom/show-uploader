import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AGENT_PROTOCOL, parseDraftSegments, type AgentHealth, type AgentRecording } from '@show-uploader/domain';
import { BUILD_ID } from './build';
import { CutError, type CutManager } from './cuts';
import type { Library, Sidecar } from './library';

const CutBody = z
  .object({
    cutId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    ref: z.string().min(1),
    startS: z.number().finite().min(0),
    endS: z.number().finite(),
  })
  .refine((b) => b.endS > b.startS, { message: 'endS must be after startS' });

const UploadBody = z.object({
  partSize: z.number().int().positive(),
  parts: z.array(z.object({ n: z.number().int().min(1), url: z.string().url() })).min(1),
});

function toRecording(s: Sidecar, hasDraft: boolean): AgentRecording {
  return {
    hasDraft,
    ref: s.ref, filename: s.filename, sizeBytes: s.sizeBytes, mtimeMs: s.mtimeMs,
    durationS: s.durationS, state: s.state, hasPreview: s.hasPreview, recordedAtMs: s.recordedAtMs,
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createServer(deps: {
  token: string;
  library: Library;
  cuts: CutManager;
  status(): { recordingActive: boolean };
}): express.Express {
  const app = express();
  // Auth first, so unauthenticated callers never reach body parsing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7), deps.token)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  // A part list is ~700 bytes per presigned URL (one per 16 MiB part): 16 MB covers a
  // segment of ~300 GB, far past what a recording gives.
  app.use(express.json({ limit: '16mb' }));

  app.get('/v1/health', (_req, res) => {
    const all = deps.library.list();
    const health: AgentHealth = {
      ok: true,
      protocol: AGENT_PROTOCOL,
      build: BUILD_ID,
      ready: all.filter((s) => s.state === 'ready').length,
      preparing: all.filter((s) => s.state === 'preparing').length,
      failed: all.filter((s) => s.state === 'failed').length,
      ...deps.status(),
    };
    res.json(health);
  });

  app.get('/v1/recordings', (_req, res) => {
    res.json(deps.library.list().map((s) => toRecording(s, deps.library.hasDraft(s.ref))));
  });

  // Look at the folder now instead of at the next background pass, which waits for a
  // running prepare to finish. Cheap: it only lists the folder.
  app.post('/v1/rescan', (_req, res) => {
    deps.library.sync(Date.now());
    res.json(deps.library.list().map((s) => toRecording(s, deps.library.hasDraft(s.ref))));
  });

  app.get('/v1/recordings/:ref/preview', (req, res) => {
    const s = deps.library.get(req.params.ref);
    const file = s?.hasPreview ? path.resolve(deps.library.paths(s.ref).preview) : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no preview' });
    // sendFile handles Range, If-Range and conditional requests itself. `dotfiles: 'allow'`
    // is essential: the work folder is `.show-uploader`, and send answers 404 for any path
    // containing a dot-segment by default.
    res.type('video/mp4').sendFile(file, { acceptRanges: true, dotfiles: 'allow' }, (err) => {
      if (!err) return;
      console.error('preview failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    });
  });

  // The operator's saved segments. 404 carries a code so the caller can tell "no draft yet" from "no such recording".
  app.get('/v1/recordings/:ref/draft', (req, res) => {
    if (!deps.library.get(req.params.ref)) return res.status(404).json({ error: 'unknown recording', code: 'UNKNOWN_RECORDING' });
    const draft = deps.library.getDraft(req.params.ref);
    if (!draft) return res.status(404).json({ error: 'no draft', code: 'NO_DRAFT' });
    res.json(draft);
  });

  app.put('/v1/recordings/:ref/draft', (req, res) => {
    const segments = parseDraftSegments((req.body as { segments?: unknown } | undefined)?.segments);
    if (!segments) return res.status(400).json({ error: 'invalid segments', code: 'BAD_SEGMENTS' });
    const draft = deps.library.saveDraft(req.params.ref, segments, Date.now());
    if (!draft) return res.status(404).json({ error: 'unknown recording', code: 'UNKNOWN_RECORDING' });
    res.json(draft);
  });

  app.get('/v1/recordings/:ref/peaks', (req, res) => {
    const s = deps.library.get(req.params.ref);
    const file = s?.hasPeaks ? deps.library.paths(s.ref).peaks : null;
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'no peaks' });
    res.type('application/json').send(fs.readFileSync(file));
  });

  app.post('/v1/cuts', (req, res) => {
    const body = CutBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    try {
      res.status(202).json(deps.cuts.start(body.data));
    } catch (err) {
      sendCutError(res, err);
    }
  });

  app.get('/v1/cuts/:cutId', (req, res) => {
    const cut = deps.cuts.get(req.params.cutId);
    if (!cut) return res.status(404).json({ error: 'unknown cut' });
    res.json(cut);
  });

  app.post('/v1/cuts/:cutId/upload', (req, res) => {
    const body = UploadBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body' });
    try {
      res.status(202).json(deps.cuts.upload(req.params.cutId, body.data));
    } catch (err) {
      sendCutError(res, err);
    }
  });

  app.delete('/v1/cuts/:cutId', (req, res) => {
    deps.cuts.drop(req.params.cutId);
    res.status(204).end();
  });

  // Express 4's default handler would answer with an HTML stack trace.
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed' || err.status === 400 || err.status === 413) {
      res.status(err.status ?? 400).json({ error: 'invalid body' });
      return;
    }
    console.error('request failed:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

function sendCutError(res: Response, err: unknown): void {
  if (err instanceof CutError) {
    const status = err.code === 'NOT_CUT_YET' ? 409 : err.code === 'BAD_ID' ? 400 : 404;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('cut request failed:', err);
  res.status(500).json({ error: 'internal error' });
}
