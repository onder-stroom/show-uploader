/**
 * Whether an upload's platform work has finished. The archive job rewrites the
 * source video on S3, so it must never run while YouTube or MixCloud still
 * needs the original file. Mirrors the worker's own auto-enqueue condition.
 */
export function readyToArchive(jobs: { platform: string; status: string }[]): boolean {
  const platform = jobs.filter((j) => j.platform !== 'archive');
  return platform.length > 0 && platform.every((j) => j.status === 'done');
}

/**
 * Which platform a media link's label refers to, or null for anything else.
 *
 * Case-insensitive because these labels are hand-typed in the agenda admin and
 * production genuinely holds "Youtube" and "Mixcloud" beside "YouTube" and
 * "MixCloud". Matching exactly meant a show that WAS on YouTube looked
 * unpublished, which is how a duplicate upload gets created.
 */
export function platformOfLabel(label: string): 'youtube' | 'mixcloud' | null {
  const n = label.trim().toLowerCase();
  return n === 'youtube' ? 'youtube' : n === 'mixcloud' ? 'mixcloud' : null;
}
