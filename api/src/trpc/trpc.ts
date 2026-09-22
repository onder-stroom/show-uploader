import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { verifyToken, type AuthUser } from '../auth/verify-token';

// The tRPC request context. `user` mirrors requireAuth's identity (null when not
// a valid member). `headers` is exposed as a plain record — deliberately NOT the
// Express request — so per-procedure auth (e.g. the watcher API key, added in a
// later phase) can read the Authorization header without the client type import
// coupling to Express types.
export interface Context {
  user: AuthUser | null;
  // Why there is no user, when a token was presented and refused. 503 means the
  // key set could not be fetched: nothing is known about the token, and telling
  // the client to sign in again would send it round the Zitadel loop for an
  // outage on our side.
  authStatus: 401 | 403 | 503 | null;
  headers: Record<string, string | string[] | undefined>;
}

export async function createContext({ req }: CreateExpressContextOptions): Promise<Context> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    console.warn(`Auth: no token on ${req.method} ${req.path}`);
    return { user: null, authStatus: 401, headers: req.headers };
  }
  const result = await verifyToken(token, `${req.method} ${req.path}`);
  return result.ok
    ? { user: result.user, authStatus: null, headers: req.headers }
    : { user: null, authStatus: result.status, headers: req.headers };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

// Enforce the same gate as requireAuth: a valid Zitadel JWT carrying the member or admin
// role. Downstream resolvers get a non-null `ctx.user`.
const enforceMember = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    // Only a token problem may surface as 401 — that is the answer the UI
    // reacts to by signing in again. A key-set failure must not, or an outage
    // reads as a dead session and the app bounces to Zitadel in a loop.
    if (ctx.authStatus === 503) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Auth backend unavailable' });
    }
    if (ctx.authStatus === 403) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Access not granted' });
    }
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Access not granted' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(enforceMember);
