import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { shouldDryRun, simulateUpload } from './dry-run';
import { capTitle } from '@show-uploader/domain';

type MixcloudResponse = {
  key?: string;
  result?: { key?: string; success?: boolean; message?: string };
  error?: { message: string };
};

export async function uploadToMixcloud(params: {
  audioPath: string;
  title: string;
  description: string;
  tags: string[];
  imagePath?: string;
}): Promise<string> {
  if (shouldDryRun([env.MIXCLOUD_ACCESS_TOKEN])) {
    await simulateUpload('mixcloud');
    return `https://www.mixcloud.com/dryrun-${Date.now().toString(36)}/`;
  }
  // Use the native (web) FormData + Blob so Node's fetch emits a well-formed
  // multipart body with a correct Content-Length. Streaming the npm `form-data`
  // package through global fetch produced a body MixCloud rejected with an opaque
  // 400 PostValidationError. Buffer the audio (it's already a temp file on disk).
  const audioBuf = await fs.promises.readFile(params.audioPath);
  const form = new FormData();
  form.append('mp3', new Blob([audioBuf], { type: 'audio/mp4' }), path.basename(params.audioPath));
  form.append('name', capTitle(params.title));
  if (params.description) form.append('description', params.description);
  params.tags.slice(0, 5).forEach((tag, i) => {
    form.append(`tags-${i}-tag`, tag);
  });
  if (params.imagePath && fs.existsSync(params.imagePath)) {
    const imgBuf = await fs.promises.readFile(params.imagePath);
    form.append('picture', new Blob([imgBuf]), path.basename(params.imagePath));
  }

  const token = env.MIXCLOUD_ACCESS_TOKEN;
  // The upload endpoint is /upload/ — /me/cloudcast/ is retired and returns 405.
  const res = await fetch(`https://api.mixcloud.com/upload/?access_token=${token}`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    throw new Error(`MixCloud upload failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as MixcloudResponse;
  if (data.error) throw new Error(`MixCloud error: ${data.error.message}`);

  const key = data.key ?? data.result?.key;
  if (key) return `https://www.mixcloud.com${key}`;

  // A successful upload often returns just {result:{success:true}} without the
  // new cloudcast's key — look up the most recent cloudcast to get its URL.
  try {
    const meRes = await fetch(`https://api.mixcloud.com/me/cloudcasts/?limit=1&access_token=${token}`);
    if (meRes.ok) {
      const me = (await meRes.json()) as { data?: { url?: string; key?: string }[] };
      const c = me.data?.[0];
      if (c?.url) return c.url;
      if (c?.key) return `https://www.mixcloud.com${c.key}`;
    }
  } catch {
    /* fall through to the account URL */
  }

  return 'https://www.mixcloud.com/';
}
