import fs from 'node:fs';
import type { Library } from './library';

/**
 * Remove recordings whose cuts are safely uploaded and old enough. The service has no
 * credentials for the api, so it cannot see archival; "last cut uploaded, plus the
 * retention period" is the rule it can enforce. A recording that was never cut is
 * never pruned. A file the operator already removed is success, not an error.
 */
export function pruneOnce(deps: { library: Library; retentionMs: number }, nowMs: number): { pruned: string[] } {
  const pruned: string[] = [];
  for (const s of deps.library.list()) {
    if (s.cuts.length === 0) continue;
    const newest = Math.max(...s.cuts.map((c) => c.uploadedAtMs));
    if (nowMs - newest < deps.retentionMs) continue;
    try {
      fs.rmSync(s.originalPath, { force: true });
      deps.library.remove(s.ref);
      pruned.push(s.ref);
    } catch (err) {
      // A locked file (OBS, a player) is tried again next tick.
      console.warn(`could not prune ${s.filename}:`, err instanceof Error ? err.message : err);
    }
  }
  return { pruned };
}
