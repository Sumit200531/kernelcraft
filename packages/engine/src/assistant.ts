import type { Machine } from './kernel.js';
import { analyze, type Analysis, type Experiment, type Finding } from './analyze.js';
import type { SimEvent } from './types.js';

/**
 * The deterministic debugging assistant.
 *
 * It answers from the trace only: every claim cites event ids as `[#id]`, and
 * every suggested experiment has already been executed by the analyzer. The
 * API can optionally ask an LLM to rephrase an answer; it must keep the same
 * citations (validated with `validateCitations`).
 */

export interface Explanation { eventId: number; title: string; text: string; citations: number[]; lines: number[] }
export interface Answer { intent: string; text: string; citations: number[]; findings: string[]; experiments: Experiment[] }

const ref = (e: SimEvent | undefined) => (e ? `[#${e.id}]` : '');
const citesIn = (text: string) => [...new Set([...text.matchAll(/\[#(\d+)\]/g)].map(x => +x[1]))].sort((a, b) => a - b);

/** Every `[#id]` in `text` must name an event that exists in the visible log. */
export function validateCitations(m: Machine, text: string): { ok: boolean; unknown: number[] } {
  const n = m.s.nextEvent;
  const unknown = citesIn(text).filter(id => id >= n || !m.events[id]);
  return { ok: unknown.length === 0, unknown };
}

/* ------------------------------------------------------------------ explain */

export function explainEvent(m: Machine, id: number): Explanation | null {
  const s = m.s;
  const evs = m.visibleEvents();
  const e = evs[id];
  if (!e) return null;
  const name = (tid: number | undefined) => (tid === undefined || tid < 0 ? 'the operator' : s.threads[tid]?.name ?? `tid ${tid}`);
  const before = (pred: (x: SimEvent) => boolean) => { for (let i = e.id - 1; i >= 0; i--) if (pred(evs[i])) return evs[i]; return undefined; };
  const after = (pred: (x: SimEvent) => boolean) => evs.find(x => x.id > e.id && pred(x));
  const d = (e.data ?? {}) as Record<string, any>;
  const cfg = s.config;
  const parts: string[] = [];
  let title = e.msg;

  switch (e.type) {
    case 'PAGE_FAULT': {
      title = `Page fault on page ${d.vpn}`;
      const prevEvict = before(x => x.type === 'PAGE_EVICT' && x.data!.pid === e.pid && x.data!.vpn === d.vpn);
      const prevIn = before(x => x.type === 'PAGE_FAULT' && x.pid === e.pid && x.data!.vpn === d.vpn);
      if (prevEvict) parts.push(`This is a **refault**: the page was loaded before ${ref(prevIn)} and evicted at t=${prevEvict.t} ${ref(prevEvict)}. Repeated refaults are the signature of thrashing.`);
      else parts.push(`This is a **cold miss**: the first time ${s.processes[e.pid!].name} touched page ${d.vpn}. Demand paging loads pages only when they are used.`);
      if (d.victim) {
        const ev = after(x => x.type === 'PAGE_EVICT' && x.t === e.t) ?? before(x => x.type === 'PAGE_EVICT' && x.t === e.t);
        const why = cfg.replacement === 'lru' ? `it was the least recently used page (last used at t=${ev?.data!.lastUse})`
          : cfg.replacement === 'fifo' ? `it had been resident longest (loaded at t=${ev?.data!.loadedAt})`
          : 'the clock hand found it with its reference bit clear (second chance)';
        parts.push(`Every frame was full, so ${cfg.replacement.toUpperCase()} picked ${s.processes[d.victim.pid].name}:page ${d.victim.vpn} as the victim because ${why} ${ref(ev)}.`);
      } else parts.push(`Frame ${d.frame} was free, so nothing had to be evicted.`);
      const wb = d.delay - cfg.fault;
      parts.push(`The thread is blocked for ${d.delay} ticks: ${cfg.fault} to read the page${wb > 0 ? ` + ${wb} to write the dirty victim back first` : ''}. Other threads can use the CPU meanwhile.`);
      const pin = after(x => x.type === 'PAGE_IN' && x.tid === e.tid && x.data!.vpn === d.vpn);
      if (pin) parts.push(`The page arrived at t=${pin.t} ${ref(pin)} and the access was retried.`);
      break;
    }
    case 'PAGE_EVICT': {
      title = `${String(d.policy).toUpperCase()} eviction`;
      parts.push(`${s.processes[d.pid].name}:page ${d.vpn} left frame ${d.frame}. ${d.dirty ? 'It had been written to (dirty), so it was written back to disk, adding latency to the fault.' : 'It was clean, so it was simply dropped.'}`);
      parts.push(d.policy === 'lru' ? `LRU chose it because its last use (t=${d.lastUse}) was the oldest of all resident pages.`
        : d.policy === 'fifo' ? `FIFO chose it because it was loaded earliest (t=${d.loadedAt}), regardless of how recently it was used.`
        : 'Clock gives each page a second chance: the hand clears reference bits until it finds a page not used since its last pass.');
      const back = after(x => x.type === 'PAGE_FAULT' && x.pid === d.pid && x.data!.vpn === d.vpn);
      if (back) parts.push(`The page was needed again at t=${back.t} ${ref(back)}, ${back.t - e.t} ticks later.`);
      break;
    }
    case 'TLB_MISS': case 'TLB_HIT': {
      parts.push(e.type === 'TLB_HIT' ? `The translation for page ${d.vpn} was cached in this core's TLB, so no page-table walk was needed.`
        : `The TLB had no entry for page ${d.vpn}; the MMU walked the page table${cfg.tlbPenalty ? `, costing ${cfg.tlbPenalty} extra tick${cfg.tlbPenalty > 1 ? 's' : ''}` : ''}.`);
      const flush = before(x => x.type === 'TLB_FLUSH' && x.core === e.core);
      if (e.type === 'TLB_MISS' && flush && e.t - flush.t < 20) parts.push(`The TLB of core ${e.core} was flushed at t=${flush.t} ${ref(flush)} when it switched address spaces.`);
      break;
    }
    case 'PREEMPT': {
      title = `${name(e.tid)} preempted`;
      parts.push(`Reason: ${d.reason}.`);
      const next = after(x => (x.type === 'DISPATCH' || x.type === 'SWITCH_START') && x.core === e.core && x.t >= e.t);
      if (next) parts.push(`Core ${e.core} then went to ${name(next.tid)} ${ref(next)}.`);
      if (cfg.scheduler === 'rr') parts.push(`Under round robin a thread may run at most ${cfg.quantum} ticks before going to the back of the ready queue.`);
      break;
    }
    case 'DISPATCH': {
      const rule = { fcfs: 'first come, first served (earliest in the ready queue)', sjf: 'shortest next CPU burst', srtf: 'shortest remaining burst (preemptive)', priority: 'best priority (lowest number)', rr: 'head of the round-robin queue' }[cfg.scheduler];
      parts.push(`${cfg.scheduler.toUpperCase()} picks the ready thread with the ${rule}. ${name(e.tid)} had priority ${d.priority} and a next burst of ${d.burst} ticks.`);
      const r = before(x => x.tid === e.tid && ['ARRIVE', 'WAKE', 'PREEMPT', 'YIELD'].includes(x.type));
      if (r) parts.push(`It became ready at t=${r.t} ${ref(r)} and waited ${e.t - r.t} tick${e.t - r.t === 1 ? '' : 's'}.`);
      break;
    }
    case 'BLOCK': case 'LOCK_CONTEND': case 'SEM_BLOCK': {
      if (d.reason === 'lock' || e.type === 'LOCK_CONTEND') {
        const mx = d.m ?? d.mutex;
        const holder = d.owner ?? before(x => (x.type === 'LOCK_ACQUIRE' || x.type === 'LOCK_HANDOFF') && x.data!.mutex === mx)?.tid;
        const acq = before(x => (x.type === 'LOCK_ACQUIRE' || x.type === 'LOCK_HANDOFF') && x.data!.mutex === mx && x.tid === holder);
        parts.push(`${name(e.tid)} needs mutex ${mx}, which ${name(holder)} has held since t=${acq?.t ?? '?'} ${ref(acq)}.`);
        const got = after(x => x.type === 'LOCK_HANDOFF' && x.tid === e.tid && x.data!.mutex === mx);
        parts.push(got ? `It was handed the lock at t=${got.t} ${ref(got)} after waiting ${got.t - e.t} ticks.` : 'It never got the lock in this run.');
      } else if (d.reason === 'sem' || e.type === 'SEM_BLOCK') {
        const sem = d.s ?? d.sem;
        parts.push(`wait(${sem}) found the counter at 0, so ${name(e.tid)} sleeps until someone signals ${sem}.`);
        const got = after(x => x.type === 'SEM_HANDOFF' && x.tid === e.tid);
        parts.push(got ? `${name(got.data!.from as number)} signalled it at t=${got.t} ${ref(got)}.` : `Nobody signalled ${sem} afterwards.`);
      } else if (d.reason === 'fault') {
        const f = before(x => x.type === 'PAGE_FAULT' && x.tid === e.tid);
        parts.push(`Waiting for page ${d.vpn} to be read from disk${f ? ` ${ref(f)}` : ''}, until t=${d.until}.`);
      } else {
        parts.push(`A ${d.reason} system call: the thread sleeps until t=${d.until} and the CPU is free for others.`);
      }
      break;
    }
    case 'LOST_UPDATE': {
      title = `Lost update on ${d.var}`;
      const read = evs[d.readEvent];
      const between = evs.filter(x => x.id > d.readEvent && x.id < e.id && x.type === 'VAR_WRITE' && x.data!.var === d.var && x.tid !== e.tid);
      parts.push(`${name(e.tid)} read ${d.var} = ${read?.data!.value ?? '?'} ${ref(read)}, then was interrupted before writing back.`);
      parts.push(`Meanwhile ${between.length} write${between.length === 1 ? '' : 's'} by ${[...new Set(between.map(x => name(x.tid)))].join(', ')} moved ${d.var} to ${d.before} ${between.slice(0, 3).map(ref).join(' ')}.`);
      parts.push(`Writing its stale result ${d.written} erased ${d.lost} update${Math.abs(d.lost) === 1 ? '' : 's'}. \`inc\` is read → add → write; without a lock or an atomic instruction the three steps can interleave with another thread's.`);
      break;
    }
    case 'RACE': {
      const [a, b] = (d.events as number[]).map(i => evs[i]);
      parts.push(`Lockset analysis: ${d.var} is written by more than one thread and the set of locks held at every access is empty.`);
      parts.push(`The conflicting accesses are ${name(a?.tid)} ${ref(a)} and ${name(b?.tid)} ${ref(b)}, which share no lock.`);
      break;
    }
    case 'DEADLOCK': {
      const tids = d.tids as number[], res = d.resources as string[];
      parts.push('Every thread in the cycle holds a lock the next one needs:');
      tids.forEach((tid, i) => {
        const holder = tids[(i + 1) % tids.length];
        const acq = before(x => (x.type === 'LOCK_ACQUIRE' || x.type === 'LOCK_HANDOFF') && x.tid === holder && x.data!.mutex === res[i]);
        const c = before(x => x.type === 'LOCK_CONTEND' && x.tid === tid && x.data!.mutex === res[i]);
        parts.push(`- ${name(tid)} waits for **${res[i]}** ${ref(c)}, held by ${name(holder)} since t=${acq?.t} ${ref(acq)}`);
      });
      parts.push('All four Coffman conditions hold: mutual exclusion, hold-and-wait, no preemption, circular wait. Breaking any one (e.g. a global lock order) prevents it.');
      break;
    }
    case 'STALL': parts.push('No thread is ready, none is waiting on a timer or I/O, and there is no lock cycle: every live thread waits for a signal that nobody will send.'); break;
    case 'SEGFAULT': parts.push(`Page ${d.vpn} is beyond the ${d.pages}-page address space, so the page table has no entry for it. The MMU raises a fault the kernel cannot service, and the process is killed with SIGSEGV (exit 139).`); break;
    case 'STARVATION': parts.push(`The thread has been ready for ${d.waited} ticks. With ${cfg.scheduler} scheduling${cfg.aging ? ` and aging every ${cfg.aging} ticks` : ' and no aging'}, better-ranked threads keep winning.`); break;
    case 'AGING': parts.push(`Aging improves a waiting thread's priority by one level every ${cfg.aging} ticks, so it eventually outranks newer work.`); break;
    case 'PRIORITY_INHERIT': {
      const c = before(x => x.type === 'LOCK_CONTEND' && x.data!.owner === e.tid);
      parts.push(`${name(c?.tid)} is waiting for a lock this thread holds ${ref(c)}. With inheritance, the holder borrows the waiter's priority (${d.to}) so medium-priority threads cannot keep it off the CPU.`);
      break;
    }
    case 'SWITCH_START': parts.push(`Saving one thread's registers and loading another's costs ${d.cost} tick${d.cost > 1 ? 's' : ''} of pure overhead here${d.sameProcess ? ' (same process: the TLB survives)' : ' (different process: the TLB is flushed)'}.`); break;
    case 'EXIT': parts.push(`Exit code ${d.code}${d.code === 137 ? ' (killed)' : d.code === 139 ? ' (segmentation fault)' : d.code === 134 ? ' (aborted)' : ''}.`); break;
    default: break;
  }
  const text = parts.join('\n');
  return { eventId: e.id, title, text: text || e.msg, citations: citesIn(text), lines: e.line ? [e.line] : [] };
}

/* ------------------------------------------------------------------ answer */

function findingText(f: Finding): string {
  let t = `**${f.title}.** ${f.detail} Evidence: ${f.evidence.slice(0, 8).map(id => `[#${id}]`).join(' ')}.\n_Suggestion:_ ${f.advice}`;
  if (f.experiment?.result) t += `\n_Experiment — ${f.experiment.label}:_ ${f.experiment.result.summary}`;
  return t;
}

/**
 * Answer a free-text question about the current run. Intents are matched by
 * keyword; the answer is assembled only from the trace and analysis.
 */
export function answerQuestion(m: Machine, question: string, analysis: Analysis = analyze(m)): Answer {
  const q = question.toLowerCase();
  const s = m.s;
  const evs = m.visibleEvents();
  const F = analysis.findings;
  const pick = (...kinds: string[]) => F.filter(f => kinds.includes(f.kind));
  const out = (intent: string, text: string, fs: Finding[] = []): Answer => ({
    intent, text, citations: citesIn(text), findings: fs.map(f => f.id), experiments: fs.map(f => f.experiment).filter((x): x is Experiment => !!x)
  });

  // explicit event reference: "#42", "event 42"
  const evRef = /(?:#|event\s+)(\d+)/.exec(q);
  if (evRef) {
    const ex = explainEvent(m, +evRef[1]);
    if (!ex) return out('event', `There is no event #${evRef[1]} in this run (it has ${evs.length} events).`);
    return out('event', `**#${ex.eventId} · ${ex.title}** — ${evs[ex.eventId].msg}\n${ex.text}`);
  }

  // a specific tick: "t=12", "tick 12", "at 12"
  const tk = /\b(?:t\s*=\s*|tick\s+|at\s+)(\d+)\b/.exec(q);
  if (tk) {
    const t = +tk[1];
    if (t >= s.tick) return out('tick', `The run so far only reaches t=${s.tick}.`);
    const at = evs.filter(e => e.t === t && !['MEM_ACCESS', 'TLB_HIT'].includes(e.type));
    const cores = m.ticks[t]?.cores.map((c, i) => `core ${i}: ${c.kind === 'idle' ? 'idle' : c.kind === 'switch' ? `switching to ${s.threads[c.tid].name}` : `${s.threads[c.tid].name}${c.line ? ` (line ${c.line})` : ''}`}`).join(', ');
    return out('tick', `At t=${t} — ${cores}.\n` + (at.length ? at.slice(0, 12).map(e => `- [#${e.id}] ${e.msg}`).join('\n') : 'No scheduling, memory or sync events in that tick.'));
  }

  // a thread by name
  const word = (w: string) => new RegExp(`(^|[^a-z0-9_.])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`).test(q);
  const th = [...s.threads].sort((a, b) => b.name.length - a.name.length).find(t => word(t.name) ||
    (t.name.split('.')[0].length > 1 && word(t.name.split('.')[0]) && s.threads.filter(x => x.pid === t.pid).length === 1) ||
    (t.name.split('.')[1].length > 1 && t.name.split('.')[1] !== 'main' && word(t.name.split('.')[1])));
  if (th) {
    const mt = analysis.metrics.threads[th.tid];
    const mine = evs.filter(e => e.tid === th.tid);
    const arrive = mine.find(e => e.type === 'ARRIVE'), first = mine.find(e => e.type === 'DISPATCH'), exit = mine.find(e => e.type === 'EXIT');
    const blocks = mine.filter(e => e.type === 'BLOCK');
    const byKind = new Map<string, SimEvent[]>();
    for (const b of blocks) { const k = String(b.data!.reason); byKind.set(k, [...(byKind.get(k) ?? []), b]); }
    const preempts = mine.filter(e => e.type === 'PREEMPT');
    const lines = [
      `**${th.name}** (priority ${th.basePriority}) arrived at t=${th.arrive} ${ref(arrive)}${first ? `, first ran at t=${first.t} ${ref(first)}` : ', and never ran'}` +
        (exit ? `, and exited at t=${th.finish} with code ${th.exitCode} ${ref(exit)}.` : `; it is currently ${th.state}${th.block ? ` (${th.block.kind}${'m' in th.block ? ` ${th.block.m}` : 's' in th.block ? ` ${th.block.s}` : ''})` : ''}.`),
      `Time split: ${mt.cpu} ticks on CPU, ${mt.waiting} waiting for a CPU, ${mt.blocked} blocked.`
    ];
    if (byKind.size) lines.push(`Blocked ${blocks.length} time${blocks.length === 1 ? '' : 's'}: ${[...byKind].map(([k, v]) => `${v.length}× ${k} ${v.slice(0, 2).map(ref).join(' ')}`).join(', ')}.`);
    if (preempts.length) lines.push(`Preempted ${preempts.length} time${preempts.length === 1 ? '' : 's'} ${preempts.slice(0, 3).map(ref).join(' ')} (${preempts[0].data!.reason}).`);
    const worst = [...analysis.metrics.threads].sort((a, b) => b.waiting - a.waiting)[0];
    if (/slow|wait|late|long|why/.test(q) && worst.tid === th.tid && mt.waiting > 0) lines.push(`It has the longest waiting time of all threads.`);
    const fs = F.filter(f => f.tids.includes(th.tid));
    for (const f of fs) lines.push(findingText(f));
    return out('thread', lines.join('\n'), fs);
  }

  const topical: [string, RegExp, string[]][] = [
    ['deadlock', /deadlock|stuck|hang|frozen|cycle|stall|philosoph|forever/, ['deadlock', 'stall', 'max-ticks']],
    ['race', /race|counter|lost|wrong value|atomic|inconsistent|shared/, ['race']],
    ['memory', /memory|page|fault|thrash|frame|tlb|swap|segfault|segv|crash/, ['thrashing', 'segfault']],
    ['priority', /priorit|inversion|inherit|starv|aging|never runs/, ['priority-inversion', 'starvation']],
    ['scheduling', /slow|wait|latenc|schedul|throughput|convoy|fcfs|sjf|round robin|quantum|context switch|overhead/, ['convoy', 'switch-overhead', 'starvation', 'lock-contention']],
    ['locks', /lock|mutex|contend|contention|semaphore/, ['lock-contention', 'deadlock', 'stall', 'unlock-error']]
  ];
  for (const [intent, re, kinds] of topical) {
    if (!re.test(q)) continue;
    const fs = pick(...kinds);
    const lines: string[] = [];
    const met = analysis.metrics;
    if (intent === 'memory') lines.push(`${met.pageFaults} page faults over ${met.memAccesses} memory accesses${met.tlbHitRate !== null ? `, TLB hit rate ${(met.tlbHitRate * 100).toFixed(0)}%` : ''}, ${met.evictions} evictions (${met.writebacks} dirty write-backs), ${s.config.frames} frames with ${s.config.replacement.toUpperCase()}.`);
    if (intent === 'scheduling') {
      const worst = [...met.threads].sort((a, b) => b.waiting - a.waiting)[0];
      lines.push(`${s.config.scheduler.toUpperCase()}${s.config.scheduler === 'rr' ? ` (quantum ${s.config.quantum})` : ''}: average waiting ${met.avgWaiting?.toFixed(2) ?? 'n/a'}, average turnaround ${met.avgTurnaround?.toFixed(2) ?? 'n/a'}, ${met.contextSwitches} context switches, ${(met.switchOverhead * 100).toFixed(0)}% switch overhead.` +
        (worst ? ` ${worst.name} waited longest (${worst.waiting} ticks).` : ''));
    }
    if (intent === 'race') for (const v of met.vars) lines.push(`${v.name} = ${v.value}, expected ${v.expected}${v.value !== v.expected ? ` (${v.lost} lost)` : ''}.`);
    for (const f of fs) lines.push(findingText(f));
    if (!fs.length) lines.push(`I found no ${intent === 'race' ? 'data race' : intent === 'deadlock' ? 'deadlock or stall' : intent + ' problem'} in this run.`);
    return out(intent, lines.join('\n'), fs);
  }

  if (/try|experiment|fix|improve|suggest|what should|how can/.test(q)) {
    const fs = F.filter(f => f.experiment);
    if (!fs.length) return out('experiments', 'No experiment is suggested for this run: there are no findings with a configurable cause. Try changing the scheduler or frame count and compare the metrics.');
    return out('experiments', fs.map(f => `**${f.experiment!.label}** — ${f.experiment!.hypothesis} ${f.experiment!.result ? f.experiment!.result.summary : ''} (for: ${f.title}, ${f.evidence.slice(0, 3).map(id => `[#${id}]`).join(' ')})`).join('\n'), fs);
  }

  // default: summary
  const lines = [analysis.headline];
  if (F.length) for (const f of F.slice(0, 3)) lines.push(findingText(f));
  else lines.push('No deadlocks, races, crashes or performance pathologies were detected. Ask about a thread by name, a tick ("t=12"), or an event ("#42").');
  return out('summary', lines.join('\n'), F.slice(0, 3));
}
