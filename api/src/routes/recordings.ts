import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Router } from 'express';
import { z } from 'zod';
import type { ApiDeps } from '../ports';
import { verifyPreview } from '../services/preview-signature';
import { openCutSession } from '../usecases/recording-cuts';
import { abortUpload, completeUpload } from '../usecases/uploads';
import { sendFailure } from './respond';

const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Streams a recording's preview from the OBS PC. Authenticated by the signed token in the
 * query, not by a session: a <video> element cannot send an Authorization header. The
 * token is issued by `recordings.signPreview` and bound to one recording.
 */
export function createPreviewRouter(deps: Pick<ApiDeps, 'recordings' | 'config'>, now: () => number = Date.now): Router {
  const router = Router();

  router.get('/preview/:ref', async (req, res) => {
    const secret = deps.config.recordingsSecret;
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!secret || !(await verifyPreview(token, req.params.ref, secret, now()))) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }

    // Stop pulling from the PC the moment the viewer goes away (seeking cancels requests).
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const upstream = await deps.recordings.preview(req.params.ref, req.headers.range, abort.signal);
    if (!upstream) return res.status(502).json({ error: 'The OBS PC is not reachable' });

    res.status(upstream.status);
    for (const name of PASS_THROUGH) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) return res.end();
    const body = Readable.fromWeb(upstream.body as never);
    body.on('error', () => res.destroy());
    body.pipe(res);
  });

  return router;
}

const OpenBody = z.object({
  showId: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().positive(),
  ref: z.string().min(1),
  startS: z.number().finite(),
  endS: z.number().finite(),
});

function keyMatches(header: string | undefined, key: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * What the worker's cut-recording job calls. Gated by the shared internal key, like the
 * worker's other write-backs, so the PC and the browser never need it.
 */
export function createInternalRecordingsRouter(deps: Pick<ApiDeps, 'objects' | 'sessions' | 'agenda'>, apiKey: string): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (keyMatches(req.headers.authorization, apiKey)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  });

  router.post('/cuts/:cutId/session', async (req, res) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid body' });
    try {
      res.json(await openCutSession({ cutId: req.params.cutId, ...body.data }, deps));
    } catch (err) {
      sendFailure(res, err, 'open cut session failed:', 'Failed to open the upload session');
    }
  });

  router.post('/sessions/:sessionId/complete', async (req, res) => {
    try {
      res.json(await completeUpload(req.params.sessionId, deps));
    } catch (err) {
      sendFailure(res, err, 'complete cut session failed:', 'Failed to complete the upload');
    }
  });

  router.post('/sessions/:sessionId/abort', async (req, res) => {
    try {
      await abortUpload(req.params.sessionId, deps);
      res.json({ ok: true });
    } catch (err) {
      sendFailure(res, err, 'abort cut session failed:', 'Failed to abort the upload');
    }
  });

  return router;
}
