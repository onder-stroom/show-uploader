/**
 * `pnpm e2e` — build everything, start a throwaway MinIO + Postgres + Redis,
 * run the worker and api checks against the built output, then tear it down.
 *
 * Nothing here touches production: the stack is local, the platforms run in
 * dry-run mode, and PocketBase is a stub. Needs docker and ffmpeg.
 */
import { execFileSync } from 'child_process';
import { ROOT, stackDown, stackUp } from './lib.mjs';

const only = process.argv[2]; // 'worker' | 'api', default both

if (process.argv.includes('--help')) {
  console.log('usage: pnpm e2e [worker|api] [--keep]\n  --keep  leave the containers running for inspection');
  process.exit(0);
}

console.log('building…');
execFileSync('pnpm', ['--filter', '@show-uploader/api', '--filter', '@show-uploader/worker', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log('starting the local stack…');
await stackUp();

let failed = 0;
try {
  if (only !== 'api') {
    const { run } = await import('./worker.mjs');
    failed += await run();
  }
  if (only !== 'worker') {
    const { run } = await import('./api.mjs');
    failed += await run();
  }
} finally {
  if (process.argv.includes('--keep')) console.log('\ncontainers left running: e2e-minio, e2e-pg, e2e-redis');
  else stackDown();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
