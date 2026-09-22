import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { env } from '../env';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY ?? '',
    secretAccessKey: env.S3_SECRET_KEY ?? '',
  },
  forcePathStyle: true,
});

export async function downloadFromS3(key: string, destPath: string): Promise<void> {
  const cmd = new GetObjectCommand({ Bucket: (env.S3_BUCKET ?? ''), Key: key });
  const { Body } = await s3.send(cmd);
  if (!Body) throw new Error(`Empty body for S3 key: ${key}`);

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const readable = Body as Readable;
    const writer = fs.createWriteStream(destPath);
    readable.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    readable.on('error', reject);
  });
}

export async function uploadToS3(localPath: string, key: string, contentType: string): Promise<void> {
  const stat = await fs.promises.stat(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: (env.S3_BUCKET ?? ''),
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentType,
      ContentLength: stat.size,
    })
  );
}

// Byte size of an object, or null if it isn't there. Used to prove a freshly
// uploaded file actually landed before the original it replaces is deleted.
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: (env.S3_BUCKET ?? ''), Key: key })
    );
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: (env.S3_BUCKET ?? ''), Key: key }));
}

// A short-lived GET URL for tools that read by URL (ffprobe), so a whole file
// needn't be downloaded just to read its header. Signed against the internal
// endpoint: only the worker itself uses it.
export async function signedGetUrl(key: string, expiresIn = 600): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET ?? '', Key: key }), { expiresIn });
}
