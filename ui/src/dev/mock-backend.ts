/**
 * Offline mock backend for UI work — dev only.
 *
 * Run `pnpm dev` and open `/?mock=1` to get the whole app driven by fixtures:
 * no API, no database, no Zitadel, and no chance of a stray click mutating a
 * real record. It exists so layout and interaction can be checked at real
 * viewport sizes (which is where the mobile problems actually live) without
 * pointing a browser at production.
 *
 * It is loaded by a dynamic import behind `import.meta.env.DEV` in main.tsx, so
 * none of this — including the fixtures — reaches the production bundle.
 */

import { shows, uploads, archiveStates, genres, videoInfo } from './fixtures';

// tRPC batch responses are positional: one entry per procedure in the URL.
// There is no real file to play in mock mode. A data: URI keeps the <video>
// element inert and quiet — a blob:/http: placeholder makes the browser log a
// scary "not allowed to load local resource" that reads like an app bug.
const mockSignedUrl = () => `data:video/mp4;base64,#sig=${Math.random().toString(36).slice(2)}`;
// Number of status polls spent "converting" before the preview turns ready, so
// the progress UI is reachable in mock mode. Keyed per recording, since the
// screen can switch between shows without a reload.
const MOCK_CONVERT_POLLS = 4;
const previewPolls = new Map<string, number>();
const previewMp4Key = (key: string) => key.replace(/\.[^./]+$/, '.mp4');

function trpcBody(datas: unknown[]) {
  return JSON.stringify(datas.map((data) => ({ result: { data } })));
}

function resolve(proc: string, input: unknown): unknown {
  const arg = (input ?? {}) as Record<string, string>;
  switch (proc) {
    case 'shows.listShows':
      return shows;
    case 'shows.listGenres':
      return genres;
    case 'shows.listStates':
      return archiveStates;
    // The archive page's source: records carrying a cs-archive-* link. The
    // second one deliberately has no upload row in the `uploads` fixture, so
    // the "archived but no job row" case is what the page actually renders.
    case 'shows.listArchived':
      return [
        // Published elsewhere, nothing archived here yet — the catalogue
        // shows it with an "upload recording" action instead of downloads.
        {
          ...shows.find((s) => s.id === 'show_dubplate')!,
          id: 'show_unarchived',
          title: 'Published But Not Archived',
          mediaLinks: [{ label: 'Youtube', type: 'video', url: 'https://youtube.com/watch?v=demo7' }],
        },
        {
          ...shows.find((s) => s.id === 'show_breakfast')!,
          mediaLinks: [
            ...shows.find((s) => s.id === 'show_breakfast')!.mediaLinks,
            { label: 'cs-archive-video', type: 'cs-archive-video', url: 'https://uploader.test/api/public/recordings/show_breakfast/video' },
            { label: 'cs-archive-audio', type: 'cs-archive-audio', url: 'https://uploader.test/api/public/recordings/show_breakfast/audio' },
          ],
        },
        // No entry in the `uploads` fixture: the archived-but-no-job-row case.
        {
          ...shows.find((s) => s.id === 'show_breakfast')!,
          id: 'show_orphan',
          title: 'Orphaned Archive (no job row)',
          mediaLinks: [
            { label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo9' },
            { label: 'cs-archive-video', type: 'cs-archive-video', url: 'https://uploader.test/api/public/shows/2026-07-31-zonderdak/video' },
            { label: 'cs-archive-audio', type: 'cs-archive-audio', url: 'https://uploader.test/api/public/shows/2026-07-31-zonderdak/audio' },
          ],
        },
        {
          ...shows.find((s) => s.id === 'show_zonderdak')!,
          mediaLinks: [
            { label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo1' },
            { label: 'cs-archive-video', type: 'cs-archive-video', url: 'https://uploader.test/api/public/shows/2026-07-31-zonderdak/video' },
            { label: 'cs-archive-audio', type: 'cs-archive-audio', url: 'https://uploader.test/api/public/shows/2026-07-31-zonderdak/audio' },
          ],
        },
      ];
    case 'shows.listPublished':
      // Derived from the `shows` (drafts) fixture — same ids, same
      // mediaLinks — so shows.get (which NewUpload.tsx now calls via
      // useShow) resolves to a consistent state instead of a second,
      // independently-maintained fixture that can drift out of sync.
      return [
        shows.find((s) => s.id === 'show_zonderdak')!,
        shows.find((s) => s.id === 'show_dubplate')!,
        {
          ...shows.find((s) => s.id === 'show_breakfast')!,
          mediaLinks: [
            ...shows.find((s) => s.id === 'show_breakfast')!.mediaLinks,
            { label: 'cs-archive-video', type: 'cs-archive-video', url: 'https://uploader.test/api/public/recordings/x/video' },
          ],
        },
      ];
    case 'shows.get':
      return shows.find((s) => s.id === arg.id) ?? null;
    case 'shows.generateMeta':
      return {
        youtubeDescription: 'Recorded live at coming soon. Two hours of talk, requests and tape hiss.',
        mixcloudDescription: 'Recorded live at coming soon.',
        tags: ['talk', 'community', 'live'],
      };
    case 'shows.saveMetadata':
      return { ok: true };
    case 'shows.syncTimes':
      return { youtube: '2026-08-14T09:12:00.000Z', mixcloud: '2026-08-15T10:41:00.000Z' };
    case 'shows.syncPlatforms':
      return { results: { youtube: 'ok', mixcloud: 'ok' } };
    case 'uploads.list':
      return uploads;
    case 'uploads.getStagedShowIds':
      return ['show_dubplate'];
    case 'uploads.getStaged':
      return arg.showId === 'show_dubplate'
        ? { s3_key: 'staged/dubplate.mkv', filename: 'dubplate-2026-07-20.mkv' }
        : null;
    case 'uploads.getUploadingProgress':
      return [{ show_id: 'show_latenight', pct: 37 }];
    case 'uploads.videoInfo':
      return videoInfo[arg.uploadId] ?? { exists: false, size: null, filename: 'unknown' };
    case 'uploads.getJinglePreview':
      return { url: '' };
    // Walks the real state machine: the first poll reports converting, and after
    // a few it flips to ready — so the progress UI and the player are both
    // reachable without ffmpeg, redis or s3.
    case 'uploads.startPreview':
      previewPolls.set(String(arg.videoS3Key), 0);
      return { state: 'working', pct: 0 };
    case 'uploads.previewStatus': {
      const key = String(arg.videoS3Key);
      if (/\.mp4$/i.test(key)) return { state: 'ready', key };
      // Idle until startPreview runs, so the real idle → start → working → ready
      // path is what gets exercised, not a shortcut into "working".
      const polls = previewPolls.get(key);
      if (polls === undefined) return { state: 'idle' };
      previewPolls.set(key, polls + 1);
      if (polls + 1 < MOCK_CONVERT_POLLS) {
        return { state: 'working', pct: Math.round(((polls + 1) / MOCK_CONVERT_POLLS) * 100) };
      }
      return { state: 'ready', key: previewMp4Key(key) };
    }
    case 'uploads.deleteStaged':
      return { ok: true };
    case 'uploads.create':
      return { uploadId: 'upl_running' };
    case 'uploads.retryJob':
      return { ok: true };
    case 'uploads.deleteUpload':
      return { ok: true, stillRunning: 1 };
    case 'uploads.publishRecord':
    case 'uploads.unpublishRecord':
      return { ok: true };
    case 'uploads.remuxBackfill':
      return { enqueued: 1 };
    case 'uploads.generateAudio':
      return { ok: true };
    case 'uploads.compressArchiveVideo':
      return { ok: true };
    case 'uploads.publishToPlatform':
      return { ok: true, jobId: 'job_mock' };
    // Deliberately unhealthy figures: a nearly-full object disk and a stale job
    // folder, so the warning states are reachable without staging a real outage.
    case 'storage.overview':
      return {
        disk: { path: '/mnt/storage', totalBytes: 2_000_000_000_000, freeBytes: 180_000_000_000, usedBytes: 1_820_000_000_000 },
        root: { path: '/', totalBytes: 100_000_000_000, freeBytes: 61_000_000_000, usedBytes: 39_000_000_000 },
        temp: { path: '/tmp/show-uploader', bytes: 7_400_000_000, jobs: 2, oldestAgeMs: 9 * 60 * 60 * 1000 },
        bucket: {
          name: 'show-uploader',
          truncated: false,
          bytes: 1_500_000_000_000,
          objects: 412,
          prefixes: [
            { prefix: 'uploads', bytes: 980_000_000_000, objects: 190 },
            { prefix: 'archive', bytes: 505_000_000_000, objects: 210 },
            { prefix: 'jingles', bytes: 15_000_000_000, objects: 12 },
          ],
        },
      };
    case 'storage.browse': {
      const p = String(arg.prefix ?? '');
      if (!p) {
        return { prefix: '', truncated: false, files: [], folders: [
          { key: 'incoming/', name: 'incoming', bytes: null, modified: null },
          { key: 'shows/', name: 'shows', bytes: null, modified: null },
          { key: 'jingles/', name: 'jingles', bytes: null, modified: null },
        ] };
      }
      if (p === 'shows/2026-07-31-zonderdak/') {
        return { prefix: p, truncated: false, folders: [], files: [
          { key: `${p}video.mp4`, name: 'video.mp4', bytes: 2_600_000_000, modified: new Date().toISOString() },
          { key: `${p}audio.m4a`, name: 'audio.m4a', bytes: 270_000_000, modified: new Date().toISOString() },
        ] };
      }
      if (p === 'shows/') {
        return { prefix: p, truncated: false, files: [], folders: [
          { key: 'shows/1785-obs/', name: '1785-obs', bytes: null, modified: null },
        ] };
      }
      // incoming/ carries one orphaned recording, to exercise the delete button.
      if (p === 'incoming/') {
        return { prefix: p, truncated: false, folders: [], files: [
          { key: 'incoming/1784465072633-mills_17.07.2026.mkv', name: '1784465072633-mills_17.07.2026.mkv', bytes: 2_100_000_000, modified: new Date().toISOString() },
        ] };
      }
      return { prefix: p, truncated: false, folders: [], files: [
        { key: `${p}video.mp4`, name: 'video.mp4', bytes: 2_293_760_000, modified: new Date().toISOString() },
        { key: `${p}audio.m4a`, name: 'audio.m4a', bytes: 240_000_000, modified: new Date().toISOString() },
      ] };
    }
    // Signs afresh per call, like the real endpoint. The query key is what makes
    // this stable for a given object — not the endpoint.
    case 'storage.signObject':
      return { url: mockSignedUrl() };
    // Always succeeds here — the real refusal-for-referenced-keys guard is
    // proven against actual Postgres in api/test/db/storage-safety.db.test.ts.
    // This mock has no error-response plumbing, so it only needs to prove the
    // button, confirm step and list-refresh render and work.
    case 'storage.deleteObject':
      return { ok: true };
    case 'storage.migrationPlan':
      return {
        count: 2,
        moves: [
          { from: 'uploads/1785-obs.mp4', to: 'shows/1785-obs/video.mp4', field: 'video_s3_key', reason: 'published master' },
          { from: 'archive/1785-obs.m4a', to: 'shows/1785-obs/audio.m4a', field: 'audio_s3_key', reason: 'published audio' },
        ],
      };
    case 'storage.runMigration':
      return { moved: 2, attempted: 2, failed: [] };
    case 'watcher.pending':
      return [
        { id: 'pv1', s3_key: 'dropfolder/obs-2026-07-31.mkv', filename: 'obs-2026-07-31.mkv', size_bytes: 2_293_760_000 },
        { id: 'pv2', s3_key: 'dropfolder/obs-2026-07-28.mkv', filename: 'obs-2026-07-28.mkv', size_bytes: 1_500_000_000 },
      ];
    case 'watcher.claimPending':
      return { ok: true };
    case 'platform.youtubeStatus':
      return { privacyStatus: 'unlisted' };
    case 'platform.update':
    case 'platform.setPublic':
    case 'platform.removeLink':
      return { ok: true };
    default:
      console.warn(`[mock] unhandled tRPC procedure: ${proc}`);
      return null;
  }
}

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

export function install() {
  // A fake signed-in user, written where oidc-client-ts looks for it, so the
  // real AuthProvider loads it without any auth-specific branch in app code.
  const authority = `https://${import.meta.env.VITE_ZITADEL_DOMAIN}`;
  const clientId = import.meta.env.VITE_ZITADEL_CLIENT_ID ?? 'mock-client';
  // localStorage, matching the userStore AuthProvider now configures — writing
  // to sessionStorage would leave the real UserManager seeing no session.
  localStorage.setItem(
    `oidc.user:${authority}:${clientId}`,
    JSON.stringify({
      access_token: 'mock-token',
      token_type: 'Bearer',
      scope: 'openid profile email',
      profile: { sub: 'mock-operator', name: 'Dev Operator', email: 'dev@example.invalid' },
      // Far enough out that the silent-renew timer never fires during a session.
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
    })
  );

  // Presence/job streams: a stub that connects and says nothing, rather than a
  // console full of failed EventSource retries.
  class MockEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 1;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onopen: ((e: Event) => void) | null = null;
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = MockEventSource as unknown as typeof EventSource;

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, location.origin);

    if (!url.pathname.startsWith('/api/')) return realFetch(input as RequestInfo, init);

    if (url.pathname.startsWith('/api/trpc/')) {
      const procs = url.pathname.slice('/api/trpc/'.length).split(',');
      let inputs: Record<string, unknown> = {};
      if (req.method === 'GET') {
        try {
          inputs = JSON.parse(url.searchParams.get('input') ?? '{}');
        } catch {
          inputs = {};
        }
      } else {
        try {
          inputs = JSON.parse(await req.text());
        } catch {
          inputs = {};
        }
      }
      // Mutations arrive one per request; queries batch. Either way the keys are
      // positional indices.
      const data = procs.map((p, i) => resolve(p, inputs[String(i)] ?? inputs));
      console.info(`[mock] ${req.method} ${procs.join(', ')}`);
      return json(trpcBody(data));
    }

    if (url.pathname.startsWith('/api/auth')) return json(JSON.stringify({ ok: true, roles: ['member'] }));
    if (url.pathname.startsWith('/api/presence')) return json(JSON.stringify({ ok: true }));

    console.warn(`[mock] unhandled REST call: ${req.method} ${url.pathname}`);
    return json(JSON.stringify({ ok: true }));
  };

  console.info('[mock] offline fixtures installed — no real backend is being called');
}
