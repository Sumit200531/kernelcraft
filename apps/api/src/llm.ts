import type { Answer, Machine } from '@kernelcraft/engine';
import { validateCitations } from '@kernelcraft/engine';
import type { Env } from './env.js';

export interface Narration { text: string; model: string }
export type NarrationResult = { ok: true; narration: Narration } | { ok: false; reason: string };

/** Minimal OpenAI-compatible chat call. Injected in tests. */
export type ChatFn = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<{ text: string; model: string }>;

export function openAiChat(env: Env): ChatFn | null {
  if (!env.LLM_BASE_URL) return null;
  const url = env.LLM_BASE_URL.replace(/\/+$/, '') + '/chat/completions';
  return async messages => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), env.LLM_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(env.LLM_API_KEY ? { authorization: `Bearer ${env.LLM_API_KEY}` } : {}) },
        body: JSON.stringify({ model: env.LLM_MODEL, messages, temperature: 0.2, max_tokens: 500 })
      });
      if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
      const body = await res.json() as { choices?: { message?: { content?: string } }[]; model?: string };
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error('LLM response had no content');
      return { text, model: body.model ?? env.LLM_MODEL };
    } finally { clearTimeout(timer); }
  };
}

const SYSTEM = `You are the debugging assistant of KernelCraft, an operating-system simulator.
Rewrite the ANALYSIS as a direct answer to the QUESTION for a systems engineer.
Rules:
- Use only facts present in the ANALYSIS and EVENTS. Do not add numbers, threads or causes that are not there.
- Cite evidence exactly as [#id] using only ids that appear in the ANALYSIS or EVENTS.
- Keep any experiment results and their numbers unchanged.
- At most 180 words. Plain prose, short paragraphs or bullets.`;

/**
 * Ask an LLM to rephrase a deterministic answer. The narration is accepted only
 * if every citation exists in the trace and was part of the supplied context,
 * and it keeps at least one citation when the original had any.
 */
export async function narrate(chat: ChatFn, m: Machine, question: string, answer: Answer): Promise<NarrationResult> {
  const evs = m.visibleEvents();
  const ids = [...new Set(answer.citations)].slice(0, 40);
  const context = ids.map(id => evs[id]).filter(Boolean).map(e => `#${e.id} t=${e.t} ${e.type}: ${e.msg}`).join('\n');
  let out: { text: string; model: string };
  try {
    out = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `QUESTION: ${question}\n\nANALYSIS:\n${answer.text}\n\nEVENTS:\n${context || '(none)'}` }
    ]);
  } catch (e) {
    return { ok: false, reason: (e as Error).name === 'AbortError' ? 'LLM request timed out' : (e as Error).message };
  }
  const text = out.text.trim();
  const v = validateCitations(m, text);
  if (!v.ok) return { ok: false, reason: `narration cited events that do not exist: ${v.unknown.map(i => `#${i}`).join(', ')}` };
  const used = [...text.matchAll(/\[#(\d+)\]/g)].map(x => +x[1]);
  const allowed = new Set(ids);
  const foreign = used.filter(id => !allowed.has(id));
  if (foreign.length) return { ok: false, reason: `narration cited events outside the evidence: ${foreign.map(i => `#${i}`).join(', ')}` };
  if (ids.length && !used.length) return { ok: false, reason: 'narration dropped all citations' };
  return { ok: true, narration: { text, model: out.model } };
}
