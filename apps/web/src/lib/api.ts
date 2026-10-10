import type { Injection } from '@kernelcraft/engine';

/** Base URL of the KernelCraft API. Same origin by default (Vite proxies /api in dev). */
const BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export interface ApiHealth { ok: boolean; engine: string; storage: 'postgres' | 'memory'; database: string; narration: 'llm' | 'deterministic' }
export interface RecordingItem { id: string; title: string; status: string; ticks: number; traceHash: string; createdAt: string; updatedAt?: string }
export interface Recording extends RecordingItem { source: string; inputs: Injection[]; notes: string; engineVersion: string }

async function call<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeout ?? 8000);
  try {
    const res = await fetch(BASE + path, { ...init, signal: ctrl.signal, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) throw new Error(`unexpected response (${res.status})`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body as T;
  } finally { clearTimeout(timer); }
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => call<ApiHealth>('/api/health', { timeout: 2500 }),
  ask: (b: { source: string; inputs: Injection[]; question: string; narrate: boolean }) =>
    call<{ text: string; narration: { text: string; model: string } | null; narrationError: string | null }>('/api/assistant/ask', { ...json(b), timeout: 30000 }),
  listRecordings: () => call<{ items: RecordingItem[]; total: number }>('/api/recordings?limit=50'),
  getRecording: (id: string) => call<Recording>(`/api/recordings/${encodeURIComponent(id)}`),
  createRecording: (b: { title: string; source: string; inputs: Injection[] }) => call<Recording>('/api/recordings', json(b)),
  verifyRecording: (id: string) => call<{ reproducible: boolean; stored: string; actual: string }>(`/api/recordings/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' }),
  deleteRecording: (id: string) => call<void>(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' })
};
