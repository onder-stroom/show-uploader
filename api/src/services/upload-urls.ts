import { createDownloadPresignedUrl } from './s3';

// Replace private S3 keys with browser-reachable presigned download URLs so the
// UI can download the original video (any format) and the extracted audio
// independently — the bucket itself stays private.
export async function withDownloadUrls<
  T extends {
    video_s3_key: string;
    audio_s3_key: string | null;
    archive_s3_key: string | null;
    jobs: { platform: string; result_url: string | null }[];
  }
>(upload: T): Promise<T & { video_url: string; audio_url: string | null; archive_url: string | null }> {
  const [video_url, audio_url, archive_url] = await Promise.all([
    createDownloadPresignedUrl(upload.video_s3_key),
    upload.audio_s3_key ? createDownloadPresignedUrl(upload.audio_s3_key) : Promise.resolve(null),
    upload.archive_s3_key ? createDownloadPresignedUrl(upload.archive_s3_key) : Promise.resolve(null),
  ]);
  const jobs = await Promise.all(
    upload.jobs.map(async (j) =>
      // New archive jobs store the permanent public link (already a URL); only
      // legacy rows still hold a raw S3 key that needs presigning.
      j.platform === 'archive' && j.result_url && !j.result_url.startsWith('http')
        ? { ...j, result_url: await createDownloadPresignedUrl(j.result_url) }
        : j
    )
  );
  return { ...upload, video_url, audio_url, archive_url, jobs };
}
