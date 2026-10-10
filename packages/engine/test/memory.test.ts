import { describe, it, expect } from 'vitest';
import { simulateRefString, faultCurve, computeMetrics } from '../src/index.js';
import { run, types } from './helpers.js';

const BELADY = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];

/** A single thread touching pages in order, with no TLB so only paging is measured. */
function refWorkload(refs: number[], frames: number, policy: string, pages = 16) {
  return `
config frames=${frames} replacement=${policy} tlb=0 pagesize=256 fault=3
process P pages=${pages}
${refs.map(r => `  load 0x${(r * 256 + 4).toString(16)}`).join('\n')}`;
}

function lcg(seed: number) { let x = seed >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

describe('reference-string lab (oracle)', () => {
  it('reproduces Belady’s anomaly for FIFO: 9 faults with 3 frames, 10 with 4', () => {
    expect(simulateRefString(BELADY, 3, 'fifo').faults).toBe(9);
    expect(simulateRefString(BELADY, 4, 'fifo').faults).toBe(10);
  });
  it('LRU and OPT are stack algorithms on the same string (no anomaly)', () => {
    expect(simulateRefString(BELADY, 3, 'lru').faults).toBe(10);
    expect(simulateRefString(BELADY, 4, 'lru').faults).toBe(8);
    expect(simulateRefString(BELADY, 3, 'opt').faults).toBe(7);
    expect(simulateRefString(BELADY, 4, 'opt').faults).toBe(6);
    const lru = faultCurve(BELADY, 6, 'lru');
    for (let i = 1; i < lru.length; i++) expect(lru[i]).toBeLessThanOrEqual(lru[i - 1]);
  });
  it('OPT never faults more than any other policy', () => {
    const rnd = lcg(7);
    for (let k = 0; k < 40; k++) {
      const refs = Array.from({ length: 30 }, () => Math.floor(rnd() * 7));
      for (const f of [2, 3, 4]) {
        const opt = simulateRefString(refs, f, 'opt').faults;
        for (const p of ['fifo', 'lru', 'clock'] as const) expect(opt).toBeLessThanOrEqual(simulateRefString(refs, f, p).faults);
      }
    }
  });
});

describe('kernel paging matches the oracle', () => {
  it('Belady string through the full kernel gives the same fault counts', () => {
    expect(types(run(refWorkload(BELADY, 3, 'fifo')), 'PAGE_FAULT')).toHaveLength(9);
    expect(types(run(refWorkload(BELADY, 4, 'fifo')), 'PAGE_FAULT')).toHaveLength(10);
    expect(types(run(refWorkload(BELADY, 3, 'lru')), 'PAGE_FAULT')).toHaveLength(10);
    expect(types(run(refWorkload(BELADY, 4, 'lru')), 'PAGE_FAULT')).toHaveLength(8);
  });

  it('agrees with the oracle on 300 generated reference strings (faults and victims)', () => {
    const rnd = lcg(42);
    let cases = 0;
    for (const policy of ['fifo', 'lru', 'clock'] as const) {
      for (let k = 0; k < 100; k++) {
        const len = 8 + Math.floor(rnd() * 30);
        const distinct = 3 + Math.floor(rnd() * 6);
        const frames = 1 + Math.floor(rnd() * 5);
        const refs = Array.from({ length: len }, () => Math.floor(rnd() * distinct));
        const oracle = simulateRefString(refs, frames, policy);
        const m = run(refWorkload(refs, frames, policy));
        const faults = types(m, 'PAGE_FAULT');
        expect(faults.length, `${policy} frames=${frames} refs=${refs.join(',')}`).toBe(oracle.faults);
        const victims = types(m, 'PAGE_EVICT').map(e => e.data!.vpn);
        const oracleVictims = oracle.steps.filter(s => s.victim !== null).map(s => s.victim);
        expect(victims, `${policy} victims for ${refs.join(',')}`).toEqual(oracleVictims);
        cases++;
      }
    }
    expect(cases).toBe(300);
  });
});

describe('page faults, write-back and segfaults', () => {
  it('blocks the faulting thread for the service time and lets others run meanwhile', () => {
    const m = run(`
config scheduler=fcfs frames=4 fault=5 tlb=0
process A
  load 0x0
  compute 1
process B
  compute 4`);
    const fault = types(m, 'PAGE_FAULT')[0];
    expect(fault.t).toBe(0);
    expect(fault.data!.delay).toBe(5);
    // A faults at t=0, blocked until t=6; B runs 1..5; A re-executes the load at 6 then computes
    const a = m.s.threads[0];
    expect(a.blockedTicks).toBe(5);
    expect(a.finish).toBe(8);
    expect(m.s.threads[1].finish).toBe(5);
  });

  it('writes back a dirty victim and charges the extra latency', () => {
    const m = run(`
config frames=1 fault=4 writeback=3 tlb=0 replacement=fifo
process P pages=4
  store 0x000
  load 0x100`);
    const evict = types(m, 'PAGE_EVICT');
    expect(evict).toHaveLength(1);
    expect(evict[0].data).toMatchObject({ vpn: 0, dirty: true });
    const second = types(m, 'PAGE_FAULT')[1];
    expect(second.data!.delay).toBe(7);
    expect(computeMetrics(m).writebacks).toBe(1);
  });

  it('a clean victim is dropped without write-back', () => {
    const m = run(`
config frames=1 fault=4 writeback=3 tlb=0
process P pages=4
  load 0x000
  load 0x100`);
    expect(types(m, 'PAGE_EVICT')[0].data!.dirty).toBe(false);
    expect(types(m, 'PAGE_FAULT')[1].data!.delay).toBe(4);
  });

  it('kills the process on an access outside its address space and frees its frames', () => {
    const m = run(`
config scheduler=rr quantum=2 frames=4 pagesize=256 tlb=0
process Bad pages=2
  load 0x000
  load 0x300
  compute 5
process Good
  compute 6`);
    const seg = types(m, 'SEGFAULT');
    expect(seg).toHaveLength(1);
    expect(seg[0].data).toMatchObject({ vpn: 3, pages: 2 });
    expect(m.s.threads[0].exitCode).toBe(139);
    expect(m.s.processes[0].state).toBe('terminated');
    expect(m.s.frames.every(f => f.pid !== 0)).toBe(true);
    expect(m.s.threads[1].exitCode).toBe(0);
    expect(m.s.status).toBe('done');
  });

  it('a second thread touching a page that is still loading waits for the same I/O instead of faulting again', () => {
    const m = run(`
config cores=2 frames=4 fault=5 tlb=0
process P
  thread a
    load 0x10
  thread b
    load 0x20`);
    expect(types(m, 'PAGE_FAULT')).toHaveLength(1);
    expect(m.s.threads.map(t => t.finish)).toEqual([7, 7]);
  });

  it('more frames never increase LRU faults on a looping working set', () => {
    const faults = [2, 3, 4, 5].map(f => types(run(refWorkload([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3], f, 'lru')), 'PAGE_FAULT').length);
    expect(faults).toEqual([12, 12, 4, 4]);
  });
});

describe('TLB', () => {
  it('misses, fills from the page table, then hits', () => {
    const m = run(`
config tlb=2 tlbpenalty=1 frames=4 fault=2
process P
  load 0x0
  load 0x4
  load 0x8`);
    const c = m.s.counters;
    // first access: miss + fault; retried: miss + fill; then two hits
    expect([c.tlbMisses, c.tlbHits]).toEqual([2, 2]);
    expect(computeMetrics(m).tlbHitRate).toBe(0.5);
  });

  it('flushes on a switch between address spaces but not between threads of one process', () => {
    const across = run(`
config scheduler=rr quantum=2 tlb=4 frames=8
process A
  load 0x0
  compute 3
  load 0x0
process B
  load 0x0
  compute 3
  load 0x0`);
    expect(types(across, 'TLB_FLUSH').length).toBeGreaterThan(0);
    const within = run(`
config scheduler=rr quantum=2 tlb=4 frames=8
process A
  thread x
    load 0x0
    compute 3
    load 0x0
  thread y
    load 0x0
    compute 3
    load 0x0`);
    expect(types(within, 'TLB_FLUSH')).toHaveLength(0);
  });

  it('shoots down TLB entries for an evicted page', () => {
    const m = run(`
config tlb=4 frames=1 fault=2 replacement=fifo
process P pages=4
  load 0x000
  load 0x100
  load 0x000`);
    expect(types(m, 'TLB_SHOOTDOWN').length).toBeGreaterThan(0);
  });
});
