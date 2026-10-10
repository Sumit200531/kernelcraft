import { Machine, type Snapshot } from './kernel.js';
import { parseWorkload } from './parser.js';
import type { Diagnostic, InjectAction, Injection, Workload } from './types.js';

/**
 * A recorded execution with time travel.
 *
 * The machine is deterministic, so the only inputs that need recording are
 * operator injections. Keyframes (full snapshots) are kept every `interval`
 * ticks; seeking restores the nearest earlier keyframe and re-executes forward.
 * Injecting at a point in the past truncates the future and starts a new branch.
 */
export class Session {
  readonly workload: Workload;
  machine: Machine;
  inputs: Injection[] = [];
  private keyframes = new Map<number, Snapshot>();
  readonly interval: number;
  /** furthest tick reached on the current branch */
  horizon = 0;

  constructor(workload: Workload, interval = 32) {
    this.workload = workload;
    this.interval = interval;
    this.machine = new Machine(workload);
    this.keyframes.set(0, this.machine.snapshot());
  }

  static fromSource(src: string): { session: Session | null; diagnostics: Diagnostic[] } {
    const { workload, diagnostics } = parseWorkload(src);
    return { session: workload ? new Session(workload) : null, diagnostics };
  }

  get tick() { return this.machine.s.tick; }
  get finished() { return this.machine.finished; }

  /** True if there is a recorded operator input waiting at the current tick. */
  private hasInputNow(): boolean { const t = this.machine.s.tick; return this.inputs.some(i => i.at === t); }

  /** True while stepping can still change the machine (running, or halted with a recorded input to apply). */
  get canContinue(): boolean {
    const st = this.machine.s.status;
    return !this.machine.finished || ((st === 'deadlock' || st === 'stalled') && this.hasInputNow());
  }

  /** Advance one tick, recording keyframes. Returns false when the run has ended. */
  step(): boolean {
    const m = this.machine;
    // Recorded operator inputs are queued again when replay reaches their tick. An input
    // can reopen a run that halted on a deadlock or stall (that is how recovery is recorded).
    let queued = false;
    for (const inj of this.inputs) {
      if (inj.at !== m.s.tick) continue;
      const key = JSON.stringify(inj);
      if (!m.s.pendingInjections.some(p => JSON.stringify(p) === key)) m.s.pendingInjections.push({ at: inj.at, action: { ...inj.action } });
      queued = true;
    }
    if (queued && (m.s.status === 'deadlock' || m.s.status === 'stalled')) m.s.status = 'running';
    if (m.finished) return false;
    m.step();
    const t = m.s.tick;
    if (t % this.interval === 0 && !this.keyframes.has(t)) this.keyframes.set(t, m.snapshot());
    if (t > this.horizon) this.horizon = t;
    return this.canContinue;
  }

  run(maxTicks = Infinity) { let n = 0; while (this.canContinue && n++ < maxTicks) this.step(); }

  /** Jump to tick `t` (clamped to [0, horizon] unless `extend` allows running further). */
  seek(t: number, extend = false) {
    t = Math.max(0, Math.floor(t));
    if (!extend) t = Math.min(t, this.horizon);
    const m = this.machine;
    if (t === m.s.tick) return;
    if (t < m.s.tick || !this.keyframes.size) {
      let best = 0;
      for (const k of this.keyframes.keys()) if (k <= t && k > best) best = k;
      m.restore(this.keyframes.get(best)!);
    } else {
      // forward: jump to the nearest keyframe ahead of the current position if it helps
      let best = m.s.tick;
      for (const k of this.keyframes.keys()) if (k <= t && k > best) best = k;
      if (best > m.s.tick) m.restore(this.keyframes.get(best)!);
    }
    while (m.s.tick < t && this.canContinue) this.step();
  }

  /** Record an operator action at the current tick; drops any recorded future (new branch). */
  inject(action: InjectAction) {
    const t = this.machine.s.tick;
    this.inputs = this.inputs.filter(i => i.at < t);
    for (const k of [...this.keyframes.keys()]) if (k > t) this.keyframes.delete(k);
    this.horizon = t;
    this.machine.truncate();
    const inj: Injection = { at: t, action };
    this.inputs.push(inj);
    this.machine.inject(action);
  }

  /** Reset to tick 0 but keep recorded inputs (deterministic replay). */
  rewind() { this.seek(0); }
}

/** Run a workload to completion and return the machine (used by tests, the API and what-if analysis). */
export function runToEnd(workload: Workload, inputs: Injection[] = []): Machine {
  const s = new Session(workload, 1_000_000);
  s.inputs = inputs.map(i => ({ ...i }));
  s.run();
  return s.machine;
}

/** FNV-1a hash of the event log: two runs are identical iff their hashes match. */
export function traceHash(m: Machine): string {
  let h = 0x811c9dc5;
  const feed = (str: string) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  for (const e of m.visibleEvents()) feed(`${e.id}|${e.t}|${e.type}|${e.tid ?? ''}|${e.core ?? ''}|${JSON.stringify(e.data ?? null)};`);
  feed(`|${m.s.tick}|${m.s.status}`);
  return h.toString(16).padStart(8, '0');
}
