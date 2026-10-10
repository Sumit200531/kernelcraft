import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SAMPLES, getSample, parseWorkload, runToEnd, analyze, applyConfigPatch, explainEvent, answerQuestion, validateCitations, computeMetrics, Session, traceHash
} from '../src/index.js';

const runSample = (id: string) => runToEnd(parseWorkload(getSample(id)!.source).workload!);
const kinds = (id: string) => analyze(runSample(id), { experiments: false }).findings.map(f => f.kind);

describe('sample workloads', () => {
  it('every sample parses without errors and has a unique id', () => {
    expect(new Set(SAMPLES.map(s => s.id)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) {
      const { workload, diagnostics } = parseWorkload(s.source);
      expect(workload, s.id).not.toBeNull();
      expect(diagnostics.filter(d => d.severity === 'error'), s.id).toEqual([]);
    }
  });

  it('the files in samples/ are identical to the built-in samples', () => {
    for (const s of SAMPLES) expect(readFileSync(new URL(`../../../samples/${s.id}.kc`, import.meta.url), 'utf8'), s.id).toBe(s.source);
  });

  it('each sample shows the behaviour it is named for', () => {
    expect(runSample('web-stack').s.status).toBe('done');
    expect(kinds('web-stack')).toEqual([]);
    expect(kinds('convoy')).toEqual(['convoy']);
    expect(kinds('round-robin')).toEqual(['switch-overhead']);
    const race = runSample('race-counter');
    expect(race.s.vars.counter.value).toBeLessThan(80);
    expect(kinds('race-counter')).toEqual(['race']);
    expect(runSample('deadlock-abba').s.status).toBe('deadlock');
    expect(runSample('philosophers').s.deadlock!.tids).toHaveLength(5);
    expect(kinds('thrashing')).toEqual(['thrashing']);
    expect(kinds('priority-inversion')).toEqual(['priority-inversion']);
    expect(runSample('producer-consumer').s.status).toBe('stalled');
    expect(kinds('starvation')).toEqual(['starvation']);
    expect(kinds('segfault')).toEqual(['segfault']);
  });
});

describe('analyzer findings cite real evidence', () => {
  it('every cited event exists and is relevant to the finding', () => {
    for (const s of SAMPLES) {
      const m = runToEnd(parseWorkload(s.source).workload!);
      for (const f of analyze(m, { experiments: false }).findings) {
        expect(f.evidence.length, `${s.id}/${f.id}`).toBeGreaterThan(0);
        for (const id of f.evidence) expect(m.events[id], `${s.id}/${f.id} cites #${id}`).toBeDefined();
        expect([...f.evidence]).toEqual([...f.evidence].sort((a, b) => a - b));
      }
    }
  });

  it('the deadlock finding cites the DEADLOCK event and each thread’s blocking lock request', () => {
    const m = runSample('deadlock-abba');
    const f = analyze(m, { experiments: false }).findings[0];
    const types = f.evidence.map(id => m.events[id].type);
    expect(types).toContain('DEADLOCK');
    expect(types.filter(t => t === 'LOCK_CONTEND')).toHaveLength(2);
    expect(types.filter(t => t === 'LOCK_ACQUIRE')).toHaveLength(2);
    expect(f.detail).toContain('transfer1.main takes acctA → acctB');
    expect(f.detail).toContain('transfer2.main takes acctB → acctA');
  });

  it('the race finding reports exactly the updates the variable lost', () => {
    const m = runSample('race-counter');
    const f = analyze(m, { experiments: false }).findings[0];
    const v = computeMetrics(m).vars[0];
    expect(f.title).toContain(`${v.expected - v.value} updates lost`);
  });
});

describe('what-if experiments are real re-runs', () => {
  const exp = (id: string) => analyze(runSample(id)).findings.find(f => f.experiment)!.experiment!;

  it('SJF fixes the convoy (3.75 vs 20.25 average wait, the textbook numbers)', () => {
    const e = exp('convoy');
    expect(e.change).toEqual({ kind: 'config', patch: { scheduler: 'sjf' } });
    expect(e.result!.deltas[0]).toMatchObject({ key: 'avgWaiting', before: 20.25, after: 3.75 });
    expect(e.result!.improved).toBe(true);
  });

  it('atomic increments recover every lost update', () => {
    const r = exp('race-counter').result!;
    expect(r.deltas[0].before).toBeGreaterThan(0);
    expect(r.deltas[0].after).toBe(0);
  });

  it('killing one thread resolves the deadlock; the result matches a recorded session', () => {
    const e = exp('deadlock-abba');
    expect(e.result!.statusBefore).toBe('deadlock');
    expect(e.result!.statusAfter).toBe('done');
    // the same recovery performed interactively produces an identical trace
    const s = new Session(parseWorkload(getSample('deadlock-abba')!.source).workload!);
    s.run();
    if (e.change.kind !== 'inject') throw new Error('expected an injection');
    s.inject(e.change.action);
    s.run();
    expect(traceHash(s.machine)).toBe(e.result!.hashAfter);
  });

  it('more frames stop thrashing; inheritance fixes the inversion; aging feeds the starving thread', () => {
    const t = exp('thrashing').result!;
    expect(t.deltas[0].after!).toBeLessThan(t.deltas[0].before! / 2);
    const inv = exp('priority-inversion');
    expect(inv.change).toEqual({ kind: 'config', patch: { inherit: true } });
    expect(inv.result!.deltas[0].after!).toBeLessThan(inv.result!.deltas[0].before!);
    const st = exp('starvation').result!;
    expect(st.deltas[0].key).toMatch(/^threadResponse:/);
    expect(st.deltas[0].after!).toBeLessThan(st.deltas[0].before!);
  });

  it('a larger quantum reduces switch overhead; signalling the stalled semaphore lets work continue', () => {
    expect(exp('round-robin').result!.improved).toBe(true);
    const pc = exp('producer-consumer');
    expect(pc.change).toMatchObject({ kind: 'inject', action: { type: 'signal', s: 'empty' } });
    expect(pc.result!.improved).toBe(true);
  });

  it('the patched source reproduces the experiment exactly', () => {
    const src = getSample('priority-inversion')!.source;
    const e = exp('priority-inversion');
    if (e.change.kind !== 'config') throw new Error('expected config');
    const patched = runToEnd(parseWorkload(applyConfigPatch(src, e.change.patch)).workload!);
    expect(traceHash(patched)).toBe(e.result!.hashAfter);
  });
});

describe('applyConfigPatch', () => {
  it('edits existing keys in place and preserves comments', () => {
    expect(applyConfigPatch('config scheduler=fcfs quantum=2  # note\nprocess A\n  compute 1', { scheduler: 'rr', quantum: 6 }))
      .toBe('config scheduler=rr quantum=6  # note\nprocess A\n  compute 1');
  });
  it('appends new keys to the first config line, using DSL key names', () => {
    expect(applyConfigPatch('config cores=2 # two\nprocess A\n  compute 1', { maxTicks: 900, pageSize: 512 }))
      .toBe('config cores=2 maxticks=900 pagesize=512 # two\nprocess A\n  compute 1');
  });
  it('inserts a config line after leading comments when there is none', () => {
    expect(applyConfigPatch('# hi\nprocess A\n  compute 1', { frames: 16 })).toBe('# hi\nconfig frames=16\nprocess A\n  compute 1');
  });
  it('the last occurrence wins, as in the parser', () => {
    const out = applyConfigPatch('config quantum=2\nconfig quantum=3\nprocess A\n  compute 1', { quantum: 9 });
    expect(out).toBe('config quantum=2\nconfig quantum=9\nprocess A\n  compute 1');
    expect(parseWorkload(out).workload!.config.quantum).toBe(9);
  });
});

describe('assistant', () => {
  it('explains a page fault with its victim and refault history', () => {
    const m = runSample('thrashing');
    const refault = m.visibleEvents().find(e => e.type === 'PAGE_FAULT' && m.visibleEvents().some(x => x.type === 'PAGE_EVICT' && x.id < e.id && x.data!.pid === e.pid && x.data!.vpn === e.data!.vpn))!;
    const ex = explainEvent(m, refault.id)!;
    expect(ex.text).toContain('refault');
    expect(ex.text).toContain('LRU');
    expect(ex.citations.length).toBeGreaterThan(0);
    expect(validateCitations(m, ex.text).ok).toBe(true);
    const cold = explainEvent(m, m.visibleEvents().find(e => e.type === 'PAGE_FAULT')!.id)!;
    expect(cold.text).toContain('cold miss');
  });

  it('explains a lost update by citing the stale read and the intervening writes', () => {
    const m = runSample('race-counter');
    const lu = m.visibleEvents().find(e => e.type === 'LOST_UPDATE')!;
    const ex = explainEvent(m, lu.id)!;
    expect(ex.citations).toContain(lu.data!.readEvent as number);
    expect(ex.citations.some(id => m.events[id].type === 'VAR_WRITE' && m.events[id].tid !== lu.tid)).toBe(true);
  });

  it('routes questions to the right evidence and only cites events that exist', () => {
    const cases: [string, string, string][] = [
      ['deadlock-abba', 'why is it stuck?', 'deadlock'],
      ['race-counter', 'why is the counter wrong', 'race'],
      ['thrashing', 'why so many page faults?', 'memory'],
      ['priority-inversion', 'why is control.main late?', 'thread'],
      ['convoy', 'why is the average waiting time so high', 'scheduling'],
      ['convoy', 'what happened at t=24', 'tick'],
      ['convoy', 'explain #3', 'event'],
      ['round-robin', 'what should I try?', 'experiments'],
      ['web-stack', 'summary please', 'summary']
    ];
    for (const [id, q, intent] of cases) {
      const m = runSample(id);
      const a = answerQuestion(m, q);
      expect(a.intent, `${id}: ${q}`).toBe(intent);
      expect(a.text.length).toBeGreaterThan(20);
      expect(validateCitations(m, a.text).ok, `${id}: ${q}`).toBe(true);
    }
  });

  it('answers about a thread include its findings and their measured experiments', () => {
    const a = answerQuestion(runSample('priority-inversion'), 'why is control late');
    expect(a.findings).toContain('inversion:1');
    expect(a.experiments[0].result!.summary).toMatch(/^Confirmed/);
  });

  it('rejects citations of events that do not exist', () => {
    const m = runSample('convoy');
    expect(validateCitations(m, 'see [#3] and [#99999]')).toEqual({ ok: false, unknown: [99999] });
  });
});
