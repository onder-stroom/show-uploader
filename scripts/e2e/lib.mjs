// Shared plumbing for the end-to-end checks: a throwaway MinIO + Postgres +
// Redis on local ports, fixtures, and the reporter.
import { createRequire } from 'module';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Deliberately odd ports, so a running `docker compose up` (9000/5432/6379) is
 * never touched. Nothing here points at anything real.
 */
export const env = {
  DATABASE_URI: 'postgres://e2e:e2e@localhost:15432/e2e',
  REDIS_URL: 'redis://localhost:16379',
  S3_ENDPOINT: 'http://localhost:19000',
  S3_ACCESS_KEY: 'e2eaccess',
  S3_SECRET_KEY: 'e2esecret123',
  S3_BUCKET: 'e2e',
  INTERNAL_API_URL: 'http://localhost:13999/api',
  APP_PUBLIC_URL: 'https://uploader.e2e',
  WATCHER_API_KEY: 'e2e-key',
  // Never publish for real, whatever credentials happen to be in the shell.
  PUBLISH_DRY_RUN: 'true',
  SHOWS_API_URL: 'http://localhost:13999',
  SHOWS_API_KEY: 'e2e',
  GROQ_API_KEY: 'e2e',
  ZITADEL_DOMAIN: 'zitadel.e2e',
  ZITADEL_CLIENT_ID: 'e2e',
  JINGLE_S3_KEY: 'jingles/e2e.m4a',
};

const CONTAINERS = ['e2e-minio', 'e2e-pg', 'e2e-redis'];
const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' }).toString().trim();

export function stackDown() {
  try {
    docker('rm', '-f', ...CONTAINERS);
  } catch {
    /* nothing running */
  }
}

export async function stackUp() {
  stackDown();
  docker('run', '-d', '--name', 'e2e-minio', '-p', '19000:9000',
    '-e', `MINIO_ROOT_USER=${env.S3_ACCESS_KEY}`, '-e', `MINIO_ROOT_PASSWORD=${env.S3_SECRET_KEY}`,
    'quay.io/minio/minio', 'server', '/data');
  docker('run', '-d', '--name', 'e2e-redis', '-p', '16379:6379', 'redis:7-alpine');
  // Both db clients connect with ssl: 'require', so Postgres has to serve TLS.
  // The image ships a snakeoil cert, which is all a throwaway needs.
  docker('run', '-d', '--name', 'e2e-pg', '-p', '15432:5432',
    '-e', 'POSTGRES_USER=e2e', '-e', 'POSTGRES_PASSWORD=e2e', '-e', 'POSTGRES_DB=e2e', 'postgres:16',
    '-c', 'ssl=on', '-c', 'ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem',
    '-c', 'ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key');
  await waitFor('the local stack', async () => {
    try {
      docker('exec', 'e2e-pg', 'pg_isready', '-U', 'e2e');
      const res = await fetch(`${env.S3_ENDPOINT}/minio/health/live`);
      return res.ok;
    } catch {
      return false;
    }
  }, 60000);
}

export const requireFrom = (pkg) => createRequire(path.join(ROOT, pkg, 'package.json'));

export function s3Client() {
  const { S3Client } = requireFrom('worker')('@aws-sdk/client-s3');
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });
}

/** A bucket with the usual verbs, so a check can read what a job actually wrote. */
export async function bucket() {
  const aws = requireFrom('worker')('@aws-sdk/client-s3');
  const s3 = s3Client();
  await s3.send(new aws.CreateBucketCommand({ Bucket: env.S3_BUCKET })).catch(() => {});
  return {
    put: (key, body) => s3.send(new aws.PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body })),
    async get(key) {
      const out = await s3.send(new aws.GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return Buffer.from(await out.Body.transformToByteArray());
    },
    async size(key) {
      return (await s3.send(new aws.HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))).ContentLength;
    },
    async keys(prefix = '') {
      const out = await s3.send(new aws.ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix }));
      return (out.Contents ?? []).map((o) => o.Key);
    },
  };
}

/** A fresh database with every migration applied. */
export async function database() {
  const postgres = requireFrom('api')('postgres');
  const db = postgres(env.DATABASE_URI, { ssl: 'require', max: 2, onnotice: () => {} });
  const dir = path.join(ROOT, 'api/src/db/migrations');
  for (const file of fs.readdirSync(dir).sort()) {
    await db.unsafe(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return db;
}

/** Stands in for the api the worker PATCHes its PocketBase write-back to. */
export function writeBackStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  server.listen(13999);
  return { received, close: () => server.close() };
}

/** A recording, fat enough on purpose that the shrink has something to win. */
export function makeRecording(file, seconds = 20) {
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '20M', '-c:a', 'aac', '-shortest', file,
  ]);
  return fs.readFileSync(file);
}

export function makeJingle(file, seconds = 2) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`, '-c:a', 'aac', file]);
  return fs.readFileSync(file);
}

export function probeSeconds(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
}

/** The real built worker, consuming the queues this run writes to. */
export function startWorker() {
  const proc = spawn('node', [path.join(ROOT, 'worker/dist/index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  return { stop: () => proc.kill('SIGTERM'), log: () => log };
}

export async function waitFor(what, fn, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function reporter(title) {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    },
    /** Prints the tally and returns the number of failures. */
    finish(workerLog) {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${title}: ${results.length - failed}/${results.length} checks passed`);
      if (failed && workerLog) console.log('--- worker log (tail) ---\n' + workerLog.slice(-3000));
      return failed;
    },
  };
}

export function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
