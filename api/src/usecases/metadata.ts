import { baseTitle } from '@show-uploader/domain';
import { db } from '../db/client';
import { getUploadWithJobs, updateUploadMetadata } from '../db/queries';
import { syncMixcloudMetadata, syncYoutubeMetadata } from '../services/platform-metadata';
import { resolveGenreIds, updateArchiveRecord } from '../services/shows-api';
import { UseCaseError } from './errors';

export type MetadataEdit = { title: string; description: string; tags: string[] };

/**
 * Edit published metadata and push it to the local DB, each published platform,
 * and the PocketBase archive record. Platform failures are reported per target
 * (`sync`), not fatal — the DB always updates so the operator's edit isn't lost.
 */
export async function updateMetadata(uploadId: string, edit: MetadataEdit) {
  const upload = await getUploadWithJobs(db, uploadId);
  if (!upload) throw new UseCaseError('NOT_FOUND', 'Upload not found');

  await updateUploadMetadata(db, upload.id, edit);

  const sync: Record<string, 'ok' | string> = {};
  const yt = upload.jobs.find((j) => j.platform === 'youtube' && j.status === 'done' && j.result_url);
  const mc = upload.jobs.find((j) => j.platform === 'mixcloud' && j.status === 'done' && j.result_url);

  const [ytErr, mcErr] = await Promise.all([
    yt ? syncYoutubeMetadata(yt.result_url!, edit) : Promise.resolve<string | null>(null),
    mc ? syncMixcloudMetadata(mc.result_url!, edit) : Promise.resolve<string | null>(null),
  ]);
  if (yt) sync.youtube = ytErr ?? 'ok';
  if (mc) sync.mixcloud = mcErr ?? 'ok';

  try {
    // Tags are the PocketBase genres relation (PB is master) — resolve the
    // edited names to genre IDs (creating any new ones). Only write the relation
    // when tags are present, so clearing tags never wipes curated genres.
    const genres = edit.tags.length ? await resolveGenreIds(edit.tags) : [];
    // Re-assert the published platform links too, so an edit fully re-syncs the
    // archive record (e.g. after a write-back that failed at publish time).
    const mediaLinks: { label: string; type: string; url: string }[] = [];
    if (yt) mediaLinks.push({ label: 'YouTube', type: 'video', url: yt.result_url! });
    if (mc) mediaLinks.push({ label: 'MixCloud', type: 'audio', url: mc.result_url! });
    await updateArchiveRecord(upload.show_id, {
      // The archive record keeps the plain title; the date/@coming-soon suffix
      // is only for the platform titles.
      title: baseTitle(edit.title),
      notes: edit.description,
      ...(genres.length ? { genres } : {}),
      ...(mediaLinks.length ? { mediaLinks } : {}),
    });
    sync.pocketbase = 'ok';
  } catch (err) {
    sync.pocketbase = err instanceof Error ? err.message : String(err);
  }

  return { sync };
}
