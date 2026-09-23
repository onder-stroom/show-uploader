import postgres from 'postgres';
import { env } from '../env';

// TLS comes from the connection string: postgres.js reads `?sslmode=` off it.
// The stack's own Postgres sits on the isolated docker network and needs none;
// a managed host (Neon) is reached with `?sslmode=require`. Hardcoding 'require'
// here made the in-stack database unreachable.
export const db = postgres(env.DATABASE_URI, {
  max: 10,
});
