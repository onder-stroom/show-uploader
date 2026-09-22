import {
  S3Client,
  GetObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

const credentials = {
  accessKeyId: env.S3_ACCESS_KEY ?? '',
  secretAccessKey: env.S3_SECRET_KEY ?? '',
};

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: env.S3_REGION,
  credentials,
  forcePathStyle: true,
});

// Separate client whose endpoint is the browser-reachable host, so presigned
// URLs handed to the UI resolve (the internal S3_ENDPOINT is a docker hostname).
const presignS3 = new S3Client({
  endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: env.S3_REGION,
  credentials,
  forcePathStyle: true,
});

// Create the bucket on startup so no separate one-shot init container is needed
// (a lingering exited init container reads as "unhealthy" in orchestrators).
// Idempotent + best-effort: retries while minio warms up, never throws.
export async function ensureBucket(): Promise<void> {
  if (!env.S3_BUCKET) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
      console.log(`Ensured S3 bucket: ${env.S3_BUCKET}`);
      return;
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
      if (attempt === 5) {
        console.warn(`ensureBucket: giving up — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000)); // minio may not be ready yet
    }
  }
}

// Presigned GET so the UI can download a private object (e.g. the archived MP4)
// via a browser-reachable, time-limited link without exposing the bucket.
export async function createDownloadPresignedUrl(key: string) {
  if (!env.S3_BUCKET) throw new Error('S3 not configured (S3_BUCKET required)');
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(presignS3, command, { expiresIn: 3600 * 6 });
}

// Does this object actually exist, and how big is it? A key in the database is
// not proof of a file: a half-finished remux, a manual bucket cleanup, or an
// aborted upload all leave the row pointing at nothing.
export async function objectInfo(key: string): Promise<{ exists: boolean; size: number | null }> {
  if (!env.S3_BUCKET) return { exists: false, size: null };
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { exists: true, size: head.ContentLength ?? null };
  } catch {
    return { exists: false, size: null };
  }
}

// --- Multipart (resumable) upload ------------------------------------------
// Server-side create/list/complete/abort go over the internal endpoint; only
// the per-part PUT URL is presigned with the browser-reachable host. ETags are
// gathered server-side via ListParts, so the browser never reads response
// headers (avoids CORS ExposeHeaders issues) and resume is server-authoritative.

const bucket = () => {
  if (!env.S3_BUCKET) throw new Error('S3 not configured (S3_BUCKET required)');
  return env.S3_BUCKET;
};

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const out = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType })
  );
  if (!out.UploadId) throw new Error('CreateMultipartUpload returned no UploadId');
  return out.UploadId;
}

export function presignUploadPart(key: string, uploadId: string, partNumber: number) {
  const command = new UploadPartCommand({
    Bucket: bucket(),
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(presignS3, command, { expiresIn: 3600 * 6 });
}

// Part numbers already stored, so the client can skip them on resume.
export async function listUploadedParts(
  key: string,
  uploadId: string
): Promise<{ PartNumber: number; ETag: string; Size: number }[]> {
  const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
  let marker: number | undefined;
  do {
    const out = await s3.send(
      new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker?.toString() })
    );
    for (const p of out.Parts ?? []) {
      if (p.PartNumber && p.ETag) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size ?? 0 });
    }
    marker = out.IsTruncated ? Number(out.NextPartNumberMarker) : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

export async function completeMultipart(key: string, uploadId: string): Promise<void> {
  const parts = await listUploadedParts(key, uploadId);
  if (parts.length === 0) throw new Error('No parts uploaded');
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
    })
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
}

/**
 * Move an object within the bucket.
 *
 * S3 has no rename: it is a server-side copy followed by a delete, and the two
 * are separate operations. The delete only runs once the copy is verified, so an
 * interruption leaves a duplicate — recoverable — rather than nothing at all.
 */
export async function moveObject(from: string, to: string): Promise<void> {
  if (from === to) return;

  await s3.send(
    new CopyObjectCommand({
      Bucket: env.S3_BUCKET,
      // CopySource is bucket-qualified and must be URI-encoded: keys here contain
      // spaces and parentheses from OBS filenames.
      CopySource: encodeURI(`${env.S3_BUCKET}/${from}`),
      Key: to,
    })
  );

  const landed = await objectInfo(to);
  if (!landed.exists) throw new Error(`Copy to ${to} did not land`);

  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: from }));
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
