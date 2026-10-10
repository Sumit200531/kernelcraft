import type { Machine } from './kernel.js';
import { runToEnd, traceHash } from './session.js';
import { computeMetrics, type SystemMetrics } from './metrics.js';
import { CONFIG_KEYS } from './parser.js';
import type { Config, InjectAction, Injection, Op, SimEvent, Workload } from './types.js';

/**
 * Trace analysis.
 *
 * Every finding is derived from the event log of an actual run and cites the
 * event ids it is based on. Suggested experiments are real counterfactual
 * re-runs: the workload is changed (a config patch, an operator injection or a
 * code transform), executed to completion, and the measured metrics of both
 * runs are reported side by side. Nothing here is estimated.
 */

export type FindingKind =
  | 'deadlock' | 'stall' | 'race' | 'segfault' | 'unlock-error' | 'max-ticks'
  | 'thrashing' | 'convoy' | 'starvation' | 'priority-inversion' | 'switch-overhead' | 'lock-contention';
export type Severity = 'critical' | 'warning' | 'info';

/** Metric keys understood by `measure`. Thread/var metrics are suffixed with `:tid` or `:name`. */
export type MetricKey = string;

export type ExperimentChange =
  | { kind: 'config'; patch: Partial<Config> }
  | { kind: 'inject'; at: number; action: InjectAction }
  | { kind: 'atomic'; var: string };

export interface Experiment {
  id: string;
  label: string;
  hypothesis: string;
  change: ExperimentChange;
  metrics: MetricKey[];          // first one is the primary metric
  result?: ExperimentResult;
}

export interface MetricDelta { key: MetricKey; label: string; before: number | null; after: number | null; better: 'lower' | 'higher' }

export interface ExperimentResult {
  deltas: MetricDelta[];
  improved: boolean;             // primary metric moved in the better direction
  statusBefore: string;
  statusAfter: string;
  hashBefore: string;
  hashAfter: string;
  summary: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  evidence: number[];            // event ids, in time order
  tids: number[];
  lines: number[];
  advice: string;
  experiment?: Experiment;
}

export interface Analysis {
  status: string;
  ticks: number;
  headline: string;
  findings: Finding[];
  metrics: SystemMetrics;
}

export interface AnalyzeOptions {
  /** operator inputs of the analysed run (so baselines for experiments replay them) */
  inputs?: Injection[];
  /** run counterfactual experiments (default true) */
  experiments?: boolean;
}

/* ------------------------------------------------------------- metrics */

const METRIC_LABELS: Record<string, string> = {
  avgWaiting: 'average waiting time', avgTurnaround: 'average turnaround', ticks: 'total ticks', pageFaults: 'page faults',
  switchOverhead: 'CPU time spent switching', completed: 'threads completed', cpuWork: 'CPU ticks of useful work',
  threadWait: 'waiting time of', threadResponse: 'response time of', threadFinish: 'finish time of', threadBlocked: 'blocked time of', varError: 'wrong by'
};

/** Read one metric from a finished run. */
export function measure(m: Machine, key: MetricKey, met: SystemMetrics = computeMetrics(m)): number | null {
  const [name, arg] = key.split(':');
  switch (name) {
    case 'avgWaiting': return met.avgWaiting;
    case 'avgTurnaround': return met.avgTurnaround;
    case 'ticks': return met.ticks;
    case 'pageFaults': return met.pageFaults;
    case 'switchOverhead': return Math.round(met.switchOverhead * 1000) / 1000;
    case 'completed': return met.completed;
    case 'cpuWork': return met.threads.reduce((a, t) => a + t.cpu, 0);
    case 'threadWait': return met.threads[+arg]?.waiting ?? null;
    case 'threadResponse': return met.threads[+arg]?.response ?? null;
    case 'threadFinish': { const t = met.threads[+arg]; return t && t.finish >= 0 ? t.finish : null; }
    case 'threadBlocked': return met.threads[+arg]?.blocked ?? null;
    case 'varError': { const v = met.vars.find(x => x.name === arg); return v ? Math.abs(v.expected - v.value) : null; }
  }
  return null;
}

function metricLabel(m: Machine, key: MetricKey): string {
  const [name, arg] = key.split(':');
  const base = METRIC_LABELS[name] ?? name;
  if (name.startsWith('thread')) return `${base} ${m.s.threads[+arg]?.name ?? arg}`;
  if (name === 'varError') return `${arg} ${base}`;
  return base;
}

const higherIsBetter = (key: MetricKey) => key === 'completed' || key === 'cpuWork';

/* ------------------------------------------------------- experiments */

/** Replace every `ldv v / add v / stv v` sequence with one atomic op (keeps source lines). */
function atomicTransform(w: Workload, name: string): Workload {
  return {
    ...w,
    processes: w.processes.map(p => ({
      ...p,
      threads: p.threads.map(t => {
        const ops: Op[] = [];
        for (let i = 0; i < t.ops.length; i++) {
          const a = t.ops[i], b = t.ops[i + 1], c = t.ops[i + 2];
          if (a.k === 'ldv' && a.v === name && b?.k === 'add' && b.v === name && c?.k === 'stv' && c.v === name) {
            ops.push({ k: 'atomic', v: name, d: b.d, line: a.line });
            i += 2;
          } else ops.push(a);
        }
        return { ...t, ops };
      })
    }))
  };
}

export function applyChange(w: Workload, inputs: Injection[], change: ExperimentChange): { workload: Workload; inputs: Injection[] } {
  if (change.kind === 'config') return { workload: { ...w, config: { ...w.config, ...change.patch } }, inputs };
  if (change.kind === 'inject') return { workload: w, inputs: [...inputs.filter(i => i.at <= change.at), { at: change.at, action: change.action }] };
  return { workload: atomicTransform(w, change.var), inputs };
}

/** Execute an experiment against a baseline run and fill in `result`. */
export function runExperiment(base: Machine, baseInputs: Injection[], exp: Experiment): ExperimentResult {
  const variant = applyChange(base.workload, baseInputs, exp.change);
  const after = runToEnd(variant.workload, variant.inputs);
  const mb = computeMetrics(base), ma = computeMetrics(after);
  const deltas: MetricDelta[] = exp.metrics.map(k => ({
    key: k, label: metricLabel(base, k), before: measure(base, k, mb), after: measure(after, k, ma), better: higherIsBetter(k) ? 'higher' : 'lower'
  }));
  const p = deltas[0];
  const improved = p.before !== null && p.after !== null && (p.better === 'lower' ? p.after < p.before : p.after > p.before)
    || (p.before === null && p.after !== null);
  const fmt = (v: number | null) => (v === null ? 'n/a' : Number.isInteger(v) ? String(v) : v.toFixed(2));
  const parts = deltas.map(d => `${d.label}: ${fmt(d.before)} → ${fmt(d.after)}`);
  if (base.s.status !== after.s.status) parts.push(`run status: ${base.s.status} → ${after.s.status}`);
  return {
    deltas, improved, statusBefore: base.s.status, statusAfter: after.s.status,
    hashBefore: traceHash(base), hashAfter: traceHash(after),
    summary: `${improved ? 'Confirmed' : 'Not confirmed'}: ${parts.join('; ')}.`
  };
}

/* ------------------------------------------------------------ helpers */

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const sortIds = (xs: (number | undefined)[]) => uniq(xs.filter((x): x is number => typeof x === 'number')).sort((a, b) => a - b);
const lineList = (evs: (SimEvent | undefined)[]) => uniq(evs.map(e => e?.line).filter((l): l is number => typeof l === 'number')).sort((a, b) => a - b);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : /(s|sh|ch)$/.test(w) ? 'es' : 's'}`;

/* ------------------------------------------------------------ analyze */

export function analyze(m: Machine, opts: AnalyzeOptions = {}): Analysis {
  const s = m.s;
  const events = m.visibleEvents();
  const ticks = m.visibleTicks();
  const met = computeMetrics(m);
  const name = (tid: number) => s.threads[tid]?.name ?? `tid ${tid}`;
  const byType = (type: string) => events.filter(e => e.type === type);
  const findings: Finding[] = [];
  const inputs = opts.inputs ?? [];

  /* ---- deadlock: the wait-for cycle, who holds what and since when */
  for (const d of byType('DEADLOCK')) {
    const tids = d.data!.tids as number[];
    const res = d.data!.resources as string[];
    const ev: (SimEvent | undefined)[] = [];
    const orders: string[] = [];
    tids.forEach((tid, i) => {
      const holds = res[(i + tids.length - 1) % tids.length];    // the lock the previous thread in the cycle waits for
      ev.push([...events].reverse().find(e => e.id < d.id && e.tid === tid && (e.type === 'LOCK_ACQUIRE' || e.type === 'LOCK_HANDOFF') && e.data!.mutex === holds));
      ev.push([...events].reverse().find(e => e.id < d.id && e.tid === tid && e.type === 'LOCK_CONTEND' && e.data!.mutex === res[i]));
      const order = events.filter(e => e.id < d.id && e.tid === tid && (e.type === 'LOCK_ACQUIRE' || e.type === 'LOCK_HANDOFF' || e.type === 'LOCK_CONTEND'))
        .map(e => e.data!.mutex as string);
      orders.push(`${name(tid)} takes ${uniq(order).join(' → ')}`);
    });
    const victim = Math.max(...tids);
    const self = tids.length === 1;
    findings.push({
      id: `deadlock:${d.id}`, kind: 'deadlock', severity: 'critical',
      title: self ? `${name(tids[0])} deadlocked on itself` : `Deadlock between ${tids.map(name).join(', ')}`,
      detail: self
        ? `${name(tids[0])} tried to lock ${res[0]} while already holding it. Mutexes here are not recursive, so it waits for itself forever.`
        : `The wait-for graph has a cycle at t=${d.t}: ${tids.map((t, i) => `${name(t)} waits for ${res[i]}`).join(', ')}. Each lock is held by the next thread in the cycle, so none can proceed. Acquisition order: ${orders.join('; ')}.`,
      evidence: sortIds([...ev.map(e => e?.id), d.id]),
      tids: [...tids], lines: lineList(ev),
      advice: self
        ? `Remove the second \`lock ${res[0]}\`, or release it first.`
        : `Make every thread acquire ${uniq(res).sort().join(', ')} in one global order. To recover this run, kill one thread from the terminal (\`kill ${victim}\`).`,
      experiment: {
        id: `deadlock:${d.id}:kill`, label: `Kill ${name(victim)} at t=${d.t}`,
        hypothesis: `Killing one thread breaks the cycle: its locks are released and the rest of the cycle completes.`,
        change: { kind: 'inject', at: d.t, action: { type: 'kill', tid: victim } }, metrics: ['completed', 'ticks']
      }
    });
  }

  /* ---- stall: everyone blocked on semaphores (or locks held by blocked threads) with no cycle */
  for (const st of byType('STALL')) {
    const tids = st.data!.tids as number[];
    const semsWaited = uniq(tids.map(t => s.threads[t].block).filter(b => b?.kind === 'sem').map(b => (b as { s: string }).s));
    const blockEvs = tids.map(t => [...events].reverse().find(e => e.id < st.id && e.tid === t && (e.type === 'SEM_BLOCK' || e.type === 'LOCK_CONTEND')));
    const counts = semsWaited.map(sn => {
      const waits = events.filter(e => (e.type === 'SEM_WAIT' || e.type === 'SEM_BLOCK') && e.data!.sem === sn).length;
      const signals = events.filter(e => (e.type === 'SEM_SIGNAL' || e.type === 'SEM_HANDOFF') && e.data!.sem === sn).length;
      return { sn, waits, signals, initial: s.sems[sn]?.initial ?? 0 };
    });
    const sem = semsWaited[0];
    findings.push({
      id: `stall:${st.id}`, kind: 'stall', severity: 'critical',
      title: `Stall: ${tids.map(name).join(', ')} wait forever`,
      detail: `At t=${st.t} no thread can run and nothing is pending (no I/O, timers or page-ins), but there is no lock cycle. ` +
        counts.map(c => `Semaphore ${c.sn} started at ${c.initial} and saw ${plural(c.waits, 'wait')} but only ${plural(c.signals, 'signal')}.`).join(' ') +
        (sem ? ` A missing \`signal ${sem}\` is the usual cause.` : ''),
      evidence: sortIds([...blockEvs.map(e => e?.id), st.id]), tids: [...tids], lines: lineList(blockEvs),
      advice: sem ? `Check that every path that consumes ${sem} has a matching \`signal ${sem}\`. To unstick this run: \`signal ${sem}\` in the terminal.` : 'Look at what each blocked thread waits for.',
      experiment: sem ? {
        id: `stall:${st.id}:signal`, label: `signal(${sem}) at t=${st.t}`,
        hypothesis: `If the stall is a missing signal on ${sem}, posting it lets blocked threads do more work.`,
        change: { kind: 'inject', at: st.t, action: { type: 'signal', s: sem } }, metrics: ['cpuWork', 'completed']
      } : undefined
    });
  }

  /* ---- races: lockset report + exact lost-update accounting */
  for (const r of byType('RACE')) {
    const v = r.data!.var as string;
    const cited = (r.data!.events as number[]).map(id => m.events[id]);
    const lostEvs = events.filter(e => e.type === 'LOST_UPDATE' && e.data!.var === v);
    const lost = lostEvs.reduce((a, e) => a + (e.data!.lost as number), 0);
    const vm = met.vars.find(x => x.name === v);
    const atomicable = m.ops.some(ops => ops.some((o, i) => o.k === 'ldv' && o.v === v && ops[i + 1]?.k === 'add' && ops[i + 2]?.k === 'stv'));
    findings.push({
      id: `race:${v}`, kind: 'race', severity: lost ? 'critical' : 'warning',
      title: lost ? `Data race on ${v}: ${plural(lost, 'update')} lost` : `Data race on ${v}`,
      detail: `${(r.data!.threads as number[]).map(name).join(' and ')} both write ${v} with no lock in common (lockset analysis, t=${r.t}). ` +
        (lost
          ? `Each \`inc\` is three steps (read, add, write); a thread preempted between its read and write writes back a stale value. ${plural(lostEvs.length, 'stale write')} destroyed ${plural(lost, 'update')}: ${v} ended at ${vm?.value} instead of ${vm?.expected}.`
          : `No update was lost in this interleaving, but a different schedule (another quantum, another core count) can lose them.`),
      evidence: sortIds([r.id, ...cited.map(e => e?.id), ...lostEvs.slice(0, 6).map(e => e.id), ...lostEvs.slice(0, 6).map(e => e.data!.readEvent as number)]),
      tids: [...(r.data!.threads as number[])], lines: lineList([...cited, ...lostEvs.slice(0, 1)]),
      advice: `Protect every access to ${v} with the same mutex, or use \`atomic_inc ${v}\`.`,
      experiment: atomicable ? {
        id: `race:${v}:atomic`, label: `Make updates to ${v} atomic`,
        hypothesis: `If the lost updates come from the read-modify-write window, a single atomic instruction removes them.`,
        change: { kind: 'atomic', var: v }, metrics: [`varError:${v}`, 'ticks']
      } : undefined
    });
  }

  /* ---- segfaults and lock misuse */
  for (const e of byType('SEGFAULT')) {
    const d = e.data as { addr: number; vpn: number; pages: number };
    findings.push({
      id: `segfault:${e.id}`, kind: 'segfault', severity: 'critical',
      title: `${s.processes[e.pid!].name} crashed with a segmentation fault`,
      detail: `${name(e.tid!)} accessed 0x${d.addr.toString(16)}, which is page ${d.vpn}, but the process only has pages 0–${d.pages - 1} (${d.pages * s.config.pageSize} bytes). The MMU has no mapping, so the process was killed with exit code 139 and its frames were reclaimed.`,
      evidence: [e.id, ...events.filter(x => x.type === 'PROCESS_EXIT' && x.data!.pid === e.pid).map(x => x.id)],
      tids: [e.tid!], lines: lineList([e]),
      advice: `Fix the address on line ${e.line}, or declare the process with \`pages=${d.vpn + 1}\`.`
    });
  }
  for (const e of byType('UNLOCK_NOT_OWNER')) {
    const owner = e.data!.owner as number;
    findings.push({
      id: `unlock:${e.id}`, kind: 'unlock-error', severity: 'critical',
      title: `${name(e.tid!)} unlocked ${e.data!.mutex} without owning it`,
      detail: `Only the owner may release a mutex. ${owner >= 0 ? `It was held by ${name(owner)}.` : 'It was not held at all.'} The thread was aborted (exit code 134).`,
      evidence: [e.id], tids: [e.tid!], lines: lineList([e]),
      advice: `Remove the stray \`unlock\` on line ${e.line} or add the missing \`lock\` before it.`
    });
  }
  if (s.status === 'max-ticks') {
    const live = s.threads.filter(t => t.state !== 'terminated');
    findings.push({
      id: 'max-ticks', kind: 'max-ticks', severity: 'warning',
      title: `Stopped at the tick limit (${s.config.maxTicks})`,
      detail: `${live.map(t => t.name).join(', ')} had not finished. The workload may be too long for the limit, or a deadlock is being ignored (deadlock=continue).`,
      evidence: byType('HALT').map(e => e.id), tids: live.map(t => t.tid), lines: [],
      advice: 'Raise `maxticks` in the config line, or look for threads that never make progress.'
    });
  }

  /* ---- thrashing: pages evicted and faulted straight back in */
  {
    const evictedAt = new Map<string, SimEvent>();
    const refaults: { evict: SimEvent; fault: SimEvent }[] = [];
    const faults = byType('PAGE_FAULT');
    for (const e of events) {
      if (e.type === 'PAGE_EVICT') evictedAt.set(`${e.data!.pid}:${e.data!.vpn}`, e);
      else if (e.type === 'PAGE_FAULT') {
        const k = `${e.pid}:${e.data!.vpn}`;
        const prev = evictedAt.get(k);
        if (prev) { refaults.push({ evict: prev, fault: e }); evictedAt.delete(k); }
      }
    }
    if (faults.length >= 8 && refaults.length >= 4 && refaults.length / faults.length >= 0.4) {
      const ws = new Map<number, Set<number>>();
      for (const e of events) if ((e.type === 'MEM_ACCESS' || e.type === 'PAGE_FAULT') && e.pid !== undefined) {
        const vpn = (e.data!.vpn as number | undefined); if (vpn === undefined) continue;
        if (!ws.has(e.pid)) ws.set(e.pid, new Set()); ws.get(e.pid)!.add(vpn);
      }
      const need = [...ws.values()].reduce((a, x) => a + x.size, 0);
      const frames = Math.min(256, Math.max(need, s.config.frames * 2));
      const pids = [...ws.keys()];
      findings.push({
        id: 'thrashing', kind: 'thrashing', severity: 'warning',
        title: `Thrashing: ${refaults.length} of ${faults.length} page faults re-load a page that was just evicted`,
        detail: `The processes touch ${need} distinct pages (${pids.map(p => `${s.processes[p].name}: ${ws.get(p)!.size}`).join(', ')}) but there are only ${s.config.frames} frames. ` +
          `${s.config.replacement.toUpperCase()} keeps evicting pages that are needed again soon, so threads spend ${met.threads.reduce((a, t) => a + t.blocked, 0)} ticks blocked and the CPU idles ${Math.round((1 - met.cpuUtilization[0]) * 100)}% of the time on core 0.`,
        evidence: sortIds(refaults.slice(0, 4).flatMap(r => [r.evict.id, r.fault.id])),
        tids: uniq(refaults.map(r => r.fault.tid!)), lines: lineList(refaults.slice(0, 4).map(r => r.fault)),
        advice: `Give the machine at least ${need} frames, run fewer processes at once, or shrink the working sets.`,
        experiment: {
          id: 'thrashing:frames', label: `frames=${frames}`,
          hypothesis: `If the working sets (${need} pages) fit in memory, refaults disappear and the run finishes sooner.`,
          change: { kind: 'config', patch: { frames } }, metrics: ['pageFaults', 'ticks']
        }
      });
    }
  }

  /* ---- convoy: one long CPU burst ahead of short jobs under FCFS */
  if (s.config.scheduler === 'fcfs') {
    const dispatchT = new Map<number, number>();
    for (const e of byType('DISPATCH')) if (!dispatchT.has(e.tid!)) dispatchT.set(e.tid!, e.t);
    for (const L of met.threads) {
      if (!dispatchT.has(L.tid) || L.cpu < 6) continue;
      const behind = met.threads.filter(T => T.tid !== L.tid && T.cpu * 2 <= L.cpu && T.arrive <= dispatchT.get(L.tid)! + L.cpu &&
        (dispatchT.get(T.tid) ?? Infinity) > dispatchT.get(L.tid)! && T.waiting * 2 >= L.cpu);
      if (behind.length < 2) continue;
      const lDisp = byType('DISPATCH').find(e => e.tid === L.tid)!;
      findings.push({
        id: `convoy:${L.tid}`, kind: 'convoy', severity: 'warning',
        title: `Convoy effect behind ${L.name}`,
        detail: `${L.name} needs ${L.cpu} ticks of CPU and FCFS runs it to completion first. ${behind.map(T => `${T.name} (needs ${T.cpu}) waited ${T.waiting}`).join(', ')}. Average waiting time is ${met.avgWaiting?.toFixed(2)}.`,
        evidence: sortIds([lDisp.id, ...behind.map(T => events.find(e => e.type === 'ARRIVE' && e.tid === T.tid)?.id), ...behind.map(T => events.find(e => e.type === 'DISPATCH' && e.tid === T.tid)?.id)]),
        tids: [L.tid, ...behind.map(T => T.tid)], lines: lineList([lDisp]),
        advice: 'Shortest-job-first minimises average waiting time when bursts are known; round robin bounds the wait without knowing them.',
        experiment: {
          id: `convoy:${L.tid}:sjf`, label: 'scheduler=sjf',
          hypothesis: 'Running the short jobs first cuts the average waiting time.',
          change: { kind: 'config', patch: { scheduler: 'sjf' } }, metrics: ['avgWaiting', 'avgTurnaround']
        }
      });
      break;
    }
  }

  /* ---- starvation */
  for (const e of byType('STARVATION')) {
    const th = s.threads[e.tid!];
    const prio = s.config.scheduler === 'priority';
    const blockers = uniq(ticks.slice(Math.max(0, e.t - (e.data!.waited as number)), e.t + 1).flatMap(tk => tk.cores.filter(c => c.kind === 'run').map(c => c.tid)));
    findings.push({
      id: `starvation:${th.tid}`, kind: 'starvation', severity: 'warning',
      title: `${th.name} is starving`,
      detail: `${th.name} had been ready for ${e.data!.waited} ticks at t=${e.t} without getting a CPU` +
        (prio ? ` because ${blockers.map(name).join(', ')} always had a better priority (${th.name} has priority ${th.basePriority}; lower numbers win).` : ` while ${blockers.map(name).join(', ')} ran.`) +
        ` In total it waited ${met.threads[th.tid].waiting} ticks.`,
      evidence: sortIds([events.find(x => x.type === 'ARRIVE' && x.tid === th.tid)?.id, e.id, events.find(x => x.type === 'DISPATCH' && x.tid === th.tid)?.id]),
      tids: [th.tid, ...blockers], lines: [],
      advice: prio ? 'Priority aging raises the priority of a thread the longer it waits, which bounds starvation.' : 'Round robin guarantees every ready thread a time slice.',
      experiment: prio && !s.config.aging ? {
        id: `starvation:${th.tid}:aging`, label: 'aging=4',
        hypothesis: `With aging, ${th.name} gains one priority level every 4 ticks it waits and eventually runs.`,
        change: { kind: 'config', patch: { aging: 4 } }, metrics: [`threadResponse:${th.tid}`, `threadWait:${th.tid}`, `threadFinish:${th.tid}`]
      } : !prio && s.config.scheduler !== 'rr' ? {
        id: `starvation:${th.tid}:rr`, label: 'scheduler=rr',
        hypothesis: `Round robin gives ${th.name} a slice every round.`,
        change: { kind: 'config', patch: { scheduler: 'rr' } }, metrics: [`threadResponse:${th.tid}`, `threadWait:${th.tid}`, `threadFinish:${th.tid}`]
      } : undefined
    });
  }

  /* ---- priority inversion: H waits on a lock held by low-priority L while medium threads run */
  if (s.config.scheduler === 'priority') {
    const seen = new Set<number>();
    for (const c of byType('LOCK_CONTEND')) {
      const H = s.threads[c.tid!], L = s.threads[c.data!.owner as number];
      if (!L || H.tid === L.tid || L.basePriority <= H.basePriority || seen.has(H.tid)) continue;
      const got = events.find(e => e.id > c.id && e.type === 'LOCK_HANDOFF' && e.tid === H.tid && e.data!.mutex === c.data!.mutex);
      const end = got ? got.t : s.tick;
      const medTicks = new Map<number, number>();
      for (let t = c.t + 1; t < end && t < ticks.length; t++) for (const core of ticks[t].cores) {
        if (core.kind !== 'run') continue;
        const M = s.threads[core.tid];
        if (M.tid !== L.tid && M.tid !== H.tid && M.basePriority > H.basePriority && M.basePriority < L.basePriority) medTicks.set(M.tid, (medTicks.get(M.tid) ?? 0) + 1);
      }
      if (!medTicks.size) continue;
      seen.add(H.tid);
      const meds = [...medTicks.keys()];
      const medDisp = meds.map(tid => events.find(e => e.type === 'DISPATCH' && e.tid === tid && e.t >= c.t && e.t < end));
      const held = [...events].reverse().find(e => e.id < c.id && e.tid === L.tid && (e.type === 'LOCK_ACQUIRE' || e.type === 'LOCK_HANDOFF') && e.data!.mutex === c.data!.mutex);
      const total = [...medTicks.values()].reduce((a, b) => a + b, 0);
      findings.push({
        id: `inversion:${H.tid}`, kind: 'priority-inversion', severity: 'warning',
        title: `Priority inversion: ${H.name} waited behind ${meds.map(name).join(', ')}`,
        detail: `${H.name} (priority ${H.basePriority}) blocked on ${c.data!.mutex} at t=${c.t}, held by ${L.name} (priority ${L.basePriority}). ` +
          `${meds.map(name).join(', ')} (priority ${meds.map(t => s.threads[t].basePriority).join(', ')}) then ran for ${plural(total, 'tick')}, keeping ${L.name} off the CPU, so the high-priority thread effectively waited on medium-priority work` +
          (got ? ` until t=${got.t}.` : '.'),
        evidence: sortIds([held?.id, c.id, ...medDisp.map(e => e?.id), got?.id]),
        tids: [H.tid, L.tid, ...meds], lines: lineList([held, c]),
        advice: s.config.inherit ? 'Inheritance is already on; check for chains of locks or a medium thread that also needs the lock.' : 'Priority inheritance lends the waiter’s priority to the lock holder until it releases the lock.',
        experiment: !s.config.inherit ? {
          id: `inversion:${H.tid}:inherit`, label: 'inherit=true',
          hypothesis: `With inheritance ${L.name} runs at ${H.name}'s priority while holding ${c.data!.mutex}, so ${H.name} no longer waits for medium-priority work.`,
          change: { kind: 'config', patch: { inherit: true } }, metrics: [`threadFinish:${H.tid}`, `threadBlocked:${H.tid}`]
        } : undefined
      });
    }
  }

  /* ---- context-switch overhead */
  if (s.config.cs > 0 && met.contextSwitches >= 5 && met.switchOverhead >= 0.15) {
    const sw = byType('SWITCH_START');
    const rr = s.config.scheduler === 'rr';
    const q = Math.min(1000, s.config.quantum * 3);
    findings.push({
      id: 'switch-overhead', kind: 'switch-overhead', severity: 'info',
      title: `${Math.round(met.switchOverhead * 100)}% of CPU time is spent context switching`,
      detail: `${plural(met.contextSwitches, 'context switch')} at ${s.config.cs} tick${s.config.cs > 1 ? 's' : ''} each` +
        (rr ? `, with a quantum of only ${s.config.quantum}. A switch costs ${Math.round((s.config.cs / s.config.quantum) * 100)}% of a time slice.` : '.'),
      evidence: sw.slice(0, 6).map(e => e.id), tids: [], lines: [],
      advice: rr ? 'A larger quantum amortises the switch cost; too large and RR degenerates into FCFS. Aim for most bursts finishing within one slice.' : 'Fewer preemptions mean fewer switches.',
      experiment: rr ? {
        id: 'switch-overhead:quantum', label: `quantum=${q}`,
        hypothesis: 'Fewer, longer slices spend less time switching and finish sooner.',
        change: { kind: 'config', patch: { quantum: q } }, metrics: ['switchOverhead', 'ticks', 'avgWaiting']
      } : undefined
    });
  }

  /* ---- lock contention */
  for (const mx of Object.values(s.mutexes)) {
    const cont = events.filter(e => e.type === 'LOCK_CONTEND' && e.data!.mutex === mx.name && e.data!.owner !== e.tid);
    if (cont.length < 4) continue;
    let waited = 0;
    for (const c of cont) {
      const got = events.find(e => e.id > c.id && e.type === 'LOCK_HANDOFF' && e.tid === c.tid && e.data!.mutex === mx.name);
      waited += (got ? got.t : s.tick) - c.t;
    }
    if (waited < Math.max(8, s.tick * 0.1)) continue;
    findings.push({
      id: `contention:${mx.name}`, kind: 'lock-contention', severity: 'info',
      title: `${mx.name} is contended`,
      detail: `${plural(cont.length, 'acquisition')} of ${mx.acquisitions + cont.length} had to wait, for ${plural(waited, 'tick')} in total. ` +
        `Threads involved: ${uniq(cont.map(e => name(e.tid!))).join(', ')}.`,
      evidence: cont.slice(0, 6).map(e => e.id), tids: uniq(cont.map(e => e.tid!)), lines: lineList(cont),
      advice: `Keep the critical section under ${mx.name} as short as possible (move work like \`compute\` outside it), or split the lock.`
    });
  }

  /* ---- run experiments (real re-executions) */
  if (opts.experiments !== false) {
    const withExp = findings.filter(f => f.experiment);
    if (withExp.length) {
      const base = m.finished && m.s.tick === m.ticks.length ? m : runToEnd(m.workload, inputs);
      for (const f of withExp) f.experiment!.result = runExperiment(base, inputs, f.experiment!);
    }
  }

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.evidence[0] ?? 0) - (b.evidence[0] ?? 0));

  const done = s.threads.filter(t => t.state === 'terminated').length;
  const headline = {
    done: `Finished at t=${s.tick}: ${done}/${s.threads.length} threads exited`,
    deadlock: `Deadlocked at t=${s.tick}`,
    stalled: `Stalled at t=${s.tick}: no thread can make progress`,
    'max-ticks': `Hit the tick limit at t=${s.tick}`,
    running: `Paused at t=${s.tick}`,
    ready: 'Not started'
  }[s.status] + (findings.length ? `; ${plural(findings.length, 'finding')}` : '; no problems found') + '.';

  return { status: s.status, ticks: s.tick, headline, findings, metrics: met };
}

/* ------------------------------------------------------- source edits */

const DSL_KEY: Record<string, string> = Object.fromEntries(Object.entries(CONFIG_KEYS).map(([dsl, spec]) => [spec.key, dsl]));

/**
 * Rewrite the `config` line(s) of a workload source so that it carries `patch`.
 * Existing keys are edited in place (the last occurrence wins, as in the parser);
 * new keys are appended to the first config line, or a config line is inserted.
 */
export function applyConfigPatch(source: string, patch: Partial<Config>): string {
  const lines = source.split('\n');
  const isConfig = (l: string) => /^\s*config(\s|$)/.test(l);
  const pending = new Map(Object.entries(patch).filter(([k]) => DSL_KEY[k]).map(([k, v]) => [DSL_KEY[k], String(v)]));
  for (let i = lines.length - 1; i >= 0 && pending.size; i--) {
    if (!isConfig(lines[i])) continue;
    for (const [k, v] of [...pending]) {
      const re = new RegExp(`(\\s)${k}=\\S+`, 'i');
      if (re.test(lines[i].split(/#|\/\//)[0])) { lines[i] = lines[i].replace(re, `$1${k}=${v}`); pending.delete(k); }
    }
  }
  if (pending.size) {
    const add = [...pending].map(([k, v]) => `${k}=${v}`).join(' ');
    const first = lines.findIndex(isConfig);
    if (first >= 0) {
      const m = /^(.*?)(\s*(#|\/\/).*)?$/.exec(lines[first])!;
      lines[first] = `${m[1].replace(/\s+$/, '')} ${add}${m[2] ?? ''}`;
    } else {
      let at = 0;
      while (at < lines.length && /^\s*(#|\/\/|$)/.test(lines[at])) at++;
      lines.splice(at, 0, `config ${add}`);
    }
  }
  return lines.join('\n');
}
