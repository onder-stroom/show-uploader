import type { UploadSessions } from '../ports';

/**
 * The api's internal endpoints for cut upload sessions. Shared-key gated, like the
 * worker's PocketBase write-back: the api owns completion, so the staged video is
 * recorded by the same rule as a browser upload.
 */
export function createUploadSessions(o: { baseUrl: string; apiKey: string }): UploadSessions {
  async function post(path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${o.baseUrl}/internal/recordings${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`api ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    async open({ cutId, ...body }) {
      return (await (await post(`/cuts/${encodeURIComponent(cutId)}/session`, body)).json()) as Awaited<ReturnType<UploadSessions['open']>>;
    },
    async complete(sessionId) {
      await post(`/sessions/${encodeURIComponent(sessionId)}/complete`);
    },
    async abort(sessionId) {
      await post(`/sessions/${encodeURIComponent(sessionId)}/abort`);
    },
  };
}
