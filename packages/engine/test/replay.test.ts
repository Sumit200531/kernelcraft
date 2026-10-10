import { describe, it, expect } from 'vitest';
import { Machine, Session, traceHash, runToEnd, parseWorkload } from '../src/index.js';
import { load } from './helpers.js';

const MIXED = `
config scheduler=rr quantum=3 cs=1 frames=4 replacement=clock tlb=2 cores=2
mutex m
shared hits=0
process web pages=8 priority=2
  thread a
    repeat 6
      load 0x000
      compute 2
      store 0x340
      lock m
      inc hits
      unlock m
      syscall io 3
    end
  thread b arrive=2
    repeat 5
      load 0x120
      inc hits
      compute 3
    end
process batch pages=6 arrive=1
  repeat 4
    load 0x000
    load 0x100
    load 0x200
    load 0x300
    load 0x400
    compute 2
  end`;

describe('determinism', () => {
  it('the same workload always produces the same trace', () => {
    const a = runToEnd(load(MIXED)), b = runToEnd(load(MIXED));
    expect(traceHash(a)).toBe(traceHash(b));
    expect(a.events.length).toBe(b.events.length);
    expect(a.s.status).toBe('done');
  });

  it('a different config produces a different trace', () => {
    expect(traceHash(runToEnd(load(MIXED)))).not.toBe(traceHash(runToEnd(load(MIXED.replace('quantum=3', 'quantum=4')))));
  });
});

describe('replay', () => {
  it('seeking to any tick reproduces exactly the state of a straight run', () => {
    const straight = new Machine(load(MIXED));
    const states: string[] = [];
    while (!straight.finished) { states.push(JSON.stringify(straight.s)); straight.step(); }
    states.push(JSON.stringify(straight.s));

    const s = new Session(load(MIXED), 16);
    s.run();
    const end = s.machine.s.tick;
    // scrub backwards, forwards and randomly
    const order = [end, 0, 7, 3, 40, 39, 41, 16, 15, 17, end - 1, 1, Math.floor(end / 2)];
    for (const t of order) {
      s.seek(t);
      expect(s.machine.s.tick).toBe(t);
      expect(JSON.stringify(s.machine.s), `state at t=${t}`).toBe(states[t]);
      expect(s.machine.visibleEvents().length).toBe(JSON.parse(states[t]).eventCount);
      expect(s.machine.visibleEvents().every((e, i) => e && e.id === i)).toBe(true);
    }
  });

  it('records operator injections and replays them deterministically', () => {
    const s = new Session(load(MIXED));
    s.seek(20, true);
    s.inject({ type: 'kill', tid: 1 });
    s.run();
    const live = traceHash(s.machine);
    expect(s.machine.s.threads[1].exitCode).toBe(137);
    s.seek(0); s.seek(s.horizon);
    expect(traceHash(s.machine)).toBe(live);
    expect(traceHash(runToEnd(load(MIXED), s.inputs))).toBe(live);
  });

  it('injecting in the past discards the old future (branching)', () => {
    const s = new Session(load(MIXED));
    s.run();
    const fullEnd = s.horizon;
    s.seek(10);
    s.inject({ type: 'kill', tid: 2 });
    expect(s.horizon).toBe(10);
    s.run();
    expect(s.machine.s.threads[2].exitCode).toBe(137);
    expect(s.horizon).not.toBe(fullEnd);
  });
});

describe('parser diagnostics', () => {
  it('reports errors with line and column', () => {
    const { workload, diagnostics } = parseWorkload(`config scheduler=lottery quantum=0
process A
  compute
  lock nope
  frobnicate 3
process A`);
    expect(workload).toBeNull();
    const msgs = diagnostics.map(d => `${d.line}:${d.col} ${d.message}`);
    expect(msgs.some(m => m.startsWith('1:8') && m.includes('scheduler must be one of'))).toBe(true);
    expect(msgs.some(m => m.startsWith('1:26') && m.includes('quantum must be between 1 and 1000'))).toBe(true);
    expect(msgs.some(m => m.startsWith('3:') && m.includes('compute'))).toBe(true);
    expect(msgs.some(m => m.startsWith('4:') && m.includes('Unknown mutex `nope`'))).toBe(true);
    expect(msgs.some(m => m.startsWith('5:') && m.includes('Unknown instruction `frobnicate`'))).toBe(true);
    expect(msgs.some(m => m.startsWith('6:') && m.includes('already declared'))).toBe(true);
  });

  it('expands nested repeat blocks and keeps source line numbers on every micro-op', () => {
    const { workload } = parseWorkload(`
shared x=0
process A
  repeat 2
    repeat 3
      compute 1
    end
    inc x
  end`);
    const ops = workload!.processes[0].threads[0].ops;
    expect(ops.map(o => o.k).join(',')).toBe('compute,compute,compute,ldv,add,stv,compute,compute,compute,ldv,add,stv');
    expect(ops[3].line).toBe(8);
  });

  it('warns (but still runs) when an address is outside the process', () => {
    const { workload, diagnostics } = parseWorkload(`process A pages=1\n  load 0x1000`);
    expect(workload).not.toBeNull();
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('SEGFAULT');
  });

  it('rejects runaway expansions', () => {
    const { workload, diagnostics } = parseWorkload(`process A\n  repeat 10000\n    repeat 10000\n      compute 1\n    end\n  end`);
    expect(workload).toBeNull();
    expect(diagnostics[0].message).toContain('more than 20000 instructions');
  });
});
