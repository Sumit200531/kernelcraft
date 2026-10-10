import type { Machine } from './kernel.js';

export interface ThreadMetrics {
  tid: number; name: string; pid: number; state: string;
  arrive: number; firstRun: number; finish: number;
  turnaround: number | null;   // finish − arrive
  response: number | null;     // first dispatch − arrive
  waiting: number;             // ticks READY (including dispatch latency / context switch)
  cpu: number; blocked: number; faults: number; exitCode: number; priority: number;
}

export interface SystemMetrics {
  ticks: number;
  completed: number;
  threads: ThreadMetrics[];
  avgWaiting: number | null;
  avgTurnaround: number | null;
  avgResponse: number | null;
  throughput: number;          // completed threads per 100 ticks
  cpuUtilization: number[];    // per core, 0..1 (switch ticks are overhead, not useful work)
  switchOverhead: number;      // fraction of core time spent switching
  contextSwitches: number;
  preemptions: number;
  memAccesses: number;
  pageFaults: number;
  faultRate: number | null;    // faults per memory reference (0..1)
  tlbHitRate: number | null;
  evictions: number;
  writebacks: number;
  vars: { name: string; value: number; expected: number; initial: number; lost: number }[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeMetrics(m: Machine): SystemMetrics {
  const s = m.s;
  const ticks = s.tick;
  const threads: ThreadMetrics[] = s.threads.map(th => ({
    tid: th.tid, name: th.name, pid: th.pid, state: th.state,
    arrive: th.arrive, firstRun: th.firstRun, finish: th.finish,
    turnaround: th.finish >= 0 ? th.finish - th.arrive : null,
    response: th.firstRun >= 0 ? th.firstRun - th.arrive : null,
    waiting: th.readyTicks + th.switchTicks,
    cpu: th.cpuTicks, blocked: th.blockedTicks, faults: th.faults, exitCode: th.exitCode, priority: th.basePriority
  }));
  const done = threads.filter(t => t.finish >= 0 && t.exitCode === 0);
  const c = s.counters;
  const totalCore = Math.max(1, ticks) * s.cores.length;
  return {
    ticks,
    completed: done.length,
    threads,
    avgWaiting: avg(done.map(t => t.waiting)),
    avgTurnaround: avg(done.map(t => t.turnaround!)),
    avgResponse: avg(threads.filter(t => t.response !== null).map(t => t.response!)),
    throughput: ticks ? (done.length / ticks) * 100 : 0,
    cpuUtilization: s.cores.map(core => (ticks ? core.busyTicks / ticks : 0)),
    switchOverhead: s.cores.reduce((a, core) => a + core.switchTicks, 0) / totalCore,
    contextSwitches: c.contextSwitches,
    preemptions: c.preemptions,
    memAccesses: c.memAccesses,
    pageFaults: c.faults,
    // references = completed accesses + accesses still waiting on their own page fault
    faultRate: (() => { const refs = c.memAccesses + s.threads.filter(th => th.state === 'blocked' && th.block?.kind === 'fault').length; return refs ? Math.min(1, c.faults / refs) : null; })(),
    tlbHitRate: c.tlbHits + c.tlbMisses ? c.tlbHits / (c.tlbHits + c.tlbMisses) : null,
    evictions: c.evictions,
    writebacks: c.writebacks,
    vars: Object.values(s.vars).map(v => ({ name: v.name, value: v.value, initial: v.initial, expected: v.initial + v.expectedDelta, lost: Math.abs(v.initial + v.expectedDelta - v.value) }))
  };
}
