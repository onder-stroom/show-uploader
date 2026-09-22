import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { env } from '../env';
import { requireAuth } from '../middleware/requireAuth';
import { updateArchiveRecord, resolveGenreIds } from '../services/shows-api';

export const watcherRouter = Router();

const NotifySchema = z.object({
  key: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
});

// POST /api/watcher/notify — called by the Windows watcher when a file lands on S3
watcherRouter.post('/notify', (req, res) => {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== env.WATCHER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = NotifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const { key, filename, sizeBytes } = parsed.data;

  // Store as a pending video so the UI can pick it up
  void db`
    INSERT INTO pending_videos (s3_key, filename, size_bytes)
    VALUES (${key}, ${filename}, ${sizeBytes})
    ON CONFLICT (s3_key) DO NOTHING
  `;

  console.log(`Watcher notified: ${filename} → ${key}`);
  res.json({ ok: true });
});

const ArchivePatchSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  // Free-text tag names — resolved to genre record IDs (PB is the master list).
  tags: z.array(z.string()).optional(),
  mediaLinks: z
    .array(z.object({ label: z.string(), type: z.string(), url: z.string().url() }))
    .optional(),
});

// PATCH /api/watcher/shows/:id — the worker writes the published result (platform
// links + finalised metadata) back onto the PocketBase archive record once all
// uploads succeed. API-key gated (same shared internal secret as the watcher), so
// PocketBase superuser creds stay in the api and never reach the worker.
watcherRouter.patch('/shows/:id', async (req, res) => {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (token !== env.WATCHER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const parsed = ArchivePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  try {
    const { tags, ...rest } = parsed.data;
    // Only touch the genres relation when tags were actually provided — an empty
    // array must NOT clear the record's curated genres (PocketBase is master).
    const genres = tags && tags.length ? await resolveGenreIds(tags) : [];
    await updateArchiveRecord(req.params.id, { ...rest, ...(genres.length ? { genres } : {}) });
    res.json({ ok: true });
  } catch (err) {
    console.error('Archive write-back failed:', err);
    res.status(502).json({ error: 'Archive write-back failed' });
  }
});
