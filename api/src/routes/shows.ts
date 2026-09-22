import { Router, raw } from 'express';
import { uploadArchiveImage, clearArchiveImage } from '../services/shows-api';

// Only the cover stays REST: its body is raw image bytes, which tRPC's JSON
// batch link can't carry. Everything else about shows is in trpc/routers/shows.ts.
export const showsRouter = Router();

// Cover image = the archive record's `image` field in PocketBase (the master).
// The browser can't hold PB creds, so it POSTs the raw image bytes here and the
// api proxies them into PB. No S3 involved. 15 MiB cap — covers are small.
showsRouter.post('/:id/cover', raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Empty image body' });
  const contentType = req.headers['content-type'] ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
  const filename = `cover.${contentType.split('/')[1]?.split(';')[0] || 'jpg'}`;
  try {
    const imageUrl = await uploadArchiveImage(req.params.id, body, filename, contentType);
    res.json({ imageUrl });
  } catch (err) {
    console.error('Failed to upload cover:', err);
    res.status(502).json({ error: 'Failed to upload cover' });
  }
});

showsRouter.delete('/:id/cover', async (req, res) => {
  try {
    await clearArchiveImage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to clear cover:', err);
    res.status(502).json({ error: 'Failed to clear cover' });
  }
});
