import { AGENT_API_PREFIX, type AgentHealth, type AgentRecording, type DraftSegment, type RecordingDraft } from '@show-uploader/domain';

/**
 * How a request about saved segments ended. `unsupported` is a PC service that predates saving (its
 * answer to the route is a plain 404 without our code), which is not the same as the PC being off.
 */
export type DraftResult =
  | { kind: 'ok'; draft: RecordingDraft | null }
  | { kind: 'unreachable' }
  | { kind: 'unsupported' }
  | { kind: 'gone' }
  | { kind: 'rejected' };

/** What the use cases need from the recordings service on the OBS PC. */
export interface RecordingsAgent {
  /** Null when the PC cannot be reached: a normal state, not an error. */
  list(): Promise<AgentRecording[] | null>;
  /** Make the PC look at its folder now, then return the fresh list. Null when unreachable. */
  rescan(): Promise<AgentRecording[] | null>;
  /** The service's own status, with its build and protocol. Null when unreachable. */
  health(): Promise<AgentHealth | null>;
  getDraft(ref: string): Promise<DraftResult>;
  saveDraft(ref: string, segments: DraftSegment[]): Promise<DraftResult>;
  peaks(ref: string): Promise<number[] | null>;
  /** The raw response, so the route can stream it with Range support. Null when unreachable. */
  preview(ref: string, range: string | undefined, signal?: AbortSignal): Promise<Response | null>;
}

const DEFAULT_TIMEOUT_MS = 5000;
// Forgetting a deleted multi-GB recording removes its files, which can take a moment.
const RESCAN_TIMEOUT_MS = 30_000;

export function createRecordingsAgent(o: { baseUrl?: string; token?: string; timeoutMs?: number }): RecordingsAgent {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Every failure to reach the PC collapses to null: it is off, off the tailnet, or
  // misconfigured, and the caller shows "not reachable" for all of them.
  async function call(path: string, init: RequestInit, signal: AbortSignal): Promise<Response | null> {
    if (!o.baseUrl || !o.token) return null;
    try {
      return await fetch(`${o.baseUrl.replace(/\/$/, '')}${AGENT_API_PREFIX}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${o.token}` },
        signal,
      });
    } catch {
      return null;
    }
  }

  // Reads a JSON array body; any failure to read or parse it, a non-ok status or the
  // wrong shape is "unreachable" too. Non-ok bodies are cancelled so the socket is freed.
  async function jsonArray<T>(path: string, init: RequestInit = {}, timeout = timeoutMs): Promise<T[] | null> {
    const res = await call(path, init, AbortSignal.timeout(timeout));
    if (!res) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    try {
      const body: unknown = await res.json();
      return Array.isArray(body) ? (body as T[]) : null;
    } catch {
      return null;
    }
  }

  // Reads one JSON object; null on anything but a clean 200.
  async function jsonObject<T>(path: string): Promise<T | null> {
    const res = await call(path, {}, AbortSignal.timeout(timeoutMs));
    if (!res) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    try {
      const body: unknown = await res.json();
      return body && typeof body === 'object' && !Array.isArray(body) ? (body as T) : null;
    } catch {
      return null;
    }
  }

  // The PC answers about saved segments with a status and a `code` of ours. A 404 without one of
  // our codes is a service that does not have the route at all.
  async function draftCall(path: string, init: RequestInit): Promise<DraftResult> {
    const res = await call(path, init, AbortSignal.timeout(timeoutMs));
    if (!res) return { kind: 'unreachable' };
    const body = await res.json().then(
      (b: unknown) => (b && typeof b === 'object' ? (b as { code?: string; segments?: unknown; savedAtMs?: unknown }) : null),
      () => null
    );
    if (res.ok) {
      return body && Array.isArray(body.segments) && typeof body.savedAtMs === 'number'
        ? { kind: 'ok', draft: body as unknown as RecordingDraft }
        : { kind: 'unreachable' };
    }
    if (res.status === 404 && body?.code === 'NO_DRAFT') return { kind: 'ok', draft: null };
    if (res.status === 404 && body?.code === 'UNKNOWN_RECORDING') return { kind: 'gone' };
    if (res.status === 404) return { kind: 'unsupported' };
    if (res.status === 400 && body?.code === 'BAD_SEGMENTS') return { kind: 'rejected' };
    return { kind: 'unreachable' };
  }

  return {
    health: () => jsonObject<AgentHealth>('/health'),
    getDraft: (ref) => draftCall(`/recordings/${encodeURIComponent(ref)}/draft`, {}),
    saveDraft: (ref, segments) =>
      draftCall(`/recordings/${encodeURIComponent(ref)}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      }),
    list: () => jsonArray<AgentRecording>('/recordings'),
    rescan: () => jsonArray<AgentRecording>('/rescan', { method: 'POST' }, Math.max(timeoutMs, RESCAN_TIMEOUT_MS)),
    peaks: (ref) => jsonArray<number>(`/recordings/${encodeURIComponent(ref)}/peaks`),
    // No timeout here: it would cut a stream that is merely long. The route aborts it
    // when the viewer goes away.
    preview(ref, range, signal) {
      return call(
        `/recordings/${encodeURIComponent(ref)}/preview`,
        { headers: range ? { Range: range } : {} },
        signal ?? new AbortController().signal
      );
    },
  };
}
