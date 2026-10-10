import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import {
  ENGINE_VERSION, SAMPLES, getSample, parseWorkload, Session, runToEnd, traceHash, computeMetrics, analyze, runExperiment,
  explainEvent, answerQuestion, type Diagnostic, type Injection, type Machine, type Workload, type Experiment
} from '@kernelcraft/engine';
import * as S from './schemas.js';
import type { Store } from './store.js';
import { narrate, type ChatFn } from './llm.js';

export interface AppOptions {
  store: Store;
  chat?: ChatFn | null;
  corsOrigin?: string | string[];
  staticDir?: string;
  logLevel?: string;
}

/** Errors with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

const MAX_EVENTS = 50_000;

/* ---------------------------------------------------------- simulation */

function compile(source: string): { workload: Workload; diagnostics: Diagnostic[] } {
  const { workload, diagnostics } = parseWorkload(source);
  if (!workload) throw new ApiError(422, 'invalid_workload', `The workload has ${diagnostics.filter(d => d.severity === 'error').length} error(s).`, { diagnostics });
  return { workload, diagnostics };
}

function checkInputs(w: Workload, inputs: Injection[]) {
  const threads = w.processes.reduce((a, p) => a + p.threads.length, 0);
  for (const [i, inj] of inputs.entries()) {
    const a = inj.action;
    if (a.type === 'kill' && a.tid >= threads) throw new ApiError(422, 'invalid_input', `inputs[${i}]: there is no thread ${a.tid} (the workload has ${threads}).`);
    if (a.type === 'signal' && !(a.s in w.semaphores)) throw new ApiError(422, 'invalid_input', `inputs[${i}]: unknown semaphore \`${a.s}\`.`);
    if (a.type === 'unlock' && !w.mutexes.includes(a.m)) throw new ApiError(422, 'invalid_input', `inputs[${i}]: unknown mutex \`${a.m}\`.`);
  }
}

/** Run a workload with recorded inputs, either to the end or up to tick `until`. */
function execute(source: string, inputs: Injection[], until?: number) {
  const { workload, diagnostics } = compile(source);
  checkInputs(workload, inputs);
  const session = new Session(workload);
  session.inputs = inputs.map(i => ({ ...i, action: { ...i.action } }));
  if (until === undefined) session.run(); else session.seek(until, true);
  return { workload, diagnostics, session, m: session.machine };
}

function describe(m: Machine) {
  return {
    processes: m.s.processes.map(p => ({ pid: p.pid, name: p.name, pages: p.pages })),
    threads: m.s.threads.map(t => ({ tid: t.tid, pid: t.pid, name: t.name, priority: t.basePriority, arrive: t.arrive })),
    mutexes: Object.keys(m.s.mutexes), semaphores: Object.keys(m.s.sems), shared: Object.keys(m.s.vars)
  };
}

function summary(m: Machine, findings: { kind: string; severity: string; title: string }[]) {
  const met = computeMetrics(m);
  return {
    avgWaiting: met.avgWaiting, avgTurnaround: met.avgTurnaround, contextSwitches: met.contextSwitches,
    pageFaults: met.pageFaults, completed: met.completed, threads: met.threads.length,
    findings: findings.map(f => ({ kind: f.kind, severity: f.severity, title: f.title }))
  };
}

/* ---------------------------------------------------------------- app */

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logLevel && opts.logLevel !== 'silent' ? { level: opts.logLevel } : false,
    bodyLimit: 512 * 1024
  });
  const { store } = opts;

  await app.register(cors, { origin: opts.corsOrigin ?? true });

  app.setErrorHandler((err: FastifyError | ApiError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues } });
    }
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? err.details as object : {}) } });
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'bad_request', message: fe.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => schema.parse(v ?? {});

  /* -- meta */
  app.get('/api/health', async () => ({
    ok: true, engine: ENGINE_VERSION, storage: store.kind, database: store.kind === 'postgres' ? (await store.ping() ? 'up' : 'down') : 'n/a',
    narration: opts.chat ? 'llm' : 'deterministic'
  }));

  app.get('/api/samples', async () => ({ samples: SAMPLES.map(({ id, title, topic, blurb }) => ({ id, title, topic, blurb })) }));
  app.get('/api/samples/:id', async req => {
    const { id } = parse(S.IdParams, req.params);
    const s = getSample(id);
    if (!s) throw new ApiError(404, 'not_found', `No sample called \`${id}\`.`);
    return s;
  });

  /* -- engine */
  app.post('/api/parse', async req => {
    const { source } = parse(S.ParseBody, req.body);
    const { workload, diagnostics } = parseWorkload(source);
    return {
      ok: !!workload, diagnostics,
      ...(workload ? {
        config: workload.config,
        processes: workload.processes.map(p => ({ name: p.name, pages: p.pages, priority: p.priority, arrive: p.arrive, threads: p.threads.map(t => ({ name: t.name, ops: t.ops.length, arrive: t.arrive, priority: t.priority })) })),
        mutexes: workload.mutexes, semaphores: workload.semaphores, shared: workload.shared
      } : {})
    };
  });

  app.post('/api/simulate', async req => {
    const body = parse(S.SimulateBody, req.body);
    const { m, diagnostics, session } = execute(body.source, body.inputs, body.until);
    const inc = new Set(body.include);
    const events = m.visibleEvents();
    const finished = m.finished;
    const analysis = inc.has('analysis') ? analyze(m, { inputs: session.inputs, experiments: body.experiments && finished }) : undefined;
    return {
      engine: ENGINE_VERSION,
      status: m.s.status, tick: m.s.tick, finished, traceHash: traceHash(m),
      warnings: diagnostics.filter(d => d.severity === 'warning'),
      config: m.s.config, ...describe(m),
      metrics: computeMetrics(m),
      eventCount: events.length,
      ...(inc.has('events') ? { events: events.slice(0, MAX_EVENTS), eventsTruncated: events.length > MAX_EVENTS } : {}),
      ...(inc.has('timeline') ? { timeline: m.visibleTicks() } : {}),
      ...(inc.has('final') ? { state: m.s } : {}),
      ...(analysis ? { analysis: { headline: analysis.headline, findings: analysis.findings } } : {})
    };
  });

  app.post('/api/experiments/run', async req => {
    const body = parse(S.ExperimentBody, req.body);
    const { m, workload, session } = execute(body.source, body.inputs);
    if (body.change.kind === 'inject') checkInputs(workload, [{ at: body.change.at, action: body.change.action }]);
    if (body.change.kind === 'atomic' && !(body.change.var in workload.shared)) throw new ApiError(422, 'invalid_input', `Unknown shared variable \`${body.change.var}\`.`);
    const exp: Experiment = { id: 'custom', label: 'custom', hypothesis: '', change: body.change, metrics: body.metrics };
    return { result: runExperiment(m, session.inputs, exp) };
  });

  app.post('/api/explain', async req => {
    const body = parse(S.ExplainBody, req.body);
    const { m } = execute(body.source, body.inputs);
    const ex = explainEvent(m, body.eventId);
    if (!ex) throw new ApiError(404, 'not_found', `Event #${body.eventId} does not exist (the run has ${m.visibleEvents().length} events).`);
    return { ...ex, event: m.visibleEvents()[body.eventId] };
  });

  app.post('/api/assistant/ask', async req => {
    const body = parse(S.AskBody, req.body);
    const { m, session } = execute(body.source, body.inputs, body.at);
    const analysis = analyze(m, { inputs: session.inputs, experiments: m.finished });
    const answer = answerQuestion(m, body.question, analysis);
    let narration: { text: string; model: string } | null = null;
    let narrationError: string | null = null;
    if (body.narrate) {
      if (!opts.chat) narrationError = 'No LLM is configured (set LLM_BASE_URL); showing the deterministic answer.';
      else {
        const r = await narrate(opts.chat, m, body.question, answer);
        if (r.ok) narration = r.narration; else narrationError = r.reason;
      }
    }
    await store.logQuestion({ recordingId: body.recordingId ?? null, traceHash: traceHash(m), question: body.question, intent: answer.intent, citations: answer.citations, narrated: !!narration })
      .catch(e => req.log.warn({ err: e }, 'could not log assistant question'));
    return { ...answer, tick: m.s.tick, traceHash: traceHash(m), narration, narrationError };
  });

  /* -- recordings */
  app.post('/api/recordings', async (req, reply) => {
    const body = parse(S.CreateRecording, req.body);
    const { m } = execute(body.source, body.inputs);
    if (!m.finished) throw new ApiError(422, 'not_finished', 'The run did not finish.');
    const a = analyze(m, { experiments: false });
    const rec = await store.create({
      title: body.title, notes: body.notes, source: body.source, inputs: body.inputs,
      traceHash: traceHash(m), status: m.s.status, ticks: m.s.tick, summary: summary(m, a.findings), engineVersion: ENGINE_VERSION
    });
    return reply.status(201).send(rec);
  });
  app.get('/api/recordings', async req => {
    const { limit, offset } = parse(S.ListQuery, req.query);
    return { ...(await store.list(limit, offset)), limit, offset };
  });
  app.get('/api/recordings/:id', async req => {
    const { id } = parse(S.IdParams, req.params);
    const r = await store.get(id);
    if (!r) throw new ApiError(404, 'not_found', 'Recording not found.');
    return r;
  });
  app.patch('/api/recordings/:id', async req => {
    const { id } = parse(S.IdParams, req.params);
    const patch = parse(S.UpdateRecording, req.body);
    const r = await store.update(id, patch);
    if (!r) throw new ApiError(404, 'not_found', 'Recording not found.');
    return r;
  });
  app.delete('/api/recordings/:id', async (req, reply) => {
    const { id } = parse(S.IdParams, req.params);
    if (!(await store.remove(id))) throw new ApiError(404, 'not_found', 'Recording not found.');
    return reply.status(204).send();
  });
  /** Re-execute a recording and check that it still produces the identical trace. */
  app.post('/api/recordings/:id/verify', async req => {
    const { id } = parse(S.IdParams, req.params);
    const r = await store.get(id);
    if (!r) throw new ApiError(404, 'not_found', 'Recording not found.');
    const { workload } = compile(r.source);
    const m = runToEnd(workload, r.inputs);
    const actual = traceHash(m);
    return {
      id, reproducible: actual === r.traceHash, stored: r.traceHash, actual,
      storedEngine: r.engineVersion, engine: ENGINE_VERSION, status: m.s.status, ticks: m.s.tick
    };
  });

  /* -- static web app (production) */
  if (opts.staticDir) {
    const root = resolve(opts.staticDir);
    if (existsSync(root)) {
      await app.register(fastifyStatic, { root, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } });
        return reply.sendFile('index.html');
      });
    }
  } else {
    app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: `No route ${req.method} ${req.url}` } }));
  }

  return app;
}
