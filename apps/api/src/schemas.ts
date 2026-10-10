import { z } from 'zod';

export const MAX_SOURCE = 100_000;

export const InjectAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('kill'), tid: z.number().int().min(0).max(63) }),
  z.object({ type: z.literal('signal'), s: z.string().regex(/^[A-Za-z_][\w]{0,31}$/) }),
  z.object({ type: z.literal('unlock'), m: z.string().regex(/^[A-Za-z_][\w]{0,31}$/) })
]);
export const Injection = z.object({ at: z.number().int().min(0).max(200_000), action: InjectAction });

export const Source = z.string().min(1, 'source is empty').max(MAX_SOURCE, `source is longer than ${MAX_SOURCE} characters`);
export const Inputs = z.array(Injection).max(500).default([]);

export const ParseBody = z.object({ source: Source });

export const SimulateBody = z.object({
  source: Source,
  inputs: Inputs,
  /** stop at this tick instead of running to the end (time travel) */
  until: z.number().int().min(0).max(200_000).optional(),
  include: z.array(z.enum(['events', 'timeline', 'analysis', 'final'])).default(['events', 'timeline', 'analysis']),
  experiments: z.boolean().default(true)
});

const ConfigPatch = z.object({
  cores: z.number().int().min(1).max(4),
  scheduler: z.enum(['fcfs', 'sjf', 'srtf', 'priority', 'rr']),
  quantum: z.number().int().min(1).max(1000),
  preempt: z.boolean(),
  aging: z.number().int().min(0).max(10000),
  inherit: z.boolean(),
  cs: z.number().int().min(0).max(50),
  frames: z.number().int().min(1).max(256),
  replacement: z.enum(['fifo', 'lru', 'clock']),
  tlb: z.number().int().min(0).max(64),
  tlbPenalty: z.number().int().min(0).max(20),
  fault: z.number().int().min(1).max(500),
  writeback: z.number().int().min(0).max(500),
  starve: z.number().int().min(0).max(100000),
  deadlock: z.enum(['halt', 'continue']),
  maxTicks: z.number().int().min(1).max(200000)
}).partial().strict();

export const ExperimentChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('config'), patch: ConfigPatch.refine(p => Object.keys(p).length > 0, 'patch is empty') }),
  z.object({ kind: z.literal('inject'), at: z.number().int().min(0).max(200_000), action: InjectAction }),
  z.object({ kind: z.literal('atomic'), var: z.string().regex(/^[A-Za-z_][\w]{0,31}$/) })
]);

export const ExperimentBody = z.object({
  source: Source,
  inputs: Inputs,
  change: ExperimentChange,
  metrics: z.array(z.string().regex(/^(avgWaiting|avgTurnaround|ticks|pageFaults|switchOverhead|completed|cpuWork|thread(Wait|Finish|Blocked|Response):\d+|varError:[A-Za-z_]\w*)$/)).min(1).max(6)
    .default(['avgWaiting', 'ticks'])
});

export const ExplainBody = z.object({ source: Source, inputs: Inputs, eventId: z.number().int().min(0) });

export const AskBody = z.object({
  source: Source,
  inputs: Inputs,
  question: z.string().trim().min(1).max(2000),
  /** analyse the state at this tick instead of the end of the run */
  at: z.number().int().min(0).max(200_000).optional(),
  narrate: z.boolean().default(false),
  recordingId: z.string().optional()
});

export const CreateRecording = z.object({
  title: z.string().trim().min(1).max(120),
  notes: z.string().max(4000).default(''),
  source: Source,
  inputs: Inputs
});
export const UpdateRecording = z.object({ title: z.string().trim().min(1).max(120), notes: z.string().max(4000) }).partial()
  .refine(p => Object.keys(p).length > 0, 'nothing to update');
export const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
export const IdParams = z.object({ id: z.string().min(1).max(64) });
