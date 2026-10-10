/**
 * KernelCraft engine types.
 *
 * Time model: the simulation advances in discrete ticks. Tick `t` covers the
 * interval [t, t+1). A thread that executes its last instruction during tick t
 * completes at time t+1. All state lives in plain JSON-compatible objects so a
 * machine can be snapshotted with structuredClone and restored exactly.
 */

export type SchedulerKind = 'fcfs' | 'sjf' | 'srtf' | 'priority' | 'rr';
export type ReplacementKind = 'fifo' | 'lru' | 'clock';
export type DeadlockPolicy = 'halt' | 'continue';

export interface Config {
  cores: number;              // 1..4
  scheduler: SchedulerKind;
  quantum: number;            // RR time slice in ticks
  preempt: boolean;           // priority scheduling: preemptive when true
  aging: number;              // priority aging: improve effective priority by 1 every N ready ticks (0 = off)
  inherit: boolean;           // priority inheritance on mutexes
  cs: number;                 // context-switch cost in ticks
  frames: number;             // physical frames
  pageSize: number;           // bytes per page
  replacement: ReplacementKind;
  tlb: number;                // TLB entries per core (0 = no TLB)
  tlbPenalty: number;         // extra ticks on a TLB miss that hits the page table
  fault: number;              // ticks to service a page fault (disk read)
  writeback: number;          // extra ticks to write back a dirty victim
  starve: number;             // ticks continuously READY before a starvation warning (0 = off)
  deadlock: DeadlockPolicy;
  maxTicks: number;           // hard stop
}

export const DEFAULT_CONFIG: Config = {
  cores: 1, scheduler: 'rr', quantum: 4, preempt: false, aging: 0, inherit: false,
  cs: 0, frames: 8, pageSize: 256, replacement: 'lru', tlb: 4, tlbPenalty: 1,
  fault: 6, writeback: 4, starve: 0, deadlock: 'halt', maxTicks: 5000
};

/* ------------------------------------------------------------------ program */

export type Op =
  | { k: 'compute'; n: number; line: number }
  | { k: 'mem'; write: boolean; addr: number; line: number }
  | { k: 'sys'; call: 'io' | 'sleep' | 'getpid'; n: number; line: number }
  | { k: 'lock'; m: string; line: number }
  | { k: 'unlock'; m: string; line: number }
  | { k: 'wait'; s: string; line: number }
  | { k: 'signal'; s: string; line: number }
  | { k: 'ldv'; v: string; line: number }
  | { k: 'add'; v: string; d: number; line: number }
  | { k: 'stv'; v: string; line: number }
  | { k: 'atomic'; v: string; d: number; line: number }
  | { k: 'yield'; line: number }
  | { k: 'exit'; code: number; line: number };

export interface ThreadSpec { name: string; arrive: number; priority: number; ops: Op[]; line: number }
export interface ProcessSpec { name: string; arrive: number; priority: number; pages: number; threads: ThreadSpec[]; line: number }
export interface Workload {
  config: Config;
  processes: ProcessSpec[];
  mutexes: string[];
  semaphores: Record<string, number>;
  shared: Record<string, number>;
}

export interface Diagnostic { line: number; col: number; message: string; severity: 'error' | 'warning' }

/* -------------------------------------------------------------------- state */

export type ThreadState = 'new' | 'ready' | 'running' | 'blocked' | 'terminated';
export type BlockReason =
  | { kind: 'io'; until: number }
  | { kind: 'sleep'; until: number }
  | { kind: 'fault'; until: number; vpn: number }
  | { kind: 'lock'; m: string }
  | { kind: 'sem'; s: string };

export interface ThreadRT {
  tid: number;
  pid: number;
  name: string;              // "proc.thread"
  state: ThreadState;
  basePriority: number;
  effPriority: number;       // after aging / inheritance
  agingBoost: number;        // priority levels gained by waiting (reset on dispatch)
  pendingDelta: number;      // delta computed by the last `add` micro-op
  arrive: number;
  pc: number;                // index into ops
  opRem: number;             // remaining ticks of current op (-1 = not started)
  opPhase: number;           // sub-state for multi-phase ops (syscalls)
  block: BlockReason | null;
  core: number;              // core currently running on (-1)
  quantumUsed: number;
  enqSeq: number;            // ready-queue order key
  readySince: number;
  starvationWarned: boolean;
  reg: number;               // private register used by ldv/add/stv
  loadedVersion: number;     // version of the variable observed by the last ldv
  loadedEvent: number;       // event id of the last ldv
  held: string[];            // mutexes (and binary semaphores) currently held
  // accounting
  firstRun: number;          // -1 until first dispatched
  finish: number;            // -1 until terminated
  exitCode: number;
  cpuTicks: number;
  readyTicks: number;
  blockedTicks: number;
  switchTicks: number;
  faults: number;
}

export interface ProcessRT {
  pid: number;
  name: string;
  pages: number;
  state: 'new' | 'active' | 'terminated';
  pageTable: PTE[];
  exitCode: number;
  finish: number;
}

export interface PTE { present: boolean; frame: number; dirty: boolean; ref: boolean; loadedAt: number; lastUse: number; loading: boolean; readyAt: number }
export interface Frame { pid: number; vpn: number; loading: boolean }   // pid = -1 when free
export interface TLBEntry { pid: number; vpn: number; frame: number; lastUse: number }

export interface CoreRT {
  id: number;
  running: number;           // tid or -1
  switching: { tid: number; rem: number } | null;
  lastTid: number;
  lastPid: number;
  tlb: TLBEntry[];
  busyTicks: number;
  switchTicks: number;
  idleTicks: number;
}

export interface MutexRT { name: string; owner: number; waiters: number[]; acquisitions: number; contentions: number }
export interface SemRT { name: string; value: number; initial: number; waiters: number[] }
export interface VarRT {
  name: string; value: number; version: number; initial: number;
  // lockset (Eraser) state
  lsState: 'virgin' | 'exclusive' | 'shared' | 'shared-modified';
  lsOwner: number;
  lockset: string[] | null;  // null = "all locks" (not yet constrained)
  lastAccess: { tid: number; event: number; write: boolean } | null;
  raceReported: boolean;
  increments: number;        // number of completed inc/dec intents (expected delta)
  expectedDelta: number;
}

export type SimStatus = 'ready' | 'running' | 'done' | 'deadlock' | 'stalled' | 'max-ticks';

export interface Injection { at: number; action: InjectAction }
export type InjectAction =
  | { type: 'kill'; tid: number }
  | { type: 'signal'; s: string }
  | { type: 'unlock'; m: string };

export interface MachineState {
  tick: number;
  status: SimStatus;
  config: Config;
  threads: ThreadRT[];
  processes: ProcessRT[];
  cores: CoreRT[];
  frames: Frame[];
  clockHand: number;
  ready: number[];           // tids in READY (selection policy decides which runs)
  mutexes: Record<string, MutexRT>;
  sems: Record<string, SemRT>;
  vars: Record<string, VarRT>;
  seq: number;               // monotonically increasing counter for queue order
  nextEvent: number;
  eventCount: number;        // length of the event log at this state
  deadlock: { tids: number[]; resources: string[] } | null;
  pendingInjections: Injection[];
  counters: { contextSwitches: number; faults: number; tlbHits: number; tlbMisses: number; evictions: number; writebacks: number; memAccesses: number; preemptions: number };
}

/* ------------------------------------------------------------------- events */

export type EventType =
  | 'ARRIVE' | 'DISPATCH' | 'SWITCH_START' | 'PREEMPT' | 'YIELD' | 'BLOCK' | 'WAKE' | 'EXIT' | 'PROCESS_EXIT'
  | 'SYSCALL_ENTER' | 'SYSCALL_EXIT'
  | 'MEM_ACCESS' | 'TLB_HIT' | 'TLB_MISS' | 'TLB_FLUSH' | 'TLB_SHOOTDOWN' | 'PAGE_FAULT' | 'PAGE_EVICT' | 'PAGE_IN' | 'SEGFAULT'
  | 'LOCK_ACQUIRE' | 'LOCK_CONTEND' | 'LOCK_HANDOFF' | 'LOCK_RELEASE' | 'LOCK_ABANDONED' | 'UNLOCK_NOT_OWNER'
  | 'SEM_WAIT' | 'SEM_BLOCK' | 'SEM_SIGNAL' | 'SEM_HANDOFF'
  | 'VAR_READ' | 'VAR_WRITE' | 'VAR_ATOMIC' | 'LOST_UPDATE' | 'RACE'
  | 'PRIORITY_INHERIT' | 'PRIORITY_RESTORE' | 'AGING' | 'STARVATION'
  | 'DEADLOCK' | 'STALL' | 'INJECT' | 'HALT';

export interface SimEvent {
  id: number;
  t: number;
  type: EventType;
  tid?: number;
  pid?: number;
  core?: number;
  line?: number;
  data?: Record<string, unknown>;
  msg: string;
}

/** One column of the CPU timeline: what each core and each thread did during a tick. */
export interface TickRecord {
  t: number;
  cores: { tid: number; kind: 'run' | 'switch' | 'idle'; line?: number }[];
  states: ThreadState[];           // indexed by tid
  blockKinds: (string | null)[];   // indexed by tid: io / sleep / fault / lock / sem
  framesUsed: number;
}
