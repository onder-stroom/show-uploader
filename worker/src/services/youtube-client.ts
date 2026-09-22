import { google } from 'googleapis';
import fs from 'fs';
import { env } from '../env';
import { shouldDryRun, simulateUpload } from './dry-run';
import { appendHashtags, sanitizeForYoutube, capTitle } from '@show-uploader/domain';

function getYouTubeClient() {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) {
    throw new Error('YouTube credentials not configured (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN)');
  }
  const auth = new google.auth.OAuth2(
    env.YOUTUBE_CLIENT_ID,
    env.YOUTUBE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth });
}

export async function uploadToYoutube(params: {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  onProgress?: (pct: number) => void;
}): Promise<string> {
  if (shouldDryRun([env.YOUTUBE_CLIENT_ID, env.YOUTUBE_CLIENT_SECRET, env.YOUTUBE_REFRESH_TOKEN])) {
    await simulateUpload('youtube', params.onProgress);
    return `https://www.youtube.com/watch?v=dryrun-${Date.now().toString(36)}`;
  }

  const youtube = getYouTubeClient();
  const stat = fs.statSync(params.videoPath);

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: sanitizeForYoutube(capTitle(params.title)),
          // Tags also go in the description as #hashtags — YouTube never shows
          // the tags field publicly, only description hashtags are visible.
          // sanitize: YouTube 400s on any `<`/`>` (a "<3" in the notes killed it).
          description: sanitizeForYoutube(appendHashtags(params.description, params.tags)),
          tags: params.tags,
          categoryId: '10', // Music
        },
        status: { privacyStatus: env.YOUTUBE_PRIVACY_STATUS },
      },
      media: {
        mimeType: 'video/x-matroska',
        body: fs.createReadStream(params.videoPath),
      },
    },
    {
      onUploadProgress: (evt: { bytesRead: number }) => {
        const pct = Math.round((evt.bytesRead / stat.size) * 100);
        params.onProgress?.(Math.min(99, pct));
      },
    }
  );

  const videoId = res.data.id;
  if (!videoId) throw new Error('YouTube upload returned no video ID');

  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Set a custom thumbnail on an uploaded video. Requires a channel enabled for
// custom thumbnails — callers should treat a failure as non-fatal.
export async function setYoutubeThumbnail(videoId: string, imagePath: string): Promise<void> {
  if (shouldDryRun([env.YOUTUBE_CLIENT_ID, env.YOUTUBE_CLIENT_SECRET, env.YOUTUBE_REFRESH_TOKEN])) return;
  const youtube = getYouTubeClient();
  await youtube.thumbnails.set({
    videoId,
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(imagePath) },
  });
}
