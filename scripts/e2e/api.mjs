/**
 * Runs the BUILT api use cases (api/dist/usecases) on their REAL adapters
 * (api/dist/adapters.js: Postgres, S3, BullMQ) against the local stack, with the
 * built worker consuming whatever they queue — so the api↔worker hand-off is
 * exercised too, not just each side on its own.
 *
 * Only PocketBase (`agenda`) and the platform metadata sync are stubbed: there
 * is no local PocketBase, and the sync would call YouTube for real.
 */
import fs from 'fs';
import path from 'path';
import {
  bucket, database, env, makeJingle, makeRecording, reporter, requireFrom,
  scratchDir, startWorker, waitFor, writeBackStub,
} from './lib.mjs';

Object.assign(process.env, env);
const { showFolder } = requireFrom('api')('@show-uploader/domain');

export async function run() {
  const { check, finish } = reporter('api');
  const work = scratchDir('e2e-api-');
  const store = await bucket();
  const db = await database();
  const agendaStub = writeBackStub();
  const worker = startWorker();

  // Required before api/dist is loaded: its env is validated at import.
  const { createDeps } = requireFrom('api')('./dist/adapters.js');
  const publish = requireFrom('api')('./dist/usecases/publish.js');
  const archive = requireFrom('api')('./dist/usecases/archive.js');
  const metadata = requireFrom('api')('./dist/usecases/metadata.js');
  const recordings = requireFrom('api')('./dist/usecases/recordings.js');

  const agendaWrites = [];
  const show = {
    id: 'show-api-e2e', title: 'API E2E', description: '', tags: [], imageUrl: null,
    date: '2026-09-22', mediaLinks: [],
  };
  const deps = {
    ...createDeps(),
    agenda: {
      getShow: async (id) => (id === show.id ? show : null),
      update: async (id, patch) => void agendaWrites.push({ id, patch }),
      resolveGenres: async (names) => names.map((n) => `g-${n}`),
      liveState: async () => ({ isLive: false, resumeAt: null }),
    },
    platforms: { syncYoutube: async () => null, syncMixcloud: async () => null },
  };

  try {
    // Leftovers from an earlier run on a kept stack.
    await db`DELETE FROM show_uploads WHERE show_id = ${show.id}`;
    await db`DELETE FROM staged_uploads WHERE show_id = ${show.id}`;

    const name = 'apie2e_22.09.2026__coming_soon__2026-09-22_10-00-00.mkv';
    const recording = makeRecording(path.join(work, name));
    const sourceKey = `incoming/${Date.now()}-${name}`;
    await store.put(sourceKey, recording);
    await store.put(env.JINGLE_S3_KEY, makeJingle(path.join(work, 'jingle.m4a')));
    // A staged row is what makes a recording "awaiting publication".
    await db`INSERT INTO staged_uploads (show_id, s3_key, filename, size_bytes)
             VALUES (${show.id}, ${sourceKey}, ${name}, ${recording.length})`;

    // --- preview ---------------------------------------------------------------
    const started = await recordings.startPreview(sourceKey, deps);
    check('startPreview queues a remux', started.state === 'working', JSON.stringify(started));
    const previewKey = sourceKey.replace(/\.mkv$/, '.mp4');
    const ready = await waitFor('the preview', async () => {
      const state = await recordings.previewStatus(previewKey, deps).catch(() => null);
      return state?.state === 'ready' ? state : null;
    });
    check('previewStatus reports it ready', ready.state === 'ready', JSON.stringify(ready));
    const [staged] = await db`SELECT s3_key FROM staged_uploads WHERE show_id = ${show.id}`;
    check('staged row repointed at the preview mp4', staged?.s3_key === previewKey, staged?.s3_key);

    // The guard that keeps a caller from having any bucket object remuxed/deleted.
    const refused = await recordings.startPreview(env.JINGLE_S3_KEY, deps).then(() => null, (e) => e);
    check('startPreview refuses a key that is not awaiting publication', refused?.code === 'NOT_FOUND');

    // --- publish ---------------------------------------------------------------
    const published = await publish.publishUpload(
      {
        showId: show.id, title: 'API E2E 22.09.2026 @ coming soon', description: '<p>api</p>', tags: ['disco'],
        imageUrl: null, videoS3Key: previewKey, platforms: ['youtube', 'mixcloud'], includeJingle: true,
        autoTrimSilence: false, trimStart: '00:00:03', trimEnd: '00:00:13',
      },
      deps
    );
    check('publishUpload creates a row per platform',
      published.jobs.map((j) => j.platform).sort().join() === 'mixcloud,youtube');
    const [stagedLeft] = await db`SELECT count(*)::int AS n FROM staged_uploads WHERE show_id = ${show.id}`;
    check('publish clears the staged row (never the S3 object)', stagedLeft.n === 0 && (await store.keys()).includes(previewKey));

    const jobs = await waitFor('the publish pipeline', async () => {
      const rows = await db`SELECT id, platform, status, error, result_url FROM platform_jobs WHERE upload_id = ${published.uploadId}`;
      return rows.length >= 3 && rows.every((r) => r.status === 'done' || r.status === 'failed') ? rows : null;
    });
    for (const job of jobs) check(`${job.platform} job done via the worker`, job.status === 'done', job.error ?? job.result_url);

    const folder = showFolder(previewKey);
    const [row] = await db`SELECT video_s3_key, duration_seconds, jingle_s3_key FROM show_uploads WHERE id = ${published.uploadId}`;
    check('archived under the show folder', row.video_s3_key === `${folder}/video.mp4`, row.video_s3_key);
    check('the trim was applied (10s)', row.duration_seconds === 10, String(row.duration_seconds));
    check('configured jingle recorded on the upload', row.jingle_s3_key === env.JINGLE_S3_KEY);
    check('worker wrote the archive + platform links back', agendaStub.received.length === 3, `${agendaStub.received.length} PATCHes`);

    // --- retry a finished platform job -------------------------------------------
    const youtube = jobs.find((j) => j.platform === 'youtube');
    await publish.retryJob(published.uploadId, 'youtube', deps);
    const retried = await waitFor('the retried youtube job', async () => {
      const [r] = await db`SELECT status, result_url FROM platform_jobs WHERE id = ${youtube.id}`;
      return r.status === 'done' && r.result_url !== youtube.result_url ? r : null;
    });
    check('retryJob re-ran it on the archived mp4', !!retried, retried?.result_url);

    // --- metadata edit -----------------------------------------------------------
    const edit = { title: 'API E2E 22.09.2026 @ coming soon', description: 'edited', tags: ['house'] };
    const { sync } = await metadata.updateMetadata(published.uploadId, edit, deps);
    const [edited] = await db`SELECT description, tags FROM show_uploads WHERE id = ${published.uploadId}`;
    check('updateMetadata saved the edit in Postgres', edited.description === 'edited' && edited.tags[0] === 'house');
    check('updateMetadata reported every target', sync.youtube === 'ok' && sync.mixcloud === 'ok' && sync.pocketbase === 'ok', JSON.stringify(sync));
    check('the agenda got the plain title and genre ids',
      agendaWrites.at(-1)?.patch.title === 'API E2E' && agendaWrites.at(-1)?.patch.genres?.[0] === 'g-house');

    // --- shrink -------------------------------------------------------------------
    const before = await store.size(`${folder}/video.mp4`);
    await archive.compressArchivedVideo(show.id, deps);
    const shrunk = await waitFor('the shrink', async () => {
      const [r] = await db`SELECT status, error FROM platform_jobs WHERE upload_id = ${published.uploadId} AND platform = 'compress'`;
      return r && (r.status === 'done' || r.status === 'failed') ? r : null;
    });
    check('compress job done', shrunk.status === 'done', shrunk.error ?? '');
    check('the archive shrank in place', (await store.size(`${folder}/video.mp4`)) < before, `was ${before} bytes`);

    // --- the duplicate-publish guard ------------------------------------------------
    show.mediaLinks = [{ label: 'YouTube', type: 'video', url: 'https://youtu.be/x' }];
    const duplicate = await publish.publishToPlatform(show.id, 'youtube', deps).then(() => null, (e) => e);
    check('publishToPlatform refuses a platform the record already links', duplicate?.code === 'CONFLICT');
  } catch (err) {
    check('the run finished', false, err.stack ?? err.message);
  } finally {
    worker.stop();
    agendaStub.close();
    await db.end();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return finish(worker.log());
}
