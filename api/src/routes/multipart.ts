import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { getMultipartSession } from '../db/queries';
import { listUploadedParts, presignUploadPart } from '../services/s3';
import { deps } from '../deps';
import { abortUpload, completeUpload, openUploadSession } from '../usecases/uploads';
import { sendFailure } from './respond';

export const multipartRouter = Router();

const CreateSchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  // The show this upload belongs to — bound from the start so completion can
  // record the staged video server-side. Optional so a stale (pre-deploy) client
  // that doesn't send it still uploads instead of hard-failing with 400.
  showId: z.string().min(1).optional(),
});

// Start a session: create the S3 multipart upload and persist it.
multipartRouter.post('/create', async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
  try {
    const { filename, contentType, size, showId } = parsed.data;
    const out = await openUploadSession({ filename, contentType, size, showId: showId ?? null }, deps);
    res.status(201).json(out);
  } catch (err) {
    sendFailure(res, err, 'multipart create failed:', 'Failed to start multipart upload');
  }
});

// Resume info: which part numbers already landed (server is source of truth).
multipartRouter.get('/:sessionId', async (req, res) => {
  const s = await getMultipartSession(db, req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Unknown session' });
  try {
    const parts = s.status === 'in_progress' ? await listUploadedParts(s.s3_key, s.s3_upload_id) : [];
    res.json({
      sessionId: s.id,
      key: s.s3_key,
      filename: s.filename,
      size: Number(s.size_bytes),
      contentType: s.content_type,
      partSize: s.part_size,
      status: s.status,
      uploadedParts: parts.map((p) => ({ partNumber: p.PartNumber, size: p.Size })),
    });
  } catch (err) {
    console.error('multipart status failed:', err);
    res.status(500).json({ error: 'Failed to read session' });
  }
});

// Presigned URL to PUT a single part.
multipartRouter.post('/:sessionId/part/:n', async (req, res) => {
  const partNumber = Number(req.params.n);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return res.status(400).json({ error: 'Invalid part number' });
  }
  const s = await getMultipartSession(db, req.params.sessionId);
  if (!s || s.status !== 'in_progress') return res.status(404).json({ error: 'Session not open' });
  try {
    res.json({ url: await presignUploadPart(s.s3_key, s.s3_upload_id, partNumber) });
  } catch (err) {
    console.error('presign part failed:', err);
    res.status(500).json({ error: 'Failed to presign part' });
  }
});

multipartRouter.post('/:sessionId/complete', async (req, res) => {
  try {
    res.json(await completeUpload(req.params.sessionId, deps));
  } catch (err) {
    sendFailure(res, err, 'multipart complete failed:', 'Failed to complete upload');
  }
});

multipartRouter.post('/:sessionId/abort', async (req, res) => {
  try {
    await abortUpload(req.params.sessionId, deps);
    res.json({ ok: true });
  } catch (err) {
    sendFailure(res, err, 'multipart abort failed:', 'Failed to abort upload');
  }
});
