import { guardedSession } from '../auth/signin';
import { getFreshAccessToken, withAuthRetry } from '../auth/session';
import type { ShowStrand } from '@domain/format';

export type MediaLink = { label: string; type: string; url: string };

export type AgendaShow = {
  id: string;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  imageUrl: string | null;
  tags: string[] | null;
  mediaLinks: MediaLink[];
  // The linked show/series blurb (archive.show → shows.description).
  showDescription: string | null;
  // The archive record's strand: another strand than the default marks a show that is not a coming soon one.
  strand: ShowStrand | null;
  updated: string;
};

export type GeneratedMeta = {
  youtubeDescription: string;
  mixcloudDescription: string;
  tags: string[];
};

export type PlatformJob = {
  id: string;
  upload_id: string;
  platform: 'youtube' | 'mixcloud' | 'archive' | 'compress';
  status: 'queued' | 'processing' | 'done' | 'failed';
  result_url: string | null;
  error: string | null;
  progress_pct: number;
};

export type UploadWithJobs = {
  id: string;
  show_id: string;
  title: string;
  description: string | null;
  tags: string[];
  image_url: string | null;
  video_s3_key: string;
  archive_s3_key: string | null;
  audio_s3_key: string | null;
  duration_seconds: number | null;
  created_at: string;
  jobs: PlatformJob[];
};

export type MetadataSync = { ok: boolean; sync: Record<string, string> };

async function requestWith<T>(path: string, token: string | undefined, options?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(path, { ...options, headers });
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  // Token freshness and the 401 renew/retry policy live in auth/session.ts,
  // shared with the tRPC link.
  const res = await withAuthRetry(guardedSession, (token) => requestWith(path, token, options));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Everything else moved to tRPC (see ./trpc.ts). What stays REST here is exactly
// what doesn't fit tRPC's batch link: the resumable multipart flow, the raw
// cover-byte upload, the auth probe, and the presence claims (paired with the
// presence SSE stream).
export const api = {
  checkAuth: () => apiFetch<{ ok: boolean }>('/api/auth/me'),

  // Resumable multipart upload
  mpCreate: (filename: string, contentType: string, size: number, showId: string) =>
    apiFetch<{ sessionId: string; key: string; partSize: number; partCount: number }>(
      '/api/uploads/multipart/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, contentType, size, showId }),
      }
    ),
  mpStatus: (sessionId: string) =>
    apiFetch<{
      sessionId: string;
      key: string;
      filename: string;
      size: number;
      contentType: string;
      partSize: number;
      status: string;
      uploadedParts: { partNumber: number; size: number }[];
    }>(`/api/uploads/multipart/${sessionId}`),
  mpPartUrl: (sessionId: string, n: number) =>
    apiFetch<{ url: string }>(`/api/uploads/multipart/${sessionId}/part/${n}`, { method: 'POST' }),
  mpComplete: (sessionId: string) =>
    apiFetch<{ key: string }>(`/api/uploads/multipart/${sessionId}/complete`, { method: 'POST' }),
  mpAbort: (sessionId: string) =>
    apiFetch(`/api/uploads/multipart/${sessionId}/abort`, { method: 'POST' }),

  // Cover image → the PocketBase archive record's `image` field (PB is master).
  // Sends the raw image bytes; the api proxies them into PB. Returns the new URL.
  uploadCover: (showId: string, file: File) =>
    apiFetch<{ imageUrl: string | null }>(`/api/shows/${showId}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file,
    }),
  clearCover: (showId: string) =>
    apiFetch<{ ok: boolean }>(`/api/shows/${showId}/cover`, { method: 'DELETE' }),

  // Presence / soft-claims
  claimShow: (showId: string) =>
    apiFetch('/api/presence/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showId }),
    }),
  heartbeatShow: (showId: string) =>
    apiFetch('/api/presence/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showId }),
    }),
  releaseShow: (showId: string) =>
    apiFetch('/api/presence/claim', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showId }),
    }),
};

// EventSource can't set an Authorization header, so the presence stream takes
// the token as a query param (same pattern as the upload events stream).
export async function presenceStreamUrl(): Promise<string | null> {
  // Must be a *fresh* token: EventSource has no 401 hook, so a stale one leaves
  // the stream silently reconnecting forever.
  const token = await getFreshAccessToken(guardedSession);
  if (!token) return null;
  return `/api/presence/stream?access_token=${encodeURIComponent(token)}`;
}

export type OnlineUser = { sub: string; name: string };
export type ClaimView = { showId: string; userSub: string; userName: string; claimedAt: string };
