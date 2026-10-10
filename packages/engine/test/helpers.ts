import { parseWorkload, runToEnd, computeMetrics, type Machine } from '../src/index.js';

export function load(src: string) {
  const { workload, diagnostics } = parseWorkload(src);
  if (!workload) throw new Error('parse failed:\n' + diagnostics.map(d => `${d.line}:${d.col} ${d.message}`).join('\n'));
  return workload;
}

export function run(src: string): Machine { return runToEnd(load(src)); }

export function byName(m: Machine) {
  const met = computeMetrics(m);
  return Object.fromEntries(met.threads.map(t => [t.name.split('.')[0], t]));
}

/** Gantt chart for core 0 as compact segments, e.g. "P1:0-4 P2:4-7". */
export function gantt(m: Machine, core = 0): string {
  const segs: string[] = [];
  let cur = '', start = 0;
  const label = (r: { tid: number; kind: string }) => (r.kind === 'run' ? m.s.threads[r.tid].name.split('.')[0] : r.kind === 'switch' ? 'cs' : 'idle');
  m.ticks.forEach((tk, i) => {
    const l = label(tk.cores[core]);
    if (l !== cur) { if (cur) segs.push(`${cur}:${start}-${i}`); cur = l; start = i; }
  });
  if (cur) segs.push(`${cur}:${start}-${m.ticks.length}`);
  return segs.join(' ');
}

export const types = (m: Machine, type: string) => m.events.filter(e => e.type === type);
