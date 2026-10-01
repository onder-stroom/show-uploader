/**
 * Fixture data for the offline UI preview (see preview.tsx).
 *
 * Deliberately awkward on purpose: long titles, a missing source file, a failed
 * job with a long error, a show claimed by someone else, an upload mid-flight.
 * A layout that survives these survives the real archive.
 */

import type { AgendaShow, UploadWithJobs } from '../api/client';

const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

/**
 * Stand-in cover art as an inline SVG data URI. Real covers come from
 * PocketBase; the mock has no network, so a remote URL would just 404 and the
 * card's onError handler would hide it — making it look like covers had stopped
 * working rather than being absent from the fixtures.
 */
function cover(label: string, bg: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${bg}"/><text x="80" y="96" font-family="monospace" font-size="64" font-weight="600" fill="#fafafa" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const shows: AgendaShow[] = [
  {
    id: 'show_zonderdak',
    title: 'Radio (z)onderdak',
    description: '<p>Monthly show from the shelter — guests, requests, and a lot of talking.</p>',
    date: '2026-07-31',
    startTime: '20:00',
    endTime: '22:00',
    imageUrl: cover('RZ', '#137738'),
    tags: ['talk', 'community'],
    mediaLinks: [{ label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo1' }],
    showDescription: 'A monthly programme made with and by people without a roof.',
    updated: '2026-08-01 12:00:00.000Z',
  },
  {
    id: 'show_latenight',
    title: 'Late Night Tape Deck — extended new year special with far too long a name',
    description: '',
    date: '2026-07-28',
    startTime: '23:00',
    endTime: '01:00',
    imageUrl: cover('LN', '#4d4d4d'),
    tags: ['ambient', 'tape', 'experimental', 'drone', 'field recordings'],
    mediaLinks: [{ label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo1' }],
    showDescription: null,
    updated: '2026-08-01 12:00:00.000Z',
  },
  {
    id: 'show_breakfast',
    title: 'Breakfast Club',
    description: '<p>Wake up slowly.</p>',
    date: '2026-07-25',
    startTime: '09:00',
    endTime: '11:00',
    imageUrl: cover('BC', '#0f0f0f'),
    tags: null,
    mediaLinks: [
      { label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo2' },
      { label: 'MixCloud', type: 'audio', url: 'https://mixcloud.com/demo2' },
    ],
    showDescription: null,
    updated: '2026-08-01 12:00:00.000Z',
  },
  {
    id: 'show_dubplate',
    title: 'Dubplate Hour',
    description: '',
    date: '2026-07-20',
    startTime: '18:00',
    endTime: '19:00',
    imageUrl: null,
    tags: ['dub', 'reggae'],
    mediaLinks: [
      { label: 'YouTube', type: 'video', url: 'https://youtube.com/watch?v=demo3' },
      { label: 'MixCloud', type: 'audio', url: 'https://mixcloud.com/demo3' },
    ],
    showDescription: null,
    updated: '2026-08-01 12:00:00.000Z',
  },
];

export const uploads: UploadWithJobs[] = [
  // Mid-flight: one job done, one processing, archive queued.
  {
    id: 'upl_running',
    show_id: 'show_zonderdak',
    title: 'Radio (z)onderdak 31.07.2026 @ coming soon',
    description: null,
    tags: ['talk'],
    image_url: null,
    video_s3_key: 'recordings/1785677613218-radio-zonderdak.mkv',
    archive_s3_key: null,
    audio_s3_key: null,
    duration_seconds: null,
    created_at: day(0),
    jobs: [
      { id: 'j1', upload_id: 'upl_running', platform: 'youtube', status: 'done', result_url: 'https://youtube.com/watch?v=demo1', error: null, progress_pct: 100 },
      { id: 'j2', upload_id: 'upl_running', platform: 'mixcloud', status: 'processing', result_url: null, error: null, progress_pct: 62 },
      { id: 'j3', upload_id: 'upl_running', platform: 'archive', status: 'queued', result_url: null, error: null, progress_pct: 0 },
    ],
  },
  // A failed job with a long error — the case that used to push the retry
  // button off a narrow screen.
  {
    id: 'upl_failed',
    show_id: 'show_dubplate',
    title: 'Dubplate Hour 20.07.2026 @ coming soon',
    description: null,
    tags: [],
    image_url: null,
    video_s3_key: 'recordings/1785000000000-dubplate.mkv',
    archive_s3_key: null,
    audio_s3_key: null,
    duration_seconds: null,
    created_at: day(3),
    jobs: [
      { id: 'j4', upload_id: 'upl_failed', platform: 'youtube', status: 'done', result_url: 'https://youtube.com/watch?v=demo3', error: null, progress_pct: 100 },
      {
        id: 'j5',
        upload_id: 'upl_failed',
        platform: 'mixcloud',
        status: 'failed',
        result_url: null,
        error: 'ffmpeg exited with code 234: Conversion failed! | [ipod @ 0x14f] Could not find tag for codec pcm_s16le in stream #1',
        progress_pct: 41,
      },
      { id: 'j6', upload_id: 'upl_failed', platform: 'archive', status: 'done', result_url: null, error: null, progress_pct: 100 },
    ],
  },
  // Fully published, playable MP4, live on the website.
  {
    id: 'upl_published',
    show_id: 'show_breakfast',
    title: 'Breakfast Club 25.07.2026 @ coming soon',
    description: null,
    tags: ['morning'],
    image_url: null,
    video_s3_key: 'recordings/1784000000000-breakfast.mp4',
    archive_s3_key: 'archive/breakfast.mp4',
    audio_s3_key: 'archive/breakfast.m4a',
    duration_seconds: null,
    created_at: day(9),
    jobs: [
      { id: 'j7', upload_id: 'upl_published', platform: 'youtube', status: 'done', result_url: 'https://youtube.com/watch?v=demo2', error: null, progress_pct: 100 },
      { id: 'j8', upload_id: 'upl_published', platform: 'mixcloud', status: 'done', result_url: 'https://mixcloud.com/demo2', error: null, progress_pct: 100 },
      { id: 'j9', upload_id: 'upl_published', platform: 'archive', status: 'done', result_url: null, error: null, progress_pct: 100 },
    ],
  },
  // Published but still MKV (backfill candidate) and its source file is gone —
  // the two states the archive card has to report honestly.
  {
    id: 'upl_stale',
    show_id: 'show_latenight',
    title: 'Late Night Tape Deck — extended new year special with far too long a name 28.07.2026 @ coming soon',
    description: null,
    tags: ['ambient'],
    image_url: null,
    video_s3_key: 'recordings/1783000000000-latenight.mkv',
    archive_s3_key: null,
    audio_s3_key: null,
    duration_seconds: null,
    created_at: day(14),
    jobs: [
      { id: 'j10', upload_id: 'upl_stale', platform: 'youtube', status: 'done', result_url: 'https://youtube.com/watch?v=demo1', error: null, progress_pct: 100 },
      { id: 'j11', upload_id: 'upl_stale', platform: 'archive', status: 'done', result_url: null, error: null, progress_pct: 100 },
    ],
  },
];

// One record deliberately has no cover — the card has to survive that too.
export const archiveStates: Record<string, { cover: string | null; status: 'draft' | 'published' }> = {
  show_breakfast: { cover: cover('BC', '#0f0f0f'), status: 'published' },
  show_latenight: { cover: cover('LN', '#4d4d4d'), status: 'draft' },
  show_zonderdak: { cover: cover('RZ', '#137738'), status: 'draft' },
  show_dubplate: { cover: null, status: 'draft' },
};

export const genres = ['ambient', 'techno', 'dub', 'reggae', 'talk', 'community', 'jazz', 'drone', 'tape'];

export const videoInfo: Record<string, { exists: boolean; size: number | null; filename: string }> = {
  upl_running: { exists: true, size: 2_293_760_000, filename: 'radio-zonderdak.mkv' },
  upl_failed: { exists: true, size: 1_073_741_824, filename: 'dubplate.mkv' },
  upl_published: { exists: true, size: 1_181_116_006, filename: 'breakfast.mp4' },
  upl_stale: { exists: false, size: null, filename: 'latenight.mkv' },
};

// A night recorded on the OBS PC: ready, plus one still being prepared.
export const recordings = [
  {
    ref: 'rec-night-1', filename: '2026-07-31_19-55-00.mkv', sizeBytes: 9_400_000_000, mtimeMs: Date.parse('2026-07-31T23:55:00Z'),
    durationS: 14_400, state: 'ready' as const, hasPreview: true, recordedAtMs: Date.parse('2026-07-31T19:55:00Z'),
  },
  {
    ref: 'rec-night-2', filename: '2026-08-07_19-58-00.mkv', sizeBytes: 3_100_000_000, mtimeMs: Date.parse('2026-08-07T22:00:00Z'),
    durationS: null, state: 'preparing' as const, hasPreview: false, recordedAtMs: Date.parse('2026-08-07T19:58:00Z'),
  },
];
