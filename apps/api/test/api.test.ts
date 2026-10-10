import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getSample, parseWorkload, runToEnd, traceHash } from '@kernelcraft/engine';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import type { ChatFn } from '../src/llm.js';

let app: FastifyInstance;
const store = new MemoryStore();
let chatReply: (prompt: string) => string = () => 'ok';
const chat: ChatFn = async msgs => ({ text: chatReply(msgs[1].content), model: 'fake-model' });

beforeAll(async () => { app = await buildApp({ store, chat }); });
afterAll(async () => { await app.close(); });

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const src = (id: string) => getSample(id)!.source;

describe('meta', () => {
  it('health reports engine version, storage and narration mode', async () => {
    const r = await app.inject('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, engine: '1.0.0', storage: 'memory', narration: 'llm' });
  });
  it('lists samples and fetches one; unknown sample is 404', async () => {
    const list = (await app.inject('/api/samples')).json();
    expect(list.samples.length).toBe(11);
    expect(list.samples[0]).not.toHaveProperty('source');
    expect((await app.inject('/api/samples/convoy')).json().source).toContain('compute 24');
    const nf = await app.inject('/api/samples/nope');
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('not_found');
  });
  it('unknown routes return a JSON 404', async () => {
    const r = await app.inject('/api/nothing');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });
});

describe('parse and simulate', () => {
  it('parse returns diagnostics with positions for a broken workload', async () => {
    const r = (await post('/api/parse', { source: 'config scheduler=lottery\nprocess A\n  frob 1' })).json();
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d: { line: number }) => d.line)).toEqual([1, 3]);
  });
  it('parse summarises a valid workload', async () => {
    const r = (await post('/api/parse', { source: src('race-counter') })).json();
    expect(r.ok).toBe(true);
    expect(r.processes[0].threads.map((t: { name: string }) => t.name)).toEqual(['teller1', 'teller2']);
    expect(r.shared).toEqual({ counter: 0 });
  });
  it('simulate returns the same trace hash as the engine run directly', async () => {
    const r = await post('/api/simulate', { source: src('convoy') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const direct = runToEnd(parseWorkload(src('convoy')).workload!);
    expect(body.traceHash).toBe(traceHash(direct));
    expect(body.status).toBe('done');
    expect(body.events.length).toBe(body.eventCount);
    expect(body.timeline.length).toBe(body.tick);
    expect(body.metrics.avgWaiting).toBe(20.25);
    expect(body.analysis.findings[0].experiment.result.deltas[0]).toMatchObject({ before: 20.25, after: 3.75 });
  });
  it('simulate can stop at a tick (time travel) and omit heavy sections', async () => {
    const r = (await post('/api/simulate', { source: src('convoy'), until: 10, include: ['final'] })).json();
    expect(r.tick).toBe(10);
    expect(r.finished).toBe(false);
    expect(r.state.tick).toBe(10);
    expect(r).not.toHaveProperty('events');
    expect(r).not.toHaveProperty('analysis');
  });
  it('recorded operator inputs are replayed: killing a deadlocked thread finishes the run', async () => {
    const r = (await post('/api/simulate', { source: src('deadlock-abba'), inputs: [{ at: 8, action: { type: 'kill', tid: 1 } }] })).json();
    expect(r.status).toBe('done');
    expect(r.metrics.threads[1].exitCode).toBe(137);
  });
  it('invalid workloads are 422 with diagnostics; malformed bodies are 400', async () => {
    const bad = await post('/api/simulate', { source: 'process A\n  lock missing' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_workload');
    expect(bad.json().error.diagnostics[0].message).toContain('Unknown mutex');
    const empty = await post('/api/simulate', { source: '' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('invalid_request');
    const huge = await post('/api/simulate', { source: 'x'.repeat(100_001) });
    expect(huge.statusCode).toBe(400);
    const badInput = await post('/api/simulate', { source: src('convoy'), inputs: [{ at: 1, action: { type: 'kill', tid: 99 } }] });
    expect(badInput.statusCode).toBe(400);
    const unknownThread = await post('/api/simulate', { source: src('convoy'), inputs: [{ at: 1, action: { type: 'kill', tid: 9 } }] });
    expect(unknownThread.statusCode).toBe(422);
    expect(unknownThread.json().error.message).toContain('no thread 9');
    const badSem = await post('/api/simulate', { source: src('convoy'), inputs: [{ at: 1, action: { type: 'signal', s: 'nope' } }] });
    expect(badSem.json().error.message).toContain('unknown semaphore');
  });
  it('rejects non-JSON bodies cleanly', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/simulate', payload: '{nope', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBeDefined();
  });
});

describe('experiments and explanations', () => {
  it('runs a custom what-if and reports measured deltas', async () => {
    const r = await post('/api/experiments/run', { source: src('round-robin'), change: { kind: 'config', patch: { quantum: 12 } }, metrics: ['switchOverhead', 'ticks'] });
    expect(r.statusCode).toBe(200);
    const res = r.json().result;
    expect(res.deltas[0].key).toBe('switchOverhead');
    expect(res.deltas[0].after).toBeLessThan(res.deltas[0].before);
    expect(res.hashBefore).not.toBe(res.hashAfter);
  });
  it('validates experiment changes', async () => {
    expect((await post('/api/experiments/run', { source: src('convoy'), change: { kind: 'config', patch: { quantum: 0 } } })).statusCode).toBe(400);
    expect((await post('/api/experiments/run', { source: src('convoy'), change: { kind: 'config', patch: { bogus: 1 } } })).statusCode).toBe(400);
    expect((await post('/api/experiments/run', { source: src('convoy'), change: { kind: 'config', patch: {} } })).statusCode).toBe(400);
    expect((await post('/api/experiments/run', { source: src('convoy'), change: { kind: 'atomic', var: 'x' } })).statusCode).toBe(422);
    expect((await post('/api/experiments/run', { source: src('convoy'), change: { kind: 'config', patch: { frames: 4 } }, metrics: ['rm -rf'] })).statusCode).toBe(400);
  });
  it('explains an event and 404s on a missing one', async () => {
    const run = (await post('/api/simulate', { source: src('thrashing'), include: ['events'] })).json();
    const fault = run.events.find((e: { type: string }) => e.type === 'PAGE_FAULT');
    const r = (await post('/api/explain', { source: src('thrashing'), eventId: fault.id })).json();
    expect(r.event.id).toBe(fault.id);
    expect(r.text).toContain('cold miss');
    expect((await post('/api/explain', { source: src('thrashing'), eventId: 999999 })).statusCode).toBe(404);
  });
});

describe('assistant', () => {
  it('answers deterministically with citations and logs the question', async () => {
    const before = store.log.length;
    const r = (await post('/api/assistant/ask', { source: src('deadlock-abba'), question: 'why does it hang?' })).json();
    expect(r.intent).toBe('deadlock');
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.experiments[0].result.statusAfter).toBe('done');
    expect(r.narration).toBeNull();
    expect(store.log.length).toBe(before + 1);
    expect(store.log.at(-1)).toMatchObject({ intent: 'deadlock', narrated: false });
  });
  it('can answer about an earlier point in time', async () => {
    const r = (await post('/api/assistant/ask', { source: src('convoy'), question: 'what happened at t=3', at: 10 })).json();
    expect(r.tick).toBe(10);
    expect(r.intent).toBe('tick');
  });
  it('accepts an LLM narration that only cites supplied evidence', async () => {
    chatReply = prompt => {
      const id = /#(\d+) t=/.exec(prompt)![1];
      return `The two transfers wait on each other's lock [#${id}].`;
    };
    const r = (await post('/api/assistant/ask', { source: src('deadlock-abba'), question: 'why stuck', narrate: true })).json();
    expect(r.narration.model).toBe('fake-model');
    expect(r.narration.text).toMatch(/\[#\d+\]/);
    expect(r.narrationError).toBeNull();
  });
  it('rejects an LLM narration with invented citations and falls back', async () => {
    chatReply = () => 'It is a deadlock [#424242].';
    const r = (await post('/api/assistant/ask', { source: src('deadlock-abba'), question: 'why stuck', narrate: true })).json();
    expect(r.narration).toBeNull();
    expect(r.narrationError).toContain('#424242');
    expect(r.text.length).toBeGreaterThan(50);   // deterministic answer still there
  });
  it('rejects a narration that cites real events outside the evidence, or drops citations', async () => {
    chatReply = () => 'Something happened [#0].';
    const a = (await post('/api/assistant/ask', { source: src('deadlock-abba'), question: 'why stuck', narrate: true })).json();
    expect(a.narrationError).toContain('outside the evidence');
    chatReply = () => 'It is a deadlock.';
    const b = (await post('/api/assistant/ask', { source: src('deadlock-abba'), question: 'why stuck', narrate: true })).json();
    expect(b.narrationError).toContain('dropped all citations');
  });
  it('reports LLM failures without failing the request', async () => {
    chatReply = () => { throw new Error('LLM endpoint returned 503'); };
    const r = await post('/api/assistant/ask', { source: src('convoy'), question: 'why slow', narrate: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().narrationError).toContain('503');
  });
});

describe('recordings (memory store)', () => {
  it('create → list → get → patch → verify → delete', async () => {
    const created = await post('/api/recordings', { title: 'ABBA recovered', source: src('deadlock-abba'), inputs: [{ at: 8, action: { type: 'kill', tid: 1 } }] });
    expect(created.statusCode).toBe(201);
    const rec = created.json();
    expect(rec).toMatchObject({ title: 'ABBA recovered', status: 'done', engineVersion: '1.0.0' });
    expect(rec.traceHash).toMatch(/^[0-9a-f]{8}$/);
    const list = (await app.inject('/api/recordings?limit=5')).json();
    expect(list.items.some((i: { id: string }) => i.id === rec.id)).toBe(true);
    const patched = (await app.inject({ method: 'PATCH', url: `/api/recordings/${rec.id}`, payload: { notes: 'kill tid 1' } })).json();
    expect(patched.notes).toBe('kill tid 1');
    const v = (await post(`/api/recordings/${rec.id}/verify`, {})).json();
    expect(v).toMatchObject({ reproducible: true, stored: rec.traceHash, actual: rec.traceHash });
    expect((await app.inject({ method: 'DELETE', url: `/api/recordings/${rec.id}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/recordings/${rec.id}`)).statusCode).toBe(404);
  });
  it('validates recording input', async () => {
    expect((await post('/api/recordings', { title: '', source: src('convoy') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/recordings/x', payload: {} })).statusCode).toBe(400);
    expect((await app.inject('/api/recordings?limit=1000')).statusCode).toBe(400);
  });
});
