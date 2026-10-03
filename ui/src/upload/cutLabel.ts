/** One cut as the api lists it. */
export type CutItem = {
  cutId: string;
  ref: string;
  showId: string;
  startS: number;
  endS: number;
  filename: string;
  createdAtMs: number;
  state: 'queued' | 'cutting' | 'uploading' | 'finishing' | 'done' | 'failed' | 'unknown';
  error: string | null;
};

export const RUNNING_STATES: readonly CutItem['state'][] = ['queued', 'cutting', 'uploading', 'finishing'];
export const isRunning = (c: Pick<CutItem, 'state'>) => RUNNING_STATES.includes(c.state);

/** How many of a recording's cuts are still going, for the list and the panel. */
export const runningCuts = (cuts: readonly CutItem[] | undefined, ref: string): number =>
  (cuts ?? []).filter((c) => c.ref === ref && isRunning(c)).length;

/** What to tell the operator about a cut, in plain words; `fraction` is the upload's 0..1 when known. */
export function cutLabel(c: Pick<CutItem, 'state' | 'error'>, fraction: number | null): string {
  switch (c.state) {
    case 'queued': return 'waiting its turn (cuts run one at a time)';
    case 'cutting': return 'cutting on the PC…';
    case 'uploading': return fraction === null ? 'uploading…' : `uploading ${Math.round(fraction * 100)}%`;
    case 'finishing': return 'finishing…';
    case 'done': return 'done: it is the show\'s video now, ready to publish on the upload page';
    case 'failed': return `failed: ${c.error ?? 'the cut did not finish'}`;
    default: return '';
  }
}
