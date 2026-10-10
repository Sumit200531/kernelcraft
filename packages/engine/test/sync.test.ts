import { describe, it, expect } from 'vitest';
import { computeMetrics, Session } from '../src/index.js';
import { run, load, byName, types } from './helpers.js';

const counter = (body: string, extra = '') => `
config scheduler=rr quantum=2
shared counter=0
${extra}
process T1
  repeat 50
${body}
  end
process T2
  repeat 50
${body}
  end`;

describe('data races', () => {
  it('unsynchronized increments lose updates, and the trace accounts for every lost one', () => {
    const m = run(counter('    inc counter'));
    const v = computeMetrics(m).vars.find(x => x.name === 'counter')!;
    expect(v.expected).toBe(100);
    expect(v.value).toBeLessThan(100);
    // every lost increment is attributed to exactly one LOST_UPDATE event (the amounts telescope)
    const lost = types(m, 'LOST_UPDATE').reduce((a, e) => a + (e.data!.lost as number), 0);
    expect(lost).toBe(100 - v.value);
    expect(lost).toBeGreaterThan(0);
  });

  it('lockset detection reports the race once and cites the two conflicting accesses', () => {
    const m = run(counter('    inc counter'));
    const races = types(m, 'RACE');
    expect(races).toHaveLength(1);
    const [a, b] = races[0].data!.events as number[];
    const ea = m.events[a], eb = m.events[b];
    expect(['VAR_READ', 'VAR_WRITE']).toContain(ea.type);
    expect(['VAR_READ', 'VAR_WRITE']).toContain(eb.type);
    expect(ea.tid).not.toBe(eb.tid);
  });

  it('a mutex around the increment gives the exact result and no race', () => {
    const m = run(counter('    lock m\n    inc counter\n    unlock m', 'mutex m'));
    expect(m.s.vars.counter.value).toBe(100);
    expect(types(m, 'RACE')).toHaveLength(0);
    expect(types(m, 'LOST_UPDATE')).toHaveLength(0);
  });

  it('a binary semaphore protects the variable too', () => {
    const m = run(counter('    wait mx\n    inc counter\n    signal mx', 'sem mx=1'));
    expect(m.s.vars.counter.value).toBe(100);
    expect(types(m, 'RACE')).toHaveLength(0);
  });

  it('the lost-update accounting stays exact with four racing threads', () => {
    const src = `
config scheduler=rr quantum=2 cores=2
shared c=0
${[1, 2, 3, 4].map(i => `process T${i}\n  repeat 25\n    inc c\n  end`).join('\n')}`;
    const m = run(src);
    const lost = types(m, 'LOST_UPDATE').reduce((a, e) => a + (e.data!.lost as number), 0);
    expect(m.s.vars.c.value).toBeLessThan(100);
    expect(lost).toBe(100 - m.s.vars.c.value);
  });

  it('atomic increments are race-free', () => {
    const m = run(counter('    atomic_inc counter'));
    expect(m.s.vars.counter.value).toBe(100);
    expect(types(m, 'RACE')).toHaveLength(0);
  });

  it('a variable used by only one thread is never reported', () => {
    const m = run(`
config scheduler=rr quantum=1
shared x=0
process A
  repeat 5
    inc x
  end
process B
  compute 10`);
    expect(types(m, 'RACE')).toHaveLength(0);
    expect(m.s.vars.x.value).toBe(5);
  });
});

const ABBA = `
config scheduler=rr quantum=1
mutex a b
process T1
  lock a
  compute 2
  lock b
  compute 1
  unlock b
  unlock a
process T2
  lock b
  compute 2
  lock a
  compute 1
  unlock a
  unlock b`;

describe('mutexes and deadlock', () => {
  it('detects the ABBA deadlock as a cycle in the wait-for graph and halts', () => {
    const m = run(ABBA);
    expect(m.s.status).toBe('deadlock');
    const d = types(m, 'DEADLOCK');
    expect(d).toHaveLength(1);
    expect([...(d[0].data!.tids as number[])].sort()).toEqual([0, 1]);
    expect([...(d[0].data!.resources as string[])].sort()).toEqual(['a', 'b']);
    // T1 locks a @0, T2 locks b @1, both compute, T1 blocks on b @6, T2 blocks on a @7
    expect(d[0].t).toBe(8);
  });

  it('recovers when the operator kills one thread, and the recovery replays identically', () => {
    const s = new Session(load(ABBA));
    s.run();
    expect(s.machine.s.status).toBe('deadlock');
    s.inject({ type: 'kill', tid: 1 });
    s.run();
    const m = s.machine;
    expect(m.s.status).toBe('done');
    expect(m.s.threads[0].exitCode).toBe(0);
    expect(m.s.threads[1].exitCode).toBe(137);
    expect(types(m, 'LOCK_ABANDONED').length).toBeGreaterThan(0);
    const end = m.s.tick, events = m.visibleEvents().length;
    s.seek(0);
    expect(s.machine.s.tick).toBe(0);
    s.seek(end);
    expect(s.machine.s.status).toBe('done');
    expect(s.machine.visibleEvents().length).toBe(events);
  });

  it('finds a three-way cycle among dining philosophers', () => {
    const m = run(`
config scheduler=rr quantum=1
mutex f0 f1 f2
process P0
  lock f0
  compute 1
  lock f1
  unlock f1
  unlock f0
process P1
  lock f1
  compute 1
  lock f2
  unlock f2
  unlock f1
process P2
  lock f2
  compute 1
  lock f0
  unlock f0
  unlock f2`);
    const d = types(m, 'DEADLOCK');
    expect(d).toHaveLength(1);
    expect((d[0].data!.tids as number[]).length).toBe(3);
  });

  it('ordering locks consistently removes the deadlock', () => {
    const m = run(ABBA.replace(/  lock b\n  compute 2\n  lock a/, '  lock a\n  compute 2\n  lock b').replace(/  unlock a\n  unlock b$/, '  unlock b\n  unlock a'));
    expect(m.s.status).toBe('done');
    expect(types(m, 'DEADLOCK')).toHaveLength(0);
  });

  it('re-locking a held mutex is a self-deadlock', () => {
    const m = run(`
mutex a
process P
  lock a
  lock a`);
    expect(m.s.status).toBe('deadlock');
    expect(types(m, 'DEADLOCK')[0].data!.tids).toEqual([0]);
  });

  it('unlocking a mutex the thread does not own aborts the thread', () => {
    const m = run(`
mutex a
process P
  unlock a
  compute 3`);
    expect(types(m, 'UNLOCK_NOT_OWNER')).toHaveLength(1);
    expect(m.s.threads[0].exitCode).toBe(134);
  });

  it('hands a contended mutex to waiters in FIFO order', () => {
    const m = run(`
config scheduler=rr quantum=1
mutex a
process A
  lock a
  compute 4
  unlock a
process B
  lock a
  unlock a
process C
  lock a
  unlock a`);
    const order = [...types(m, 'LOCK_ACQUIRE'), ...types(m, 'LOCK_HANDOFF')].sort((x, y) => x.id - y.id).map(e => m.s.threads[e.tid!].name);
    expect(order).toEqual(['A.main', 'B.main', 'C.main']);
    expect(m.s.mutexes.a.contentions).toBe(2);
  });
});

describe('semaphores', () => {
  const pc = (consumerSignals: boolean) => `
config scheduler=rr quantum=2
mutex m
sem empty=2 full=0
process Producer
  repeat 4
    compute 1
    wait empty
    lock m
    compute 1
    unlock m
    signal full
  end
process Consumer
  repeat 4
    wait full
    lock m
    compute 1
    unlock m
${consumerSignals ? '    signal empty' : '    compute 1'}
  end`;

  it('a bounded buffer runs to completion and restores its semaphores', () => {
    const m = run(pc(true));
    expect(m.s.status).toBe('done');
    expect(m.s.sems.empty.value).toBe(2);
    expect(m.s.sems.full.value).toBe(0);
  });

  it('a consumer that never signals `empty` leaves the producer stuck: a stall, not a cycle', () => {
    const m = run(pc(false));
    expect(m.s.status).toBe('stalled');
    expect(types(m, 'STALL')).toHaveLength(1);
    expect(types(m, 'DEADLOCK')).toHaveLength(0);
    expect(m.s.threads[0].block).toMatchObject({ kind: 'sem', s: 'empty' });
  });

  it('the operator can rescue a stall by signalling the semaphore', () => {
    const s = new Session(load(pc(false)));
    s.run();
    s.inject({ type: 'signal', s: 'empty' });
    s.inject({ type: 'signal', s: 'empty' });
    s.run();
    expect(s.machine.s.status).toBe('done');
  });
});

describe('priority inversion', () => {
  const inv = (inherit: boolean) => `
config scheduler=priority preempt=true inherit=${inherit}
mutex r
process Low priority=9
  lock r
  compute 4
  unlock r
process High priority=1 arrive=1
  lock r
  compute 1
  unlock r
process Med priority=5 arrive=2
  compute 10`;

  it('without inheritance the medium thread delays the high-priority one (High finishes at 19)', () => {
    const t = byName(run(inv(false)));
    expect(t.High.finish).toBe(19);
    expect(t.Med.finish).toBe(12);
  });

  it('priority inheritance lets the lock holder finish first (High finishes at 9)', () => {
    const m = run(inv(true));
    const t = byName(m);
    expect(t.High.finish).toBe(9);
    expect(t.Low.finish).toBe(7);
    expect(t.Med.finish).toBe(19);
    expect(types(m, 'PRIORITY_INHERIT')).toHaveLength(1);
    expect(types(m, 'PRIORITY_RESTORE')).toHaveLength(1);
  });
});
