import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../src/index.js';
import { run, byName, gantt, types } from './helpers.js';

// Expected values below are the worked examples from Silberschatz, Galvin & Gagne,
// "Operating System Concepts", ch. 5 — computed by hand, independently of this engine.

const threeJobs = (cfg: string) => `
config ${cfg}
process P1
  compute 24
process P2
  compute 3
process P3
  compute 3
`;

describe('FCFS', () => {
  it('runs jobs in arrival order (waiting 0, 24, 27; average 17)', () => {
    const m = run(threeJobs('scheduler=fcfs'));
    const t = byName(m);
    expect(gantt(m)).toBe('P1:0-24 P2:24-27 P3:27-30');
    expect([t.P1.waiting, t.P2.waiting, t.P3.waiting]).toEqual([0, 24, 27]);
    expect([t.P1.turnaround, t.P2.turnaround, t.P3.turnaround]).toEqual([24, 27, 30]);
    expect(computeMetrics(m).avgWaiting).toBe(17);
    expect(m.s.status).toBe('done');
  });

  it('shows the convoy effect: short jobs first cuts the average wait to 3', () => {
    const m = run(`
config scheduler=fcfs
process P2
  compute 3
process P3
  compute 3
process P1
  compute 24`);
    expect(computeMetrics(m).avgWaiting).toBe(3);
  });
});

describe('Round robin', () => {
  it('q=4 matches the textbook schedule (waiting 6, 4, 7)', () => {
    const m = run(threeJobs('scheduler=rr quantum=4'));
    const t = byName(m);
    expect(gantt(m)).toBe('P1:0-4 P2:4-7 P3:7-10 P1:10-30');
    expect([t.P1.waiting, t.P2.waiting, t.P3.waiting]).toEqual([6, 4, 7]);
    expect(computeMetrics(m).avgWaiting).toBeCloseTo(17 / 3, 10);
  });

  it('keeps running the same thread without a switch when nobody else is ready', () => {
    const m = run(`
config scheduler=rr quantum=2
process A
  compute 7`);
    expect(gantt(m)).toBe('A:0-7');
    expect(computeMetrics(m).contextSwitches).toBe(0);
    expect(types(m, 'PREEMPT')).toHaveLength(0);
  });

  it('places a new arrival ahead of the thread whose quantum just expired', () => {
    const m = run(`
config scheduler=rr quantum=2
process A
  compute 4
process B arrive=2
  compute 2`);
    // at t=2 B arrives and A's quantum expires in the same instant: B goes first
    expect(gantt(m)).toBe('A:0-2 B:2-4 A:4-6');
  });

  it('charges context-switch cost and counts it as waiting time', () => {
    const m = run(`
config scheduler=rr quantum=2 cs=1
process A
  compute 3
process B
  compute 3`);
    expect(gantt(m)).toBe('A:0-2 cs:2-3 B:3-5 cs:5-6 A:6-7 cs:7-8 B:8-9');
    const t = byName(m);
    expect([t.A.finish, t.B.finish]).toEqual([7, 9]);
    expect([t.A.waiting, t.B.waiting]).toEqual([4, 6]); // = turnaround − cpu
    const met = computeMetrics(m);
    expect(met.contextSwitches).toBe(3);
    expect(met.switchOverhead).toBeCloseTo(3 / 9, 10);
  });
});

describe('SJF and SRTF', () => {
  it('SJF orders by burst length (waiting 3, 16, 9, 0; average 7)', () => {
    const m = run(`
config scheduler=sjf
process P1
  compute 6
process P2
  compute 8
process P3
  compute 7
process P4
  compute 3`);
    const t = byName(m);
    expect(gantt(m)).toBe('P4:0-3 P1:3-9 P3:9-16 P2:16-24');
    expect([t.P1.waiting, t.P2.waiting, t.P3.waiting, t.P4.waiting]).toEqual([3, 16, 9, 0]);
    expect(computeMetrics(m).avgWaiting).toBe(7);
  });

  it('SRTF preempts for a shorter remaining time (average wait 6.5)', () => {
    const m = run(`
config scheduler=srtf
process P1 arrive=0
  compute 8
process P2 arrive=1
  compute 4
process P3 arrive=2
  compute 9
process P4 arrive=3
  compute 5`);
    const t = byName(m);
    expect(gantt(m)).toBe('P1:0-1 P2:1-5 P4:5-10 P1:10-17 P3:17-26');
    expect([t.P1.waiting, t.P2.waiting, t.P3.waiting, t.P4.waiting]).toEqual([9, 0, 15, 2]);
    expect(computeMetrics(m).avgWaiting).toBe(6.5);
  });

  it('SJF is non-preemptive: a shorter arrival waits for the running job', () => {
    const m = run(`
config scheduler=sjf
process Long
  compute 6
process Short arrive=1
  compute 1`);
    expect(gantt(m)).toBe('Long:0-6 Short:6-7');
  });

  it('only counts the CPU burst up to the next blocking syscall', () => {
    const m = run(`
config scheduler=sjf
process A
  compute 2
  syscall io 20
  compute 50
process B
  compute 5`);
    // A's next burst is 2 (+1 syscall tick) < 5, so A runs first despite 52 total ticks of work
    expect(gantt(m).startsWith('A:0-3 B:3-8')).toBe(true);
  });
});

describe('Priority', () => {
  it('non-preemptive priority matches the textbook (average wait 8.2)', () => {
    const m = run(`
config scheduler=priority
process P1 priority=3
  compute 10
process P2 priority=1
  compute 1
process P3 priority=4
  compute 2
process P4 priority=5
  compute 1
process P5 priority=2
  compute 5`);
    const t = byName(m);
    expect(gantt(m)).toBe('P2:0-1 P5:1-6 P1:6-16 P3:16-18 P4:18-19');
    expect([t.P1.waiting, t.P2.waiting, t.P3.waiting, t.P4.waiting, t.P5.waiting]).toEqual([6, 0, 16, 18, 1]);
    expect(computeMetrics(m).avgWaiting).toBeCloseTo(8.2, 10);
  });

  it('preemptive priority switches to a higher-priority arrival immediately', () => {
    const m = run(`
config scheduler=priority preempt=true
process Low priority=3
  compute 5
process High priority=1 arrive=1
  compute 3`);
    expect(gantt(m)).toBe('Low:0-1 High:1-4 Low:4-8');
    expect(types(m, 'PREEMPT')).toHaveLength(1);
  });

  it('aging lets a starving low-priority thread run, and starvation is reported without it', () => {
    const src = (aging: number) => `
config scheduler=priority preempt=true aging=${aging} starve=15
process Low priority=8
  compute 3
${Array.from({ length: 8 }, (_, i) => `process H${i} priority=2 arrive=${i * 4}\n  compute 4`).join('\n')}`;
    const starved = run(src(0));
    expect(types(starved, 'STARVATION').map(e => e.tid)).toContain(0);
    expect(byName(starved).Low.finish).toBe(35);
    const aged = run(src(3));
    expect(types(aged, 'AGING').length).toBeGreaterThan(0);
    expect(byName(aged).Low.finish).toBeLessThan(35);
  });
});

describe('Multi-core', () => {
  it('runs two CPU-bound threads in parallel on two cores', () => {
    const m = run(`
config scheduler=fcfs cores=2
process A
  compute 10
process B
  compute 10`);
    const t = byName(m);
    expect([t.A.finish, t.B.finish]).toEqual([10, 10]);
    expect(gantt(m, 0)).toBe('A:0-10');
    expect(gantt(m, 1)).toBe('B:0-10');
    expect(computeMetrics(m).cpuUtilization).toEqual([1, 1]);
  });
});

describe('Blocking I/O', () => {
  it('overlaps one thread’s I/O with another thread’s computation', () => {
    const m = run(`
config scheduler=fcfs
process IO
  compute 1
  syscall io 5
  compute 1
process CPU
  compute 6`);
    // IO: 1 compute + 1 syscall tick, blocked t=2..6, ready at 7 (CPU runs 2..8), finishes at 9
    expect(gantt(m)).toBe('IO:0-2 CPU:2-8 IO:8-9');
    const t = byName(m);
    expect(t.IO.blocked).toBe(5);
    expect(types(m, 'SYSCALL_ENTER')).toHaveLength(1);
    expect(types(m, 'SYSCALL_EXIT')).toHaveLength(1);
  });
});
