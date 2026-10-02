import { AGENT_API_PREFIX, type AgentCut } from '@show-uploader/domain';
import type { RecordingsAgent } from '../ports';

const TIMEOUT_MS = 15_000;

/** HTTP client for the recordings service on the OBS PC. */
export function createRecordingsAgent(o: { baseUrl?: string; token?: string }): RecordingsAgent {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    if (!o.baseUrl || !o.token) {
      throw new Error('The recordings service is not configured (RECORDINGS_AGENT_URL / RECORDINGS_AGENT_TOKEN)');
    }
    return fetch(`${o.baseUrl.replace(/\/$/, '')}${AGENT_API_PREFIX}${path}`, {
      method,
      headers: { Authorization: `Bearer ${o.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function parse(res: Response, what: string): Promise<AgentCut> {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentCut;
  }

  return {
    async startCut(req) {
      const res = await call('POST', '/cuts', req);
      // The PC does not know this recording any more: the operator deleted it. Any other
      // 404 (a wrong URL, a proxy) is just a failed request.
      if (res.status === 404) {
        const code = ((await res.clone().json().catch(() => null)) as { code?: string } | null)?.code;
        if (code !== 'UNKNOWN_RECORDING') return parse(res, 'Starting the cut');
        return { cutId: req.cutId, state: 'source_gone', sizeBytes: null, etags: null, reason: 'The recording was deleted from the PC' };
      }
      return parse(res, 'Starting the cut');
    },
    async cut(cutId) {
      const res = await call('GET', `/cuts/${encodeURIComponent(cutId)}`);
      if (res.status === 404) return null;
      return parse(res, 'Reading the cut');
    },
    async upload(cutId, req) {
      return parse(await call('POST', `/cuts/${encodeURIComponent(cutId)}/upload`, req), 'Starting the upload');
    },
    async drop(cutId) {
      try {
        await call('DELETE', `/cuts/${encodeURIComponent(cutId)}`);
      } catch (err) {
        console.warn(`Could not drop cut ${cutId} on the PC:`, err instanceof Error ? err.message : err);
      }
    },
  };
}
