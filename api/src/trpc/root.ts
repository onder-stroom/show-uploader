import { router } from './trpc';
import { showsRouter } from './routers/shows';
import { uploadsRouter } from './routers/uploads';
import { platformRouter } from './routers/platform';
import { watcherRouter } from './routers/watcher';
import { storageRouter } from './routers/storage';

// The app's API. Only what tRPC's batch link can't carry stays REST (see
// app.ts): multipart upload, raw cover bytes, the SSE streams (events,
// presence), the public recording links, and the watcher daemon + worker
// endpoints that authenticate with the shared API key.
export const appRouter = router({
  shows: showsRouter,
  uploads: uploadsRouter,
  platform: platformRouter,
  watcher: watcherRouter,
  storage: storageRouter,
});

export type AppRouter = typeof appRouter;
