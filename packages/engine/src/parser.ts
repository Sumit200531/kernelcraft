import { DEFAULT_CONFIG, type Config, type Diagnostic, type Op, type ProcessSpec, type ThreadSpec, type Workload } from './types.js';

/**
 * Workload language (.kc)
 *
 *   config scheduler=rr quantum=4 cores=1 frames=8 replacement=lru
 *   mutex m1 m2
 *   sem slots=3
 *   shared counter=0
 *
 *   process web priority=2 arrive=0 pages=8
 *     thread main
 *       compute 5
 *       load 0x120
 *       syscall io 4
 *       lock m1
 *       inc counter
 *       unlock m1
 *       repeat 3
 *         compute 2
 *       end
 *
 * Indentation is cosmetic: `thread` attaches to the latest `process`, ops attach
 * to the latest `thread` (an implicit `main` thread is created if needed).
 */

export interface ParseResult { workload: Workload | null; diagnostics: Diagnostic[] }

const MAX_OPS_PER_THREAD = 20000;
const IDENT = /^[A-Za-z_][A-Za-z0-9_\-]*$/;

export const CONFIG_KEYS: Record<string, { kind: 'int' | 'bool' | 'enum'; min?: number; max?: number; values?: string[]; key: keyof Config }> = {
  cores: { kind: 'int', min: 1, max: 4, key: 'cores' },
  scheduler: { kind: 'enum', values: ['fcfs', 'sjf', 'srtf', 'priority', 'rr'], key: 'scheduler' },
  quantum: { kind: 'int', min: 1, max: 1000, key: 'quantum' },
  preempt: { kind: 'bool', key: 'preempt' },
  aging: { kind: 'int', min: 0, max: 10000, key: 'aging' },
  inherit: { kind: 'bool', key: 'inherit' },
  cs: { kind: 'int', min: 0, max: 50, key: 'cs' },
  frames: { kind: 'int', min: 1, max: 256, key: 'frames' },
  pagesize: { kind: 'int', min: 16, max: 65536, key: 'pageSize' },
  replacement: { kind: 'enum', values: ['fifo', 'lru', 'clock'], key: 'replacement' },
  tlb: { kind: 'int', min: 0, max: 64, key: 'tlb' },
  tlbpenalty: { kind: 'int', min: 0, max: 20, key: 'tlbPenalty' },
  fault: { kind: 'int', min: 1, max: 500, key: 'fault' },
  writeback: { kind: 'int', min: 0, max: 500, key: 'writeback' },
  starve: { kind: 'int', min: 0, max: 100000, key: 'starve' },
  deadlock: { kind: 'enum', values: ['halt', 'continue'], key: 'deadlock' },
  maxticks: { kind: 'int', min: 1, max: 200000, key: 'maxTicks' }
};

function parseNumber(tok: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
  if (/^0b[01]+$/i.test(tok)) return parseInt(tok.slice(2), 2);
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^\d+k$/i.test(tok)) return parseInt(tok, 10) * 1024;
  return null;
}

interface Tok { text: string; col: number }
function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push({ text: m[0], col: m.index + 1 });
  return out;
}

export function parseWorkload(source: string): ParseResult {
  const diags: Diagnostic[] = [];
  const err = (line: number, col: number, message: string) => diags.push({ line, col, message, severity: 'error' });
  const warn = (line: number, col: number, message: string) => diags.push({ line, col, message, severity: 'warning' });

  if (typeof source !== 'string') return { workload: null, diagnostics: [{ line: 1, col: 1, message: 'Workload source must be text.', severity: 'error' }] };
  if (source.length > 200_000) return { workload: null, diagnostics: [{ line: 1, col: 1, message: 'Workload is too large (max 200,000 characters).', severity: 'error' }] };

  const config: Config = { ...DEFAULT_CONFIG };
  const processes: ProcessSpec[] = [];
  const mutexes: string[] = [];
  const semaphores: Record<string, number> = {};
  const shared: Record<string, number> = {};
  const names = new Set<string>();

  let proc: ProcessSpec | null = null;
  let thread: ThreadSpec | null = null;
  // repeat stack: each frame collects ops until its matching `end`
  let stack: { count: number; ops: Op[]; line: number }[] = [];
  const pendingRefs: { kind: 'mutex' | 'sem' | 'var'; name: string; line: number; col: number }[] = [];

  const target = (): Op[] | null => (stack.length ? stack[stack.length - 1].ops : thread ? thread.ops : null);
  const closeThread = () => {
    if (stack.length) { err(stack[stack.length - 1].line, 1, '`repeat` block is missing its `end`.'); stack = []; }
    thread = null;
  };
  const ensureThread = (line: number): Op[] | null => {
    if (stack.length) return stack[stack.length - 1].ops;
    if (thread) return thread.ops;
    if (!proc) { err(line, 1, 'Instructions must appear inside a `process` (and optionally a `thread`).'); return null; }
    thread = { name: 'main', arrive: proc.arrive, priority: proc.priority, ops: [], line };
    proc.threads.push(thread);
    return thread.ops;
  };
  const kv = (tok: Tok, line: number): [string, string] | null => {
    const i = tok.text.indexOf('=');
    if (i <= 0 || i === tok.text.length - 1) { err(line, tok.col, `Expected key=value, got \`${tok.text}\`.`); return null; }
    return [tok.text.slice(0, i).toLowerCase(), tok.text.slice(i + 1)];
  };
  const intIn = (s: string, min: number, max: number, line: number, col: number, what: string): number | null => {
    const n = parseNumber(s);
    if (n === null) { err(line, col, `${what} must be a number, got \`${s}\`.`); return null; }
    if (n < min || n > max) { err(line, col, `${what} must be between ${min} and ${max}, got ${n}.`); return null; }
    return n;
  };
  const declare = (name: string, line: number, col: number, kind: string): boolean => {
    if (!IDENT.test(name)) { err(line, col, `Invalid ${kind} name \`${name}\`. Use letters, digits, _ or -.`); return false; }
    if (names.has(name)) { err(line, col, `\`${name}\` is already declared.`); return false; }
    names.add(name); return true;
  };

  const lines = source.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1;
    const raw = lines[li].replace(/(#|\/\/).*$/, '');
    const toks = tokenize(raw);
    if (!toks.length) continue;
    const head = toks[0].text.toLowerCase();
    const args = toks.slice(1);

    switch (head) {
      case 'config': {
        if (proc) warn(lineNo, toks[0].col, '`config` usually goes at the top; it still applies to the whole workload.');
        for (const a of args) {
          const p = kv(a, lineNo); if (!p) continue;
          const spec = CONFIG_KEYS[p[0]];
          if (!spec) { err(lineNo, a.col, `Unknown config key \`${p[0]}\`. Known: ${Object.keys(CONFIG_KEYS).join(', ')}.`); continue; }
          if (spec.kind === 'int') {
            const n = intIn(p[1], spec.min!, spec.max!, lineNo, a.col, p[0]);
            if (n !== null) {
              if (spec.key === 'pageSize' && (n & (n - 1)) !== 0) { err(lineNo, a.col, 'pagesize must be a power of two.'); continue; }
              (config as unknown as Record<string, unknown>)[spec.key] = n;
            }
          } else if (spec.kind === 'bool') {
            const v = p[1].toLowerCase();
            if (['true', 'on', 'yes', '1'].includes(v)) (config as unknown as Record<string, unknown>)[spec.key] = true;
            else if (['false', 'off', 'no', '0'].includes(v)) (config as unknown as Record<string, unknown>)[spec.key] = false;
            else err(lineNo, a.col, `${p[0]} must be true or false.`);
          } else {
            const v = p[1].toLowerCase();
            if (!spec.values!.includes(v)) err(lineNo, a.col, `${p[0]} must be one of ${spec.values!.join(', ')}.`);
            else (config as unknown as Record<string, unknown>)[spec.key] = v;
          }
        }
        break;
      }
      case 'mutex': case 'lock_t': {
        if (!args.length) err(lineNo, toks[0].col, '`mutex` needs at least one name.');
        for (const a of args) if (declare(a.text, lineNo, a.col, 'mutex')) mutexes.push(a.text);
        break;
      }
      case 'sem': case 'semaphore': {
        if (!args.length) err(lineNo, toks[0].col, '`sem` needs name=initial, e.g. `sem slots=3`.');
        for (const a of args) {
          const p = a.text.includes('=') ? kv(a, lineNo) : [a.text, '0'] as [string, string];
          if (!p) continue;
          const name = a.text.split('=')[0];
          const n = intIn(p[1], 0, 1_000_000, lineNo, a.col, `semaphore ${name}`);
          if (n !== null && declare(name, lineNo, a.col, 'semaphore')) semaphores[name] = n;
        }
        break;
      }
      case 'shared': case 'var': {
        if (!args.length) err(lineNo, toks[0].col, '`shared` needs name=value, e.g. `shared counter=0`.');
        for (const a of args) {
          const p = a.text.includes('=') ? kv(a, lineNo) : [a.text, '0'] as [string, string];
          if (!p) continue;
          const name = a.text.split('=')[0];
          const n = intIn(p[1], -1_000_000_000, 1_000_000_000, lineNo, a.col, `shared ${name}`);
          if (n !== null && declare(name, lineNo, a.col, 'shared variable')) shared[name] = n;
        }
        break;
      }
      case 'process': case 'proc': {
        closeThread();
        const name = args[0]?.text;
        if (!name || name.includes('=')) { err(lineNo, toks[0].col, '`process` needs a name, e.g. `process web priority=1`.'); proc = null; break; }
        if (!declare(name, lineNo, args[0].col, 'process')) { proc = null; break; }
        proc = { name, arrive: 0, priority: 10, pages: 8, threads: [], line: lineNo };
        for (const a of args.slice(1)) {
          const p = kv(a, lineNo); if (!p) continue;
          if (p[0] === 'arrive') { const n = intIn(p[1], 0, 1_000_000, lineNo, a.col, 'arrive'); if (n !== null) proc.arrive = n; }
          else if (p[0] === 'priority') { const n = intIn(p[1], 0, 99, lineNo, a.col, 'priority'); if (n !== null) proc.priority = n; }
          else if (p[0] === 'pages') { const n = intIn(p[1], 1, 4096, lineNo, a.col, 'pages'); if (n !== null) proc.pages = n; }
          else err(lineNo, a.col, `Unknown process attribute \`${p[0]}\` (use arrive, priority, pages).`);
        }
        processes.push(proc);
        break;
      }
      case 'thread': {
        if (!proc) { err(lineNo, toks[0].col, '`thread` must follow a `process`.'); break; }
        closeThread();
        const name = args[0]?.text;
        if (!name || name.includes('=') || !IDENT.test(name)) { err(lineNo, toks[0].col, '`thread` needs a name, e.g. `thread worker`.'); break; }
        if (proc.threads.some(t => t.name === name)) { err(lineNo, args[0].col, `Process ${proc.name} already has a thread named ${name}.`); break; }
        thread = { name, arrive: proc.arrive, priority: proc.priority, ops: [], line: lineNo };
        for (const a of args.slice(1)) {
          const p = kv(a, lineNo); if (!p) continue;
          if (p[0] === 'arrive') { const n = intIn(p[1], 0, 1_000_000, lineNo, a.col, 'arrive'); if (n !== null) thread.arrive = Math.max(n, proc.arrive); if (n !== null && n < proc.arrive) warn(lineNo, a.col, `Thread cannot start before its process (arrive=${proc.arrive}); using ${proc.arrive}.`); }
          else if (p[0] === 'priority') { const n = intIn(p[1], 0, 99, lineNo, a.col, 'priority'); if (n !== null) thread.priority = n; }
          else err(lineNo, a.col, `Unknown thread attribute \`${p[0]}\` (use arrive, priority).`);
        }
        proc.threads.push(thread);
        break;
      }
      case 'repeat': case 'loop': {
        const ops = ensureThread(lineNo); if (!ops) break;
        const n = args[0] ? intIn(args[0].text, 1, 10000, lineNo, args[0].col, 'repeat count') : null;
        if (!args[0]) err(lineNo, toks[0].col, '`repeat` needs a count, e.g. `repeat 3`.');
        stack.push({ count: n ?? 1, ops: [], line: lineNo });
        break;
      }
      case 'end': {
        if (!stack.length) { err(lineNo, toks[0].col, '`end` without a matching `repeat`.'); break; }
        const frame = stack.pop()!;
        const dest = target();
        if (!dest) break;
        // check the size before expanding, so nested repeats can't allocate millions of ops
        if (dest.length + frame.ops.length * frame.count > MAX_OPS_PER_THREAD) {
          err(frame.line, 1, `This repeat expands to more than ${MAX_OPS_PER_THREAD} instructions; reduce repeat counts.`);
          return { workload: null, diagnostics: diags };
        }
        for (let i = 0; i < frame.count; i++) for (const op of frame.ops) dest.push(op);
        break;
      }
      default: {
        const ops = ensureThread(lineNo); if (!ops) break;
        const op = parseOp(head, args, lineNo, toks[0].col, err, pendingRefs);
        if (op) for (const o of op) ops.push(o);
      }
    }
    const cur = thread as ThreadSpec | null;
    if (cur && cur.ops.length > MAX_OPS_PER_THREAD) {
      err(lineNo, 1, `Thread ${cur.name} expands to more than ${MAX_OPS_PER_THREAD} instructions; reduce repeat counts.`);
      return { workload: null, diagnostics: diags };
    }
  }
  closeThread();

  // resolve references
  for (const r of pendingRefs) {
    if (r.kind === 'mutex' && !mutexes.includes(r.name)) err(r.line, r.col, `Unknown mutex \`${r.name}\`. Declare it with \`mutex ${r.name}\`.`);
    if (r.kind === 'sem' && !(r.name in semaphores)) err(r.line, r.col, `Unknown semaphore \`${r.name}\`. Declare it with \`sem ${r.name}=1\`.`);
    if (r.kind === 'var' && !(r.name in shared)) err(r.line, r.col, `Unknown shared variable \`${r.name}\`. Declare it with \`shared ${r.name}=0\`.`);
  }
  if (!processes.length) err(1, 1, 'Add at least one `process`.');
  // an empty thread whose lines already produced errors is a cascade: report only the root cause
  const errorLines = diags.filter(d => d.severity === 'error').map(d => d.line);
  processes.forEach((p, i) => {
    const end = processes[i + 1]?.line ?? Infinity;
    const hadErrors = errorLines.some(l => l >= p.line && l < end);
    if (!p.threads.length && !hadErrors) err(p.line, 1, `Process ${p.name} has no instructions.`);
    for (const t of p.threads) {
      if (!t.ops.length && !hadErrors) err(t.line, 1, `Thread ${p.name}.${t.name} has no instructions.`);
      for (const o of t.ops) if (o.k === 'mem' && o.addr >= p.pages * config.pageSize) {
        warn(o.line, 1, `Address 0x${o.addr.toString(16)} is outside ${p.name}'s ${p.pages} pages (${p.pages * config.pageSize} bytes); it will SEGFAULT.`);
      }
    }
  });
  const threadCount = processes.reduce((a, p) => a + p.threads.length, 0);
  if (threadCount > 64) err(1, 1, `Too many threads (${threadCount}); the limit is 64.`);

  // de-duplicate warnings emitted once per expanded repeat iteration
  const seen = new Set<string>();
  const unique = diags.filter(d => { const k = `${d.severity}|${d.line}|${d.col}|${d.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => a.line - b.line || a.col - b.col);
  const hasErr = unique.some(d => d.severity === 'error');
  return { workload: hasErr ? null : { config, processes, mutexes, semaphores, shared }, diagnostics: unique };
}

function parseOp(
  head: string, args: Tok[], line: number, col: number,
  err: (l: number, c: number, m: string) => void,
  refs: { kind: 'mutex' | 'sem' | 'var'; name: string; line: number; col: number }[]
): Op[] | null {
  const need = (n: number, usage: string) => { if (args.length < n) { err(line, col, `Usage: ${usage}`); return false; } return true; };
  const int = (i: number, min: number, max: number, what: string): number | null => {
    const t = args[i]; const n = t ? parseNumber(t.text) : null;
    if (n === null) { err(line, t ? t.col : col, `${what} must be a number.`); return null; }
    if (n < min || n > max) { err(line, t.col, `${what} must be between ${min} and ${max}.`); return null; }
    return n;
  };
  const ref = (kind: 'mutex' | 'sem' | 'var', i: number) => { const t = args[i]; refs.push({ kind, name: t.text, line, col: t.col }); return t.text; };

  switch (head) {
    case 'compute': case 'cpu': case 'run': {
      if (!need(1, 'compute <ticks>')) return null;
      const n = int(0, 1, 100000, 'compute ticks'); return n === null ? null : [{ k: 'compute', n, line }];
    }
    case 'load': case 'read': case 'store': case 'write': {
      if (!need(1, `${head} <address>`)) return null;
      const a = int(0, 0, 0x7fffffff, 'address'); if (a === null) return null;
      return [{ k: 'mem', write: head === 'store' || head === 'write', addr: a, line }];
    }
    case 'syscall': {
      if (!need(1, 'syscall io <ticks> | syscall sleep <ticks> | syscall getpid')) return null;
      const call = args[0].text.toLowerCase();
      if (call === 'getpid') return [{ k: 'sys', call: 'getpid', n: 0, line }];
      if (call !== 'io' && call !== 'sleep') { err(line, args[0].col, `Unknown syscall \`${call}\` (use io, sleep, getpid).`); return null; }
      if (args.length < 2) { err(line, col, `Usage: syscall ${call} <ticks>`); return null; }
      const tmp = args.slice(1); const n = parseNumber(tmp[0].text);
      if (n === null || n < 1 || n > 100000) { err(line, tmp[0].col, 'syscall duration must be between 1 and 100000 ticks.'); return null; }
      return [{ k: 'sys', call, n, line }];
    }
    case 'io': case 'sleep': {
      if (!need(1, `${head} <ticks>`)) return null;
      const n = int(0, 1, 100000, `${head} ticks`); return n === null ? null : [{ k: 'sys', call: head, n, line }];
    }
    case 'lock': case 'acquire': if (!need(1, 'lock <mutex>')) return null; return [{ k: 'lock', m: ref('mutex', 0), line }];
    case 'unlock': case 'release': if (!need(1, 'unlock <mutex>')) return null; return [{ k: 'unlock', m: ref('mutex', 0), line }];
    case 'wait': case 'p': case 'down': if (!need(1, 'wait <semaphore>')) return null; return [{ k: 'wait', s: ref('sem', 0), line }];
    case 'signal': case 'post': case 'v': case 'up': if (!need(1, 'signal <semaphore>')) return null; return [{ k: 'signal', s: ref('sem', 0), line }];
    case 'inc': case 'dec': {
      if (!need(1, `${head} <shared>`)) return null;
      const v = ref('var', 0); const d = head === 'inc' ? 1 : -1;
      // non-atomic read-modify-write: three preemptible micro-ops
      return [{ k: 'ldv', v, line }, { k: 'add', v, d, line }, { k: 'stv', v, line }];
    }
    case 'atomic_inc': case 'atomic_dec': {
      if (!need(1, `${head} <shared>`)) return null;
      return [{ k: 'atomic', v: ref('var', 0), d: head === 'atomic_inc' ? 1 : -1, line }];
    }
    case 'yield': return [{ k: 'yield', line }];
    case 'exit': {
      const code = args[0] ? int(0, 0, 255, 'exit code') : 0;
      return code === null ? null : [{ k: 'exit', code, line }];
    }
    default:
      err(line, col, `Unknown instruction \`${head}\`. Try compute, load, store, syscall, lock, unlock, wait, signal, inc, atomic_inc, yield, exit, repeat.`);
      return null;
  }
}
