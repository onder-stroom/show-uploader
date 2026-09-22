/**
 * Runs the BUILT worker (worker/dist) against the local stack and checks what
 * the pipeline actually wrote: S3 objects, upload rows, agenda write-backs.
 *
 * Platforms are simulated by the worker's own dry-run mode, so nothing is ever
 * published. Everything else — ffmpeg, S3, Postgres, Redis — is real.
 */
import fs from 'fs';
import path from 'path';
import {
  bucket, database, env, makeRecording, probeSeconds, reporter, requireFrom,
  scratchDir, startWorker, waitFor, writeBackStub,
} from './lib.mjs';

const { Queue } = requireFrom('worker')('bullmq');
const IORedis = requireFrom('worker')('ioredis');
const { showFolder } = requireFrom('worker')('@show-uploader/domain');

export async function run() {
  const { check, finish } = reporter('worker');
  const work = scratchDir('e2e-worker-');
  const store = await bucket();
  const db = await database();
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const agenda = writeBackStub();
  const worker = startWorker();

  try {
    // Leftovers from an earlier run on a kept stack.
    await db`DELETE FROM show_uploads WHERE show_id = 'show-e2e'`;
    await db`DELETE FROM pending_videos WHERE filename LIKE 'e2epreview%'`;

    // A recording named the way OBS leaves them, staged where the watcher drops it.
    const name = 'e2etest_22.09.2026__coming_soon__2026-09-22_10-00-00.mkv';
    const recording = makeRecording(path.join(work, name));
    const sourceKey = `incoming/${Date.now()}-${name}`;
    await store.put(sourceKey, recording);

    const [upload] = await db`
      INSERT INTO show_uploads (show_id, title, description, tags, image_url, video_s3_key, jingle_s3_key, trim_start, trim_end)
      VALUES ('show-e2e', 'E2E Test 22.09.2026 @ coming soon', '<p>test</p>', ${['disco']}, null, ${sourceKey}, null, '00:00:02', '00:00:15')
      RETURNING id`;
    const newJob = async (platform) =>
      (await db`INSERT INTO platform_jobs (upload_id, platform) VALUES (${upload.id}, ${platform}) RETURNING id`)[0].id;
    const archiveJobId = await newJob('archive');
    await newJob('youtube');
    await newJob('mixcloud');

    const uploads = new Queue('platform-uploads', { connection: redis });
    await uploads.add('archive', {
      jobId: archiveJobId, uploadId: upload.id, platform: 'archive', videoS3Key: sourceKey,
      title: 'E2E Test 22.09.2026 @ coming soon', description: '<p>test</p>', tags: ['disco'], imageUrl: null,
      jingleS3Key: null, includeJingle: false, autoTrimSilence: false, trimStart: '00:00:02', trimEnd: '00:00:15',
    });

    // The archive job is the only one queued: it starts the platforms itself.
    const jobs = await waitFor('the publish pipeline', async () => {
      const rows = await db`SELECT platform, status, result_url, error FROM platform_jobs WHERE upload_id = ${upload.id}`;
      return rows.every((r) => r.status === 'done' || r.status === 'failed') ? rows : null;
    });
    for (const job of jobs) check(`${job.platform} job done`, job.status === 'done', job.error ?? job.result_url);

    const folder = showFolder(sourceKey);
    const videoKey = `${folder}/video.mp4`;
    const audioKey = `${folder}/audio.m4a`;
    const [row] = await db`SELECT video_s3_key, audio_s3_key, trim_start, trim_end, duration_seconds FROM show_uploads WHERE id = ${upload.id}`;
    check('upload repointed at the archived mp4', row.video_s3_key === videoKey, row.video_s3_key);
    check('audio key recorded', row.audio_s3_key === audioKey, row.audio_s3_key);
    check('trim cleared, so a retry cannot cut twice', row.trim_start === null && row.trim_end === null);
    check('duration is the trimmed length', row.duration_seconds === 13, String(row.duration_seconds));

    const keys = await store.keys();
    check('source recording deleted', !keys.includes(sourceKey));
    check('archived video + audio on S3', keys.includes(videoKey) && keys.includes(audioKey), keys.join(', '));

    // One write-back for the archive links, one per platform, all key-authenticated.
    const labels = agenda.received.flatMap((p) => p.body.mediaLinks ?? []).map((l) => l.label);
    check('write-backs go to the watcher route with the api key',
      agenda.received.length === 3 &&
        agenda.received.every((p) => p.method === 'PATCH' && p.url === '/api/watcher/shows/show-e2e' && p.auth === `Bearer ${env.WATCHER_API_KEY}`),
      `${agenda.received.length} PATCHes`);
    check('archive + platform links written back',
      ['cs-archive-video', 'cs-archive-audio', 'YouTube', 'MixCloud'].every((l) => labels.includes(l)), labels.join(', '));
    check('the agenda keeps the plain title, not the platform one',
      agenda.received.filter((p) => p.body.title).every((p) => p.body.title === 'E2E Test'));

    const archived = path.join(work, 'archived.mp4');
    fs.writeFileSync(archived, await store.get(videoKey));
    const seconds = probeSeconds(archived);
    check('archived mp4 really is trimmed (~13s)', Math.abs(seconds - 13) < 1, `${seconds.toFixed(2)}s`);

    // --- shrink the archive in place -----------------------------------------
    const before = await store.size(videoKey);
    const [compressJob] = await db`INSERT INTO platform_jobs (upload_id, platform) VALUES (${upload.id}, 'compress') RETURNING id`;
    await new Queue('compress-jobs', { connection: redis }).add('compress', {
      jobId: compressJob.id, uploadId: upload.id, platform: 'compress', videoS3Key: videoKey,
      title: '', description: '', tags: [], imageUrl: null, jingleS3Key: null, includeJingle: false,
      trimStart: null, trimEnd: null,
    });
    const compressed = await waitFor('the shrink', async () => {
      const [r] = await db`SELECT status, error FROM platform_jobs WHERE id = ${compressJob.id}`;
      return r.status === 'done' || r.status === 'failed' ? r : null;
    });
    check('compress job done', compressed.status === 'done', compressed.error ?? '');
    check('compress shrank the archive in place', (await store.size(videoKey)) < before, `was ${before} bytes`);

    // --- preview remux of a not-yet-published recording ------------------------
    const pendingKey = `incoming/${Date.now()}-e2epreview_22.09.2026.mkv`;
    await store.put(pendingKey, recording);
    await db`INSERT INTO pending_videos (s3_key, filename, size_bytes) VALUES (${pendingKey}, 'e2epreview.mkv', 1)`;
    const previews = new Queue('video-previews', { connection: redis });
    const previewJob = await previews.add('preview', { videoS3Key: pendingKey }, { jobId: `e2e-preview-${Date.now()}` });
    const state = await waitFor('the preview', async () => {
      const s = await previewJob.getState();
      return s === 'completed' || s === 'failed' ? s : null;
    });
    const mp4Key = pendingKey.replace(/\.mkv$/, '.mp4');
    const [pending] = await db`SELECT s3_key FROM pending_videos WHERE s3_key IN (${pendingKey}, ${mp4Key})`;
    const afterPreview = await store.keys('incoming/');
    check('preview job completed', state === 'completed', previewJob.failedReason ?? '');
    check('pending row repointed at the mp4', pending?.s3_key === mp4Key, pending?.s3_key);
    check('preview replaced the mkv on S3', afterPreview.includes(mp4Key) && !afterPreview.includes(pendingKey));
  } catch (err) {
    check('the run finished', false, err.stack ?? err.message);
  } finally {
    worker.stop();
    agenda.close();
    await redis.quit();
    await db.end();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return finish(worker.log());
}
