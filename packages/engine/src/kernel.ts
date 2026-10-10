import type {
  BlockReason, CoreRT, EventType, InjectAction, MachineState, Op, PTE, SimEvent, ThreadRT, TickRecord, Workload
} from './types.js';

/**
 * The simulated machine.
 *
 * Every tick runs the same fixed phases (documented in docs/ENGINE.md):
 *   1. injections (operator actions recorded for replay)
 *   2. arrivals          (declaration order)
 *   3. timed wake-ups    (I/O, sleep, page-in; ascending tid)
 *   4. round-robin quantum expiry (preempted thread goes behind arrivals)
 *   5. preemption checks (SRTF, preemptive priority)
 *   6. dispatch to idle cores (core order; policy key, then FIFO order)
 *   7. execute one tick on every core (core order)
 *   8. accounting, aging, starvation, deadlock / stall / completion checks
 *
 * No randomness is used anywhere, so a workload always produces the same trace.
 */
export class Machine {
  s: MachineState;
  readonly workload: Workload;
  readonly ops: Op[][];
  events: SimEvent[] = [];
  ticks: TickRecord[] = [];

  constructor(workload: Workload) {
    this.workload = workload;
    const cfg = workload.config;
    const threads: ThreadRT[] = [];
    const ops: Op[][] = [];
    workload.processes.forEach((p, pid) => {
      p.threads.forEach(t => {
        const tid = threads.length;
        ops.push(t.ops);
        threads.push({
          tid, pid, name: `${p.name}.${t.name}`, state: 'new', basePriority: t.priority, effPriority: t.priority, agingBoost: 0, pendingDelta: 0,
          arrive: t.arrive, pc: 0, opRem: -1, opPhase: 0, block: null, core: -1, quantumUsed: 0, enqSeq: 0, readySince: -1,
          starvationWarned: false, reg: 0, loadedVersion: -1, loadedEvent: -1, held: [],
          firstRun: -1, finish: -1, exitCode: 0, cpuTicks: 0, readyTicks: 0, blockedTicks: 0, switchTicks: 0, faults: 0
        });
      });
    });
    this.ops = ops;
    const mutexes: MachineState['mutexes'] = {};
    for (const m of workload.mutexes) mutexes[m] = { name: m, owner: -1, waiters: [], acquisitions: 0, contentions: 0 };
    const sems: MachineState['sems'] = {};
    for (const [k, v] of Object.entries(workload.semaphores)) sems[k] = { name: k, value: v, initial: v, waiters: [] };
    const vars: MachineState['vars'] = {};
    for (const [k, v] of Object.entries(workload.shared)) vars[k] = {
      name: k, value: v, initial: v, version: 0, lsState: 'virgin', lsOwner: -1, lockset: null, lastAccess: null, raceReported: false, increments: 0, expectedDelta: 0
    };
    this.s = {
      tick: 0, status: 'ready', config: { ...cfg }, threads,
      processes: workload.processes.map((p, pid) => ({
        pid, name: p.name, pages: p.pages, state: 'new', exitCode: 0, finish: -1,
        pageTable: Array.from({ length: p.pages }, () => ({ present: false, frame: -1, dirty: false, ref: false, loadedAt: -1, lastUse: -1, loading: false, readyAt: -1 }))
      })),
      cores: Array.from({ length: cfg.cores }, (_, id) => ({ id, running: -1, switching: null, lastTid: -1, lastPid: -1, tlb: [], busyTicks: 0, switchTicks: 0, idleTicks: 0 })),
      frames: Array.from({ length: cfg.frames }, () => ({ pid: -1, vpn: -1, loading: false })),
      clockHand: 0, ready: [], mutexes, sems, vars, seq: 0, nextEvent: 0, eventCount: 0, deadlock: null, pendingInjections: [],
      counters: { contextSwitches: 0, faults: 0, tlbHits: 0, tlbMisses: 0, evictions: 0, writebacks: 0, memAccesses: 0, preemptions: 0 }
    };
  }

  /* --------------------------------------------------------- snapshots */
  snapshot(): Snapshot { return { state: structuredClone(this.s), events: this.s.nextEvent, ticks: this.s.tick }; }
  /**
   * Restore machine state. The event log and timeline are indexed by event id and tick, so they
   * are kept: re-executing from here rewrites identical entries. Only `truncate()` discards them.
   */
  restore(snap: Snapshot) { this.s = structuredClone(snap.state); }
  /** Drop log entries beyond the current point (used when the operator branches the timeline). */
  truncate() { this.events.length = this.s.nextEvent; this.ticks.length = this.s.tick; }
  /** Events up to the current tick (the log may extend further after seeking backwards). */
  visibleEvents(): SimEvent[] { return this.events.slice(0, this.s.nextEvent); }
  visibleTicks(): TickRecord[] { return this.ticks.slice(0, this.s.tick); }

  get finished(): boolean { return this.s.status === 'done' || this.s.status === 'deadlock' || this.s.status === 'stalled' || this.s.status === 'max-ticks'; }

  /** Queue an operator action; it is applied at the start of the next tick. */
  inject(action: InjectAction) {
    this.s.pendingInjections.push({ at: this.s.tick, action });
    if (this.s.status === 'deadlock' || this.s.status === 'stalled') this.s.status = 'running';
  }

  run(limit = Infinity): void { let n = 0; while (!this.finished && n++ < limit) this.step(); }

  /* -------------------------------------------------------------- tick */
  step(): boolean {
    if (this.finished) return false;
    const s = this.s, cfg = s.config, t = s.tick;
    if (s.status === 'ready') s.status = 'running';

    // 1. injections
    if (s.pendingInjections.length) {
      const now = s.pendingInjections.filter(i => i.at <= t);
      s.pendingInjections = s.pendingInjections.filter(i => i.at > t);
      for (const inj of now) this.applyInjection(inj.action);
    }

    // 2. arrivals
    for (const th of s.threads) {
      if (th.state === 'new' && th.arrive === t) {
        const p = s.processes[th.pid];
        if (p.state === 'new') p.state = 'active';
        this.makeReady(th);
        this.emit('ARRIVE', th, `${th.name} arrived`, { priority: th.basePriority });
      }
    }

    // 3. timed wake-ups
    for (const th of s.threads) {
      const b = th.block;
      if (th.state !== 'blocked' || !b || !('until' in b) || b.until !== t) continue;
      if (b.kind === 'fault') {
        const pte = s.processes[th.pid].pageTable[b.vpn];
        if (pte.loading && pte.readyAt === t) {
          pte.loading = false; pte.present = true; s.frames[pte.frame].loading = false;
          this.emit('PAGE_IN', th, `page ${b.vpn} of ${s.processes[th.pid].name} is now in frame ${pte.frame}`, { vpn: b.vpn, frame: pte.frame });
        }
        th.block = null; this.makeReady(th);
        this.emit('WAKE', th, `${th.name} resumes after the page fault`, { reason: 'fault' });
      } else {
        th.block = null;
        this.emit('SYSCALL_EXIT', th, `${th.name} returns from ${b.kind}`, { call: b.kind });
        this.advance(th);
        if ((th.state as string) !== 'terminated') { this.makeReady(th); this.emit('WAKE', th, `${th.name} woke up (${b.kind} complete)`, { reason: b.kind }); }
      }
    }

    // 4. round-robin quantum expiry
    if (cfg.scheduler === 'rr') {
      for (const core of s.cores) {
        if (core.running < 0) continue;
        const th = s.threads[core.running];
        if (th.quantumUsed >= cfg.quantum) {
          if (s.ready.length) this.preempt(core, 'quantum expired');
          else th.quantumUsed = 0;
        }
      }
    }

    // 5. preemption (SRTF / preemptive priority)
    if (cfg.scheduler === 'srtf' || (cfg.scheduler === 'priority' && cfg.preempt)) {
      for (let guard = 0; guard < s.cores.length; guard++) {
        const best = this.peekReady(); if (best < 0) break;
        if (s.cores.some(c => c.running < 0 && !c.switching)) break; // an idle core will take it
        let victimCore: CoreRT | null = null;
        for (const c of s.cores) {
          if (c.running < 0) continue;
          if (!victimCore || this.compare(s.threads[c.running], s.threads[victimCore.running]) > 0) victimCore = c;
        }
        if (!victimCore) break;
        // preempt only for a strictly better primary key (shorter remaining time / higher priority), never on a tie
        if (this.primaryKey(s.threads[best]) < this.primaryKey(s.threads[victimCore.running])) {
          this.preempt(victimCore, cfg.scheduler === 'srtf' ? 'shorter job arrived' : 'higher priority ready');
        } else break;
      }
    }

    // 6. dispatch
    for (const core of s.cores) {
      if (core.running >= 0 || core.switching) continue;
      const tid = this.peekReady(); if (tid < 0) break;
      this.dispatch(core, s.threads[tid]);
    }

    // snapshot of states during this tick (for accounting and the timeline)
    const states = s.threads.map(th => th.state);
    const blockKinds = s.threads.map(th => (th.state === 'blocked' && th.block ? th.block.kind : null));
    const coreRec: TickRecord['cores'] = [];

    // 7. execute
    for (const core of s.cores) {
      if (core.switching) {
        const th = s.threads[core.switching.tid];
        core.switching.rem--; core.switchTicks++; th.switchTicks++;
        coreRec.push({ tid: th.tid, kind: 'switch' });
        if (core.switching.rem <= 0) { core.switching = null; this.startRunning(core, th, true); }
        continue;
      }
      if (core.running < 0) { core.idleTicks++; coreRec.push({ tid: -1, kind: 'idle' }); continue; }
      const th = s.threads[core.running];
      const op = this.ops[th.tid][th.pc];
      coreRec.push({ tid: th.tid, kind: 'run', line: op?.line });
      core.busyTicks++; th.cpuTicks++; th.quantumUsed++;
      this.execute(core, th);
    }

    // 8. accounting & checks
    for (const th of s.threads) {
      const st = states[th.tid];
      if (st === 'ready' && !s.cores.some(c => c.switching?.tid === th.tid) && coreRec.every(r => r.tid !== th.tid)) th.readyTicks++;
      else if (st === 'blocked') th.blockedTicks++;
    }
    for (const th of s.threads) {
      if (th.state !== 'ready' || s.cores.some(c => c.switching?.tid === th.tid)) continue;
      const waited = t + 1 - th.readySince;
      if (cfg.aging > 0 && cfg.scheduler === 'priority' && waited > 0 && waited % cfg.aging === 0 && th.basePriority - th.agingBoost > 0) {
        th.agingBoost++; this.recomputePriorities();
        this.emit('AGING', th, `${th.name} aged to priority ${th.effPriority} after waiting ${waited} ticks`, { priority: th.effPriority, waited });
      }
      if (cfg.starve > 0 && !th.starvationWarned && waited >= cfg.starve) {
        th.starvationWarned = true;
        this.emit('STARVATION', th, `${th.name} has been ready for ${waited} ticks without running`, { waited });
      }
    }
    this.ticks[t] = { t, cores: coreRec, states, blockKinds, framesUsed: s.frames.filter(f => f.pid >= 0).length };

    s.tick = t + 1;
    this.checkDeadlock();
    if (s.threads.every(th => th.state === 'terminated')) {
      s.status = 'done';
      this.emit('HALT', null, `all threads finished at t=${s.tick}`, { reason: 'done' });
    } else if (s.status === 'running') {
      this.checkStall();
      if (s.status === 'running' && s.tick >= cfg.maxTicks) {
        s.status = 'max-ticks';
        this.emit('HALT', null, `stopped at the tick limit (${cfg.maxTicks})`, { reason: 'max-ticks' });
      }
    }
    s.eventCount = s.nextEvent;
    return !this.finished;
  }

  /* ---------------------------------------------------------- execution */
  private execute(core: CoreRT, th: ThreadRT) {
    const s = this.s, cfg = s.config, t = s.tick;
    const op = this.ops[th.tid][th.pc];
    if (!op) { this.terminate(th, 0, 'finished'); return; }
    switch (op.k) {
      case 'compute': {
        if (th.opRem < 0) th.opRem = op.n;
        th.opRem--;
        if (th.opRem <= 0) this.advance(th);
        return;
      }
      case 'mem': return this.executeMem(core, th, op);
      case 'sys': {
        this.emit('SYSCALL_ENTER', th, `${th.name} → syscall ${op.call}${op.call === 'getpid' ? '' : ` (${op.n} ticks)`}`, { call: op.call, n: op.n }, op.line);
        if (op.call === 'getpid') { this.emit('SYSCALL_EXIT', th, `${th.name} ← getpid = ${th.pid}`, { call: 'getpid', result: th.pid }, op.line); this.advance(th); return; }
        this.block(core, th, { kind: op.call, until: t + 1 + op.n });
        return;
      }
      case 'lock': {
        const m = s.mutexes[op.m];
        if (m.owner < 0) {
          m.owner = th.tid; m.acquisitions++; th.held.push(m.name);
          this.emit('LOCK_ACQUIRE', th, `${th.name} acquired ${m.name}`, { mutex: m.name }, op.line);
          this.advance(th);
        } else {
          m.contentions++; m.waiters.push(th.tid);
          const owner = s.threads[m.owner];
          this.emit('LOCK_CONTEND', th, m.owner === th.tid
            ? `${th.name} tried to re-lock ${m.name}, which it already holds (self-deadlock)`
            : `${th.name} waits for ${m.name} (held by ${owner.name})`, { mutex: m.name, owner: m.owner }, op.line);
          this.block(core, th, { kind: 'lock', m: m.name });
          if (cfg.inherit) this.recomputePriorities();
        }
        return;
      }
      case 'unlock': {
        const m = s.mutexes[op.m];
        if (m.owner !== th.tid) {
          this.emit('UNLOCK_NOT_OWNER', th, `${th.name} unlocked ${m.name} without owning it${m.owner >= 0 ? ` (owner: ${s.threads[m.owner].name})` : ''}; thread aborted`, { mutex: m.name, owner: m.owner }, op.line);
          this.terminate(th, 134, 'unlock of a mutex it does not own');
          return;
        }
        this.releaseMutex(th, m.name, false);
        this.advance(th);
        return;
      }
      case 'wait': {
        const sem = s.sems[op.s];
        if (sem.value > 0) {
          sem.value--;
          if (sem.initial === 1) th.held.push(sem.name);
          this.emit('SEM_WAIT', th, `${th.name} passed wait(${sem.name}) → ${sem.value}`, { sem: sem.name, value: sem.value }, op.line);
          this.advance(th);
        } else {
          sem.waiters.push(th.tid);
          this.emit('SEM_BLOCK', th, `${th.name} blocks on wait(${sem.name}) (value 0)`, { sem: sem.name }, op.line);
          this.block(core, th, { kind: 'sem', s: sem.name });
        }
        return;
      }
      case 'signal': {
        const sem = s.sems[op.s];
        th.held = th.held.filter(h => h !== sem.name);
        this.postSemaphore(sem.name, th);
        this.advance(th);
        return;
      }
      case 'ldv': {
        const v = s.vars[op.v];
        th.reg = v.value; th.loadedVersion = v.version;
        const ev = this.emit('VAR_READ', th, `${th.name} read ${v.name} = ${v.value} into its register`, { var: v.name, value: v.value, version: v.version }, op.line);
        th.loadedEvent = ev.id;
        this.lockset(th, v.name, false, ev.id);
        this.advance(th);
        return;
      }
      case 'add': { th.reg += op.d; th.pendingDelta = op.d; this.advance(th); return; }
      case 'stv': {
        const v = s.vars[op.v];
        const stale = v.version - th.loadedVersion;     // writes by others since this thread's read
        const before = v.value;
        // increments this write destroys: what the value should become minus what is written.
        // Summed over a run this equals exactly (expected − actual), for any number of threads.
        const lost = before + th.pendingDelta - th.reg;
        if (stale > 0 && lost !== 0) {
          this.emit('LOST_UPDATE', th, `${th.name} wrote ${v.name} = ${th.reg} from a stale read (it read ${th.reg - th.pendingDelta}, but ${v.name} is now ${before}); ${Math.abs(lost)} update${Math.abs(lost) > 1 ? 's' : ''} lost`,
            { var: v.name, staleWrites: stale, lost, before, written: th.reg, readEvent: th.loadedEvent }, op.line);
        }
        v.value = th.reg; v.version++; v.increments++; v.expectedDelta += th.pendingDelta;
        const ev = this.emit('VAR_WRITE', th, `${th.name} wrote ${v.name} = ${v.value}`, { var: v.name, value: v.value, before, version: v.version }, op.line);
        this.lockset(th, v.name, true, ev.id);
        this.advance(th);
        return;
      }
      case 'atomic': {
        const v = s.vars[op.v];
        v.value += op.d; v.version++; v.increments++; v.expectedDelta += op.d;
        this.emit('VAR_ATOMIC', th, `${th.name} atomically updated ${v.name} → ${v.value}`, { var: v.name, value: v.value }, op.line);
        this.advance(th);
        return;
      }
      case 'yield': {
        this.emit('YIELD', th, `${th.name} yielded the CPU`, {}, op.line);
        this.advance(th);
        if (th.state === 'running') { this.release(core, th); this.makeReady(th); }
        return;
      }
      case 'exit': { this.terminate(th, op.code, 'exit'); return; }
    }
  }

  private executeMem(core: CoreRT, th: ThreadRT, op: Extract<Op, { k: 'mem' }>) {
    const s = this.s, cfg = s.config, t = s.tick;
    const proc = s.processes[th.pid];
    const vpn = Math.floor(op.addr / cfg.pageSize);
    if (th.opRem < 0) {
      if (vpn >= proc.pages) {
        this.emit('SEGFAULT', th, `${th.name} accessed 0x${op.addr.toString(16)} (page ${vpn}) outside its ${proc.pages}-page address space; process killed (SIGSEGV)`,
          { addr: op.addr, vpn, pages: proc.pages }, op.line);
        this.killProcess(th.pid, 139);
        return;
      }
      const pte = proc.pageTable[vpn];
      let cost = 1;
      if (cfg.tlb > 0) {
        const hit = core.tlb.find(e => e.pid === th.pid && e.vpn === vpn);
        if (hit) {
          hit.lastUse = t; s.counters.tlbHits++;
          this.emit('TLB_HIT', th, `TLB hit: page ${vpn} → frame ${hit.frame}`, { vpn, frame: hit.frame }, op.line);
        } else {
          s.counters.tlbMisses++;
          this.emit('TLB_MISS', th, `TLB miss on page ${vpn}; walking ${proc.name}'s page table`, { vpn }, op.line);
          if (pte.present) { this.tlbFill(core, th.pid, vpn, pte.frame); cost += cfg.tlbPenalty; }
        }
      }
      if (!pte.present) {
        if (pte.loading) {
          // another thread of this process is already bringing the page in
          this.emit('BLOCK', th, `${th.name} waits for page ${vpn}, already being loaded`, { reason: 'fault', vpn }, op.line);
          this.block(core, th, { kind: 'fault', until: pte.readyAt, vpn });
          return;
        }
        this.pageFault(core, th, vpn, op);
        return;
      }
      th.opRem = cost;
    }
    th.opRem--;
    if (th.opRem > 0) return;
    const pte = proc.pageTable[vpn];
    pte.ref = true; pte.lastUse = t;
    if (op.write) pte.dirty = true;
    s.counters.memAccesses++;
    this.emit('MEM_ACCESS', th, `${th.name} ${op.write ? 'wrote' : 'read'} 0x${op.addr.toString(16)} (page ${vpn}, frame ${pte.frame})`,
      { addr: op.addr, vpn, frame: pte.frame, write: op.write }, op.line);
    this.advance(th);
  }

  private pageFault(core: CoreRT, th: ThreadRT, vpn: number, op: Extract<Op, { k: 'mem' }>) {
    const s = this.s, cfg = s.config, t = s.tick;
    const proc = s.processes[th.pid];
    const pick = this.allocFrame();
    if (pick.frame < 0) {
      this.emit('BLOCK', th, `${th.name} page fault on page ${vpn} but every frame is busy loading; retrying`, { reason: 'fault', vpn, retry: true }, op.line);
      this.block(core, th, { kind: 'fault', until: t + 1, vpn });
      return;
    }
    s.counters.faults++; th.faults++;
    const frame = pick.frame;
    let delay = cfg.fault;
    let victimMsg = '';
    if (pick.victim) {
      const v = pick.victim;
      const vproc = s.processes[v.pid];
      const vpte = vproc.pageTable[v.vpn];
      const dirty = vpte.dirty;
      if (dirty) { delay += cfg.writeback; s.counters.writebacks++; }
      s.counters.evictions++;
      vpte.present = false; vpte.frame = -1; vpte.dirty = false; vpte.ref = false;
      victimMsg = `, evicting ${vproc.name}:page ${v.vpn}${dirty ? ' (dirty, written back)' : ''}`;
      this.emit('PAGE_EVICT', th, `${cfg.replacement.toUpperCase()} evicted ${vproc.name}:page ${v.vpn} from frame ${frame}${dirty ? ' and wrote it back to disk' : ''}`,
        { frame, pid: v.pid, vpn: v.vpn, dirty, policy: cfg.replacement, lastUse: v.lastUse, loadedAt: v.loadedAt }, op.line);
      let shot = 0;
      for (const c of s.cores) { const n = c.tlb.length; c.tlb = c.tlb.filter(e => !(e.pid === v.pid && e.vpn === v.vpn)); shot += n - c.tlb.length; }
      if (shot) this.emit('TLB_SHOOTDOWN', th, `invalidated ${shot} TLB entr${shot > 1 ? 'ies' : 'y'} for ${vproc.name}:page ${v.vpn}`, { pid: v.pid, vpn: v.vpn, entries: shot });
    }
    const pte = proc.pageTable[vpn];
    s.frames[frame] = { pid: th.pid, vpn, loading: true };
    pte.frame = frame; pte.loading = true; pte.present = false; pte.dirty = false; pte.ref = true;
    pte.loadedAt = t; pte.lastUse = t; pte.readyAt = t + 1 + delay;
    this.emit('PAGE_FAULT', th, `${th.name} page fault on page ${vpn} of ${proc.name} → frame ${frame}${victimMsg}; blocked ${delay} ticks`,
      { vpn, frame, delay, victim: pick.victim ? { pid: pick.victim.pid, vpn: pick.victim.vpn } : null }, op.line);
    this.block(core, th, { kind: 'fault', until: pte.readyAt, vpn });
  }

  /** Choose a frame: lowest free frame, else a victim by the replacement policy. Frames being loaded are pinned. */
  private allocFrame(): { frame: number; victim: { pid: number; vpn: number; lastUse: number; loadedAt: number } | null } {
    const s = this.s, cfg = s.config;
    const free = s.frames.findIndex(f => f.pid < 0);
    if (free >= 0) return { frame: free, victim: null };
    const candidates = s.frames.map((f, i) => ({ f, i })).filter(x => !x.f.loading);
    if (!candidates.length) return { frame: -1, victim: null };
    const pteOf = (i: number): PTE => { const f = s.frames[i]; return s.processes[f.pid].pageTable[f.vpn]; };
    let idx = -1;
    if (cfg.replacement === 'fifo') {
      idx = candidates.reduce((a, b) => (pteOf(b.i).loadedAt < pteOf(a.i).loadedAt ? b : a)).i;
    } else if (cfg.replacement === 'lru') {
      idx = candidates.reduce((a, b) => (pteOf(b.i).lastUse < pteOf(a.i).lastUse ? b : a)).i;
    } else {
      // clock / second chance
      const n = s.frames.length;
      for (let k = 0; k < n * 2 + 1; k++) {
        const i = s.clockHand; s.clockHand = (s.clockHand + 1) % n;
        if (s.frames[i].loading) continue;
        const p = pteOf(i);
        if (p.ref) { p.ref = false; continue; }
        idx = i; break;
      }
      if (idx < 0) idx = candidates[0].i;
    }
    const f = s.frames[idx], p = pteOf(idx);
    return { frame: idx, victim: { pid: f.pid, vpn: f.vpn, lastUse: p.lastUse, loadedAt: p.loadedAt } };
  }

  private tlbFill(core: CoreRT, pid: number, vpn: number, frame: number) {
    const cfg = this.s.config;
    if (cfg.tlb <= 0) return;
    if (core.tlb.length >= cfg.tlb) {
      let lru = 0;
      for (let i = 1; i < core.tlb.length; i++) if (core.tlb[i].lastUse < core.tlb[lru].lastUse) lru = i;
      core.tlb.splice(lru, 1);
    }
    core.tlb.push({ pid, vpn, frame, lastUse: this.s.tick });
  }

  /* -------------------------------------------------------- scheduling */
  /** Remaining CPU demand until the next blocking system call (the "next burst" used by SJF/SRTF). */
  burst(th: ThreadRT): number {
    const ops = this.ops[th.tid];
    let sum = 0;
    for (let i = th.pc; i < ops.length; i++) {
      const o = ops[i];
      if (o.k === 'compute') sum += i === th.pc && th.opRem >= 0 ? th.opRem : o.n;
      else if (o.k === 'exit') break;
      else { sum += 1; if (o.k === 'sys' && o.call !== 'getpid') break; }
    }
    return sum;
  }

  /** The policy's ranking key alone (lower runs first), without the FIFO tie-break. */
  primaryKey(th: ThreadRT): number {
    const k = this.s.config.scheduler;
    if (k === 'sjf' || k === 'srtf') return this.burst(th);
    if (k === 'priority') return th.effPriority;
    return th.enqSeq;
  }

  /** Negative when `a` should run before `b`. */
  compare(a: ThreadRT, b: ThreadRT): number {
    const k = this.s.config.scheduler;
    if (k === 'sjf' || k === 'srtf') { const d = this.burst(a) - this.burst(b); if (d) return d; }
    if (k === 'priority') { const d = a.effPriority - b.effPriority; if (d) return d; }
    return a.enqSeq - b.enqSeq;
  }

  private peekReady(): number {
    const s = this.s;
    let best = -1;
    for (const tid of s.ready) if (best < 0 || this.compare(s.threads[tid], s.threads[best]) < 0) best = tid;
    return best;
  }

  private makeReady(th: ThreadRT) {
    // aging rewards time spent waiting; the boost is cleared once the thread has had the CPU and queues again
    if (th.agingBoost && th.firstRun >= 0) { th.agingBoost = 0; this.recomputePriorities(); }
    th.state = 'ready'; th.core = -1; th.enqSeq = this.s.seq++; th.readySince = this.s.tick;
    if (!this.s.ready.includes(th.tid)) this.s.ready.push(th.tid);
  }

  private dispatch(core: CoreRT, th: ThreadRT) {
    const s = this.s, cfg = s.config;
    s.ready = s.ready.filter(x => x !== th.tid);
    const switching = core.lastTid >= 0 && core.lastTid !== th.tid;
    if (switching) s.counters.contextSwitches++;
    if (core.lastPid >= 0 && core.lastPid !== th.pid && core.tlb.length) {
      this.emit('TLB_FLUSH', th, `core ${core.id} TLB flushed: address space changes from ${s.processes[core.lastPid].name} to ${s.processes[th.pid].name}`, { from: core.lastPid, to: th.pid, entries: core.tlb.length });
      core.tlb = [];
    }
    if (switching && cfg.cs > 0) {
      core.switching = { tid: th.tid, rem: cfg.cs };
      th.core = core.id;
      this.emit('SWITCH_START', th, `core ${core.id} context switch ${core.lastTid >= 0 ? s.threads[core.lastTid].name : 'idle'} → ${th.name} (${cfg.cs} tick${cfg.cs > 1 ? 's' : ''})`,
        { from: core.lastTid, to: th.tid, cost: cfg.cs, sameProcess: core.lastPid === th.pid });
      core.lastTid = th.tid; core.lastPid = th.pid;
      return;
    }
    core.lastTid = th.tid; core.lastPid = th.pid;
    this.startRunning(core, th, false);
  }

  private startRunning(core: CoreRT, th: ThreadRT, afterSwitch: boolean) {
    const t = this.s.tick + (afterSwitch ? 1 : 0);
    th.state = 'running'; th.core = core.id; th.quantumUsed = 0;
    if (th.firstRun < 0) th.firstRun = t;
    core.running = th.tid;
    this.emit('DISPATCH', th, afterSwitch ? `core ${core.id} finished switching; ${th.name} runs from t=${t}` : `core ${core.id} runs ${th.name}`, { burst: this.burst(th), priority: th.effPriority, from: t });
  }

  private preempt(core: CoreRT, reason: string) {
    const th = this.s.threads[core.running];
    this.s.counters.preemptions++;
    this.emit('PREEMPT', th, `${th.name} preempted on core ${core.id}: ${reason}`, { reason });
    core.running = -1;
    this.makeReady(th);
  }

  private release(core: CoreRT, th: ThreadRT) { if (core.running === th.tid) core.running = -1; th.core = -1; }

  private block(core: CoreRT, th: ThreadRT, reason: BlockReason) {
    th.state = 'blocked'; th.block = reason;
    this.release(core, th);
    const desc = reason.kind === 'lock' ? `mutex ${reason.m}` : reason.kind === 'sem' ? `semaphore ${reason.s}` : reason.kind === 'fault' ? `page ${reason.vpn} (until t=${reason.until})` : `${reason.kind} (until t=${reason.until})`;
    this.emit('BLOCK', th, `${th.name} blocked on ${desc}`, { reason: reason.kind, ...reason });
  }

  private advance(th: ThreadRT) {
    th.pc++; th.opRem = -1; th.opPhase = 0;
    const ops = this.ops[th.tid];
    const nxt = ops[th.pc];
    if (th.pc >= ops.length) this.terminate(th, 0, 'finished');
    else if (nxt.k === 'exit') this.terminate(th, nxt.code, 'exit');
  }

  /* -------------------------------------------------------------- sync */
  private releaseMutex(th: ThreadRT, name: string, abandoned: boolean) {
    const s = this.s, m = s.mutexes[name];
    th.held = th.held.filter(h => h !== name);
    if (abandoned) this.emit('LOCK_ABANDONED', th, `${th.name} died holding ${name}; the lock is released`, { mutex: name });
    if (m.waiters.length) {
      const w = s.threads[m.waiters.shift()!];
      m.owner = w.tid; m.acquisitions++; w.held.push(name); w.block = null;
      this.emit('LOCK_HANDOFF', w, `${name} handed from ${th.name} to ${w.name}`, { mutex: name, from: th.tid });
      this.advance(w);
      if (w.state !== 'terminated') { this.makeReady(w); this.emit('WAKE', w, `${w.name} woke holding ${name}`, { reason: 'lock' }); }
    } else {
      m.owner = -1;
      if (!abandoned) this.emit('LOCK_RELEASE', th, `${th.name} released ${name}`, { mutex: name });
    }
    if (s.config.inherit) this.recomputePriorities();
  }

  private postSemaphore(name: string, by: ThreadRT | null) {
    const s = this.s, sem = s.sems[name];
    if (sem.waiters.length) {
      const w = s.threads[sem.waiters.shift()!];
      w.block = null;
      if (sem.initial === 1) w.held.push(name);
      this.emit('SEM_HANDOFF', w, `signal(${name}) by ${by ? by.name : 'operator'} wakes ${w.name}`, { sem: name, from: by ? by.tid : -1 });
      this.advance(w);
      if (w.state !== 'terminated') { this.makeReady(w); this.emit('WAKE', w, `${w.name} woke after signal(${name})`, { reason: 'sem' }); }
    } else {
      sem.value++;
      this.emit('SEM_SIGNAL', by, `${by ? by.name : 'operator'} signal(${name}) → ${sem.value}`, { sem: name, value: sem.value });
    }
  }

  /** Effective priority = base − aging boost, lowered further by priority inheritance from waiters. */
  private recomputePriorities() {
    const s = this.s;
    const base = (th: ThreadRT) => Math.max(0, th.basePriority - th.agingBoost);
    const eff = s.threads.map(base);
    if (s.config.inherit) {
      for (let iter = 0; iter < s.threads.length + 1; iter++) {
        let changed = false;
        for (const m of Object.values(s.mutexes)) {
          if (m.owner < 0) continue;
          for (const w of m.waiters) if (eff[w] < eff[m.owner]) { eff[m.owner] = eff[w]; changed = true; }
        }
        if (!changed) break;
      }
    }
    for (const th of s.threads) {
      if (th.effPriority === eff[th.tid]) continue;
      const before = th.effPriority; th.effPriority = eff[th.tid];
      if (s.config.inherit && eff[th.tid] < base(th)) this.emit('PRIORITY_INHERIT', th, `${th.name} inherits priority ${eff[th.tid]} (was ${before}) from a waiter on its lock`, { from: before, to: eff[th.tid] });
      else if (s.config.inherit && before < eff[th.tid] && before < base(th)) this.emit('PRIORITY_RESTORE', th, `${th.name} returns to priority ${eff[th.tid]}`, { from: before, to: eff[th.tid] });
    }
  }

  /** Eraser-style lockset race detection on shared variables. */
  private lockset(th: ThreadRT, name: string, write: boolean, eventId: number) {
    const v = this.s.vars[name];
    const held = [...th.held];
    switch (v.lsState) {
      case 'virgin': v.lsState = 'exclusive'; v.lsOwner = th.tid; break;
      case 'exclusive':
        if (th.tid !== v.lsOwner) { v.lsState = write ? 'shared-modified' : 'shared'; v.lockset = held; }
        break;
      case 'shared':
        v.lockset = (v.lockset ?? held).filter(l => held.includes(l));
        if (write) v.lsState = 'shared-modified';
        break;
      case 'shared-modified':
        v.lockset = (v.lockset ?? held).filter(l => held.includes(l));
        break;
    }
    if (v.lsState === 'shared-modified' && v.lockset && v.lockset.length === 0 && !v.raceReported && v.lastAccess && v.lastAccess.tid !== th.tid) {
      v.raceReported = true;
      const other = this.s.threads[v.lastAccess.tid];
      this.emit('RACE', th, `data race on ${name}: ${other.name} and ${th.name} access it with no common lock`,
        { var: name, threads: [other.tid, th.tid], events: [v.lastAccess.event, eventId], heldA: [], heldB: held });
    }
    v.lastAccess = { tid: th.tid, event: eventId, write };
  }

  private checkDeadlock() {
    const s = this.s;
    const waitsOn = (tid: number): number => {
      const th = s.threads[tid];
      if (th.state !== 'blocked' || th.block?.kind !== 'lock') return -1;
      return s.mutexes[th.block.m].owner;
    };
    for (const start of s.threads) {
      if (waitsOn(start.tid) < 0) continue;
      const seen = new Map<number, number>();
      let cur = start.tid, i = 0;
      while (cur >= 0 && !seen.has(cur)) { seen.set(cur, i++); cur = waitsOn(cur); }
      if (cur < 0) continue;
      // cur is on a cycle
      const cycle: number[] = [];
      let x = cur;
      do { cycle.push(x); x = waitsOn(x); } while (x !== cur);
      const key = [...cycle].sort((a, b) => a - b).join(',');
      if (s.deadlock && [...s.deadlock.tids].sort((a, b) => a - b).join(',') === key) return;
      const resources = cycle.map(tid => (s.threads[tid].block as { m: string }).m);
      s.deadlock = { tids: cycle, resources };
      const desc = cycle.map(tid => `${s.threads[tid].name} waits for ${(s.threads[tid].block as { m: string }).m} (held by ${s.threads[waitsOn(tid)].name})`).join('; ');
      this.emit('DEADLOCK', null, `deadlock: ${desc}`, { tids: cycle, resources });
      if (s.config.deadlock === 'halt') s.status = 'deadlock';
      return;
    }
    s.deadlock = null;
  }

  private checkStall() {
    const s = this.s;
    const live = s.threads.filter(th => th.state !== 'terminated');
    if (!live.length) return;
    if (live.some(th => th.state === 'ready' || th.state === 'running' || th.state === 'new')) return;
    if (s.cores.some(c => c.switching)) return;
    if (live.some(th => th.block && 'until' in th.block)) return;
    if (s.pendingInjections.length) return;
    s.status = 'stalled';
    const waits = live.map(th => `${th.name} on ${th.block?.kind === 'sem' ? `semaphore ${th.block.s}` : th.block?.kind === 'lock' ? `mutex ${th.block.m}` : '?'}`);
    this.emit('STALL', null, `no thread can make progress: ${waits.join(', ')}`, { tids: live.map(th => th.tid) });
  }

  /* ------------------------------------------------------ termination */
  private terminate(th: ThreadRT, code: number, why: string) {
    const s = this.s;
    if (th.state === 'terminated') return;
    for (const c of s.cores) {
      if (c.running === th.tid) c.running = -1;
      if (c.switching?.tid === th.tid) c.switching = null;
    }
    s.ready = s.ready.filter(x => x !== th.tid);
    if (th.block?.kind === 'lock') { const m = s.mutexes[th.block.m]; m.waiters = m.waiters.filter(w => w !== th.tid); }
    if (th.block?.kind === 'sem') { const sm = s.sems[th.block.s]; sm.waiters = sm.waiters.filter(w => w !== th.tid); }
    th.state = 'terminated'; th.block = null; th.core = -1; th.exitCode = code; th.finish = s.tick + 1;
    for (const m of [...th.held]) if (s.mutexes[m]) this.releaseMutex(th, m, true);
    th.held = [];
    this.emit('EXIT', th, `${th.name} exited (${why}${code ? `, code ${code}` : ''})`, { code, why });
    const p = s.processes[th.pid];
    if (p.state !== 'terminated' && s.threads.filter(x => x.pid === th.pid).every(x => x.state === 'terminated')) {
      p.state = 'terminated'; p.finish = s.tick + 1; p.exitCode = code;
      let freed = 0;
      s.frames.forEach((f, i) => { if (f.pid === p.pid) { s.frames[i] = { pid: -1, vpn: -1, loading: false }; freed++; } });
      for (const pte of p.pageTable) { pte.present = false; pte.frame = -1; pte.loading = false; }
      for (const c of s.cores) c.tlb = c.tlb.filter(e => e.pid !== p.pid);
      this.emit('PROCESS_EXIT', th, `process ${p.name} exited${code ? ` with code ${code}` : ''}; ${freed} frame${freed === 1 ? '' : 's'} freed`, { pid: p.pid, code, freed });
    }
  }

  private killProcess(pid: number, code: number) {
    for (const th of this.s.threads) if (th.pid === pid && th.state !== 'terminated') this.terminate(th, code, code === 139 ? 'segmentation fault' : 'killed');
  }

  private applyInjection(a: InjectAction) {
    const s = this.s;
    if (a.type === 'kill') {
      const th = s.threads[a.tid];
      if (!th || th.state === 'terminated') return;
      this.emit('INJECT', th, `operator killed ${th.name} (SIGKILL)`, { action: 'kill' });
      this.terminate(th, 137, 'killed by operator');
    } else if (a.type === 'signal') {
      if (!s.sems[a.s]) return;
      this.emit('INJECT', null, `operator signal(${a.s})`, { action: 'signal', sem: a.s });
      this.postSemaphore(a.s, null);
    } else if (a.type === 'unlock') {
      const m = s.mutexes[a.m];
      if (!m || m.owner < 0) return;
      const owner = s.threads[m.owner];
      this.emit('INJECT', owner, `operator force-released ${a.m} from ${owner.name}`, { action: 'unlock', mutex: a.m });
      this.releaseMutex(owner, a.m, false);
    }
    s.deadlock = null;
  }

  /* -------------------------------------------------------------- log */
  private emit(type: EventType, th: ThreadRT | null, msg: string, data?: Record<string, unknown>, line?: number): SimEvent {
    const e: SimEvent = { id: this.s.nextEvent++, t: this.s.tick, type, msg };
    if (th) { e.tid = th.tid; e.pid = th.pid; if (th.core >= 0) e.core = th.core; }
    if (line !== undefined) e.line = line;
    else if (th) { const op = this.ops[th.tid]?.[th.pc]; if (op) e.line = op.line; }
    if (data) e.data = data;
    this.events[e.id] = e;
    return e;
  }
}

export interface Snapshot { state: MachineState; events: number; ticks: number }
