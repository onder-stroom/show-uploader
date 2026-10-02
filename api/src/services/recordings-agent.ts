import { AGENT_API_PREFIX, type AgentRecording } from '@show-uploader/domain';

/** What the use cases need from the recordings service on the OBS PC. */
export interface RecordingsAgent {
  /** Null when the PC cannot be reached: a normal state, not an error. */
  list(): Promise<AgentRecording[] | null>;
  /** Make the PC look at its folder now, then return the fresh list. Null when unreachable. */
  rescan(): Promise<AgentRecording[] | null>;
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

  return {
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
