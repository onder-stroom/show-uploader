// Packs the service into one file for the OBS PC and stamps it with the commit it was built from,
// so /v1/health can say which build is running.
import { execSync } from 'node:child_process';
import { build } from 'esbuild';

const git = (cmd, fallback) => {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
};
// A bundle built from uncommitted changes must not claim to be that commit.
const id = git('rev-parse --short HEAD', 'unknown') + (git('status --porcelain -- .', '') ? '-dirty' : '');

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/recordings-service.js',
  define: { __BUILD_ID__: JSON.stringify(id) },
});
console.log(`bundled dist/recordings-service.js (build ${id})`);
