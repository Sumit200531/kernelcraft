import { SAMPLES, CONFIG_KEYS, computeMetrics, type Config } from '@kernelcraft/engine';
import type { Controller, CenterTab } from './controller';

const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);

export const HELP: [string, string][] = [
  ['run', 'parse and execute the workload in the editor (Ctrl+Enter)'],
  ['step [n] · back [n]', 'move forward / backward n ticks (→ / ←)'],
  ['goto <t> · reset · end', 'jump to a tick, to 0, or to the end of the run'],
  ['play · pause · speed <n>', 'animate the run at n ticks per second (Space)'],
  ['ps', 'threads: state, priority, pc line, cpu / wait / blocked ticks'],
  ['mem · pt <process> · tlb [core]', 'physical frames, a page table, a TLB'],
  ['locks · sems · vars', 'mutexes, semaphores, shared variables'],
  ['events [type|category] [n]', 'last n events up to the cursor (e.g. `events mem 20`)'],
  ['explain <event id>', 'why an event happened, with the evidence chain'],
  ['why <thread> · ask <question>', 'ask the assistant (answers cite events as #id)'],
  ['findings · metrics · hash', 'analysis, metrics, trace fingerprint'],
  ['kill <thread> · signal <sem> · unlock <mutex>', 'operator actions at the cursor (recorded, replayable)'],
  ['set key=value …', 'change the config line and re-run (e.g. `set scheduler=sjf`)'],
  ['samples · sample <id>', 'list or load a sample workload'],
  ['save <title> · inputs', 'save this run as a recording · show recorded inputs'],
  ['tab timeline|memory|sync|metrics|lab · clear', 'switch view · clear the terminal']
];

export function execCommand(c: Controller, line: string) {
  const raw = line.trim();
  if (!raw) return;
  c.print('in', raw);
  const [cmd, ...args] = raw.split(/\s+/);
  const out = (t: string) => c.print('out', t);
  const err = (t: string) => c.print('err', t);
  const ok = (t: string) => c.print('ok', t);
  const m = c.machine;
  const need = () => { if (!m) { err('nothing is running — type `run`'); return false; } return true; };
  const findThread = (q: string) => {
    if (!m) return undefined;
    if (/^\d+$/.test(q)) return m.s.threads[+q];
    const lq = q.toLowerCase();
    return m.s.threads.find(t => t.name.toLowerCase() === lq) ?? m.s.threads.find(t => t.name.toLowerCase().startsWith(lq + '.')) ?? m.s.threads.find(t => t.name.toLowerCase().split('.')[1] === lq);
  };

  switch (cmd.toLowerCase()) {
    case 'help': case '?':
      for (const [k, v] of HELP) out(`${pad(k, 44)} ${v}`);
      break;
    case 'clear': c.clearTerm(); return;
    case 'run': if (c.run({ inputs: c.dirty ? [] : c.inputs, cursor: 'end' })) ok(`ran to t=${c.horizon}: ${c.full!.s.status} · ${c.fullEvents.length} events · trace ${c.hash}`); break;
    case 'step': case 's': if (need()) { c.step(+(args[0] ?? 1) || 1); out(`t=${c.cursor}`); } break;
    case 'back': case 'b': if (need()) { c.step(-(+(args[0] ?? 1) || 1)); out(`t=${c.cursor}`); } break;
    case 'goto': case 'g': if (need()) { if (!/^\d+$/.test(args[0] ?? '')) err('usage: goto <tick>'); else { c.seek(+args[0]); out(`t=${c.cursor}${+args[0] > c.horizon ? ` (the run ends at ${c.horizon})` : ''}`); } } break;
    case 'reset': if (need()) { c.seek(0); out('t=0'); } break;
    case 'end': if (need()) { c.seek(c.horizon); out(`t=${c.cursor}`); } break;
    case 'play': c.play(); break;
    case 'pause': c.pause(); break;
    case 'speed': if (!/^\d+$/.test(args[0] ?? '')) err('usage: speed <ticks per second>'); else { c.setSpeed(+args[0]); out(`${c.speed} ticks/s`); } break;

    case 'ps': case 'threads': {
      if (!need()) break;
      const met = computeMetrics(m!);
      out(`${pad('TID', 4)}${pad('THREAD', 20)}${pad('STATE', 12)}${pad('PRI', 5)}${pad('LINE', 6)}${lpad('CPU', 5)}${lpad('WAIT', 6)}${lpad('BLK', 6)}  WAITING ON`);
      for (const t of m!.s.threads) {
        const op = m!.ops[t.tid][t.pc];
        const b = t.block;
        const on = !b ? '' : b.kind === 'lock' ? `mutex ${b.m}` : b.kind === 'sem' ? `sem ${b.s}` : b.kind === 'fault' ? `page ${b.vpn} → t=${b.until}` : `${b.kind} → t=${b.until}`;
        const mt = met.threads[t.tid];
        out(`${pad(t.tid, 4)}${pad(t.name, 20)}${pad(t.state + (t.state === 'terminated' && t.exitCode ? `(${t.exitCode})` : ''), 12)}${pad(t.effPriority + (t.effPriority !== t.basePriority ? '*' : ''), 5)}${pad(t.state === 'terminated' ? '-' : op?.line ?? '-', 6)}${lpad(mt.cpu, 5)}${lpad(mt.waiting, 6)}${lpad(mt.blocked, 6)}  ${on}`);
      }
      break;
    }
    case 'mem': case 'frames': {
      if (!need()) break;
      const s = m!.s;
      out(`${s.config.frames} frames · ${s.config.replacement.toUpperCase()} · page size ${s.config.pageSize} · faults ${s.counters.faults} · evictions ${s.counters.evictions}`);
      s.frames.forEach((f, i) => {
        if (f.pid < 0) { out(`  [${lpad(i, 2)}] free`); return; }
        const pte = s.processes[f.pid].pageTable[f.vpn];
        out(`  [${lpad(i, 2)}] ${pad(`${s.processes[f.pid].name}:${f.vpn}`, 16)} ${f.loading ? `loading until t=${pte.readyAt}` : `${pte.dirty ? 'D' : '-'}${pte.ref ? 'R' : '-'} loaded t=${pte.loadedAt} used t=${pte.lastUse}`}`);
      });
      break;
    }
    case 'pt': {
      if (!need()) break;
      const p = m!.s.processes.find(x => x.name === args[0]) ?? (/^\d+$/.test(args[0] ?? '') ? m!.s.processes[+args[0]] : undefined);
      if (!p) { err(`usage: pt <process>; processes: ${m!.s.processes.map(x => x.name).join(', ')}`); break; }
      out(`page table of ${p.name} (${p.pages} pages)`);
      p.pageTable.forEach((e, vpn) => out(`  vpn ${lpad(vpn, 2)} → ${e.present ? `frame ${e.frame}` : e.loading ? `loading → frame ${e.frame}` : 'not present'}${e.present ? `  ${e.dirty ? 'dirty' : 'clean'}${e.ref ? ' ref' : ''}` : ''}`));
      break;
    }
    case 'tlb': {
      if (!need()) break;
      const cores = args[0] !== undefined ? [m!.s.cores[+args[0]]].filter(Boolean) : m!.s.cores;
      for (const core of cores) out(`core ${core.id} TLB (${core.tlb.length}/${m!.s.config.tlb}): ${core.tlb.map(e => `${m!.s.processes[e.pid].name}:${e.vpn}→${e.frame}`).join('  ') || 'empty'}`);
      out(`hits ${m!.s.counters.tlbHits} · misses ${m!.s.counters.tlbMisses}`);
      break;
    }
    case 'locks': {
      if (!need()) break;
      const ms = Object.values(m!.s.mutexes);
      if (!ms.length) out('no mutexes');
      for (const x of ms) out(`${pad(x.name, 12)} ${x.owner >= 0 ? `held by ${m!.s.threads[x.owner].name}` : 'free'}${x.waiters.length ? ` · waiters: ${x.waiters.map(w => m!.s.threads[w].name).join(', ')}` : ''} · ${x.acquisitions} acquisitions, ${x.contentions} contended`);
      if (m!.s.deadlock) err(`DEADLOCK: ${m!.s.deadlock.tids.map(t => m!.s.threads[t].name).join(' → ')} on ${m!.s.deadlock.resources.join(', ')}`);
      break;
    }
    case 'sems': {
      if (!need()) break;
      const ss = Object.values(m!.s.sems);
      if (!ss.length) out('no semaphores');
      for (const x of ss) out(`${pad(x.name, 12)} value ${x.value} (initial ${x.initial})${x.waiters.length ? ` · waiters: ${x.waiters.map(w => m!.s.threads[w].name).join(', ')}` : ''}`);
      break;
    }
    case 'vars': {
      if (!need()) break;
      const vs = Object.values(m!.s.vars);
      if (!vs.length) out('no shared variables');
      for (const v of vs) {
        const exp = v.initial + v.expectedDelta;
        out(`${pad(v.name, 12)} = ${v.value}  (expected ${exp}${v.value !== exp ? `, ${Math.abs(exp - v.value)} lost` : ''}) · lockset ${v.lsState}${v.lockset ? ` {${v.lockset.join(', ')}}` : ''}${v.raceReported ? ' · RACE' : ''}`);
      }
      break;
    }
    case 'events': case 'log': {
      if (!need()) break;
      let n = 15; let filter: string | undefined;
      for (const a of args) { if (/^\d+$/.test(a)) n = Math.min(500, +a); else filter = a.toUpperCase(); }
      const cats: Record<string, string[]> = { MEM: ['MEM_ACCESS', 'TLB_HIT', 'TLB_MISS', 'TLB_FLUSH', 'TLB_SHOOTDOWN', 'PAGE_FAULT', 'PAGE_EVICT', 'PAGE_IN', 'SEGFAULT'], SYNC: ['LOCK_ACQUIRE', 'LOCK_CONTEND', 'LOCK_HANDOFF', 'LOCK_RELEASE', 'SEM_WAIT', 'SEM_BLOCK', 'SEM_SIGNAL', 'SEM_HANDOFF', 'DEADLOCK', 'STALL'], SCHED: ['ARRIVE', 'DISPATCH', 'PREEMPT', 'BLOCK', 'WAKE', 'EXIT', 'SWITCH_START', 'YIELD'] };
      const evs = m!.visibleEvents().filter(e => !filter || (cats[filter] ? cats[filter].includes(e.type) : e.type.includes(filter)));
      for (const e of evs.slice(-n)) out(`#${pad(e.id, 5)} t=${pad(e.t, 5)} ${pad(e.type, 15)} ${e.msg}`);
      if (!evs.length) out('no matching events up to the cursor');
      break;
    }
    case 'explain': {
      const id = +(args[0] ?? '').replace('#', '');
      if (!c.full || !Number.isInteger(id) || !c.fullEvents[id]) { err('usage: explain <event id> (see `events`)'); break; }
      c.selectEvent(id);
      const ex = c.explanation!;
      out(`#${id} ${c.fullEvents[id].msg}`);
      out(ex.text.replace(/\*\*/g, ''));
      break;
    }
    case 'why': case 'ask': {
      const q = cmd.toLowerCase() === 'why' ? `why ${args.join(' ')}` : args.join(' ');
      if (!args.length) { err(`usage: ${cmd} <${cmd === 'why' ? 'thread' : 'question'}>`); break; }
      void c.ask(q);
      out('→ answered in the Assistant panel');
      break;
    }
    case 'findings': case 'analyze': {
      if (!c.analysis) { err('nothing analysed yet'); break; }
      out(c.analysis.headline);
      for (const f of c.analysis.findings) {
        out(`[${f.severity}] ${f.title}  (evidence ${f.evidence.slice(0, 5).map(i => '#' + i).join(' ')})`);
        if (f.experiment?.result) out(`   try ${f.experiment.label}: ${f.experiment.result.summary}`);
      }
      c.setSide('findings');
      break;
    }
    case 'metrics': {
      if (!need()) break;
      const mt = computeMetrics(m!);
      const f = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d));
      out(`t=${mt.ticks} · completed ${mt.completed}/${mt.threads.length} · avg wait ${f(mt.avgWaiting)} · avg turnaround ${f(mt.avgTurnaround)} · avg response ${f(mt.avgResponse)}`);
      out(`CPU util ${mt.cpuUtilization.map(u => (u * 100).toFixed(0) + '%').join(' / ')} · switches ${mt.contextSwitches} (${(mt.switchOverhead * 100).toFixed(0)}% overhead) · preemptions ${mt.preemptions}`);
      out(`memory: ${mt.memAccesses} accesses · ${mt.pageFaults} faults · TLB hit rate ${mt.tlbHitRate === null ? 'n/a' : (mt.tlbHitRate * 100).toFixed(0) + '%'} · ${mt.evictions} evictions · ${mt.writebacks} write-backs`);
      break;
    }
    case 'hash': out(`trace ${c.hash} · ${c.fullEvents.length} events · ${c.inputs.length} recorded input(s)`); break;
    case 'inputs': if (!c.inputs.length) out('no operator inputs recorded'); for (const i of c.inputs) out(`t=${i.at}  ${JSON.stringify(i.action)}`); break;
    case 'kill': {
      if (!need()) break;
      const t = findThread(args[0] ?? '');
      if (!t) { err('usage: kill <tid | thread name>'); break; }
      const e = c.inject({ type: 'kill', tid: t.tid });
      if (e) err(e); else ok(`killed ${t.name} at t=${c.cursor - 1}; the future was re-simulated (trace ${c.hash})`);
      break;
    }
    case 'signal': {
      if (!need()) break;
      const e = c.inject({ type: 'signal', s: args[0] ?? '' });
      if (e) err(e); else ok(`signal(${args[0]}) at t=${c.cursor - 1}; re-simulated (trace ${c.hash})`);
      break;
    }
    case 'unlock': {
      if (!need()) break;
      const e = c.inject({ type: 'unlock', m: args[0] ?? '' });
      if (e) err(e); else ok(`force-released ${args[0]} at t=${c.cursor - 1}; re-simulated (trace ${c.hash})`);
      break;
    }
    case 'set': {
      if (!args.length) { err(`usage: set key=value …  keys: ${Object.keys(CONFIG_KEYS).join(', ')}`); break; }
      const patch: Record<string, unknown> = {};
      let bad = false;
      for (const a of args) {
        const [k, v] = a.split('=');
        const spec = CONFIG_KEYS[k?.toLowerCase()];
        if (!spec || v === undefined) { err(`unknown setting \`${a}\``); bad = true; continue; }
        patch[spec.key] = spec.kind === 'int' ? Number(v) : spec.kind === 'bool' ? ['true', 'on', 'yes', '1'].includes(v.toLowerCase()) : v.toLowerCase();
      }
      if (bad) break;
      if (c.applyPatch(patch as Partial<Config>)) ok(`config updated; ran to t=${c.horizon}: ${c.full!.s.status} (trace ${c.hash})`);
      break;
    }
    case 'samples': for (const s of SAMPLES) out(`${pad(s.id, 20)} ${pad(s.topic, 20)} ${s.title}`); break;
    case 'sample': {
      if (!args[0]) { err('usage: sample <id> (see `samples`)'); break; }
      if (c.loadSample(args[0])) ok(`loaded ${args[0]}`); else err(`no sample ${args[0]}`);
      break;
    }
    case 'save': {
      const title = args.join(' ').trim();
      if (!title) { err('usage: save <title>'); break; }
      void c.saveRecording(title).then(msg => { c.print('ok', msg); c.emit(); });
      break;
    }
    case 'tab': {
      const tabs: CenterTab[] = ['timeline', 'memory', 'sync', 'metrics', 'lab'];
      if (!tabs.includes(args[0] as CenterTab)) { err(`usage: tab ${tabs.join('|')}`); break; }
      c.setTab(args[0] as CenterTab);
      break;
    }
    default: err(`unknown command \`${cmd}\` — type \`help\``);
  }
  c.emit();
}
