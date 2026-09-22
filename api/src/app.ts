import express from 'express';
import cors from 'cors';
import path from 'path';
import { showsRouter } from './routes/shows';
import { eventsRouter } from './routes/events';
import { multipartRouter } from './routes/multipart';
import { watcherRouter } from './routes/watcher';
import { publicRouter } from './routes/public';
import { presenceRouter } from './routes/presence';
import { presenceHub } from './services/presence-hub';
import { requireAuth } from './middleware/requireAuth';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from './trpc/root';
import { createContext } from './trpc/trpc';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Watcher uses its own API key — exempt from JWT auth
  app.use('/api/watcher', watcherRouter);

  // Deliberately unauthenticated: these are the permanent links stored on the
  // public agenda records, so they are fetched by browsers with no session. They
  // only ever redirect to a freshly signed URL for an already-published
  // recording — see routes/public.ts.
  app.use('/api/public', publicRouter);

  // Protected API — each router requires a valid Zitadel JWT with the member or admin role.
  // Scoped to the API only, so the static SPA below stays public (otherwise the
  // login page itself would be gated and the OIDC flow could never start).
  app.get('/api/auth/me', requireAuth, (_req, res) => res.json({ ok: true }));
  app.use('/api/shows', requireAuth, showsRouter);
  app.use('/api/uploads/multipart', requireAuth, multipartRouter);
  app.use('/api/uploads', requireAuth, eventsRouter);
  app.use('/api/presence', requireAuth, presenceRouter);

  // tRPC — the app's API. The REST routes above are only what tRPC can't carry
  // (raw bytes, SSE, presence, the watcher and public links). NOT behind
  // requireAuth globally: auth is per-procedure. protectedProcedure enforces the
  // same Zitadel JWT + member/admin role as requireAuth, while watcher procedures (next
  // phase) validate the shared WATCHER_API_KEY inside the procedure instead.
  app.use('/api/trpc', createExpressMiddleware({ router: appRouter, createContext }));

  presenceHub.startSweeper();

  // Public static UI + SPA fallback
  const uiDist = path.join(__dirname, '..', '..', 'ui', 'dist');
  app.use(express.static(uiDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(uiDist, 'index.html'));
  });

  return app;
}
