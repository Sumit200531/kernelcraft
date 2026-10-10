/** Thread colours: distinct hues tuned for a dark background. */
const PALETTE = ['#5eead4', '#a78bfa', '#fbbf24', '#f472b6', '#60a5fa', '#a3e635', '#fb923c', '#22d3ee', '#e879f9', '#facc15', '#34d399', '#f87171'];
export const threadColor = (tid: number) => PALETTE[tid % PALETTE.length];
export const pidColor = (pid: number) => PALETTE[(pid * 5 + 1) % PALETTE.length];

export const STATE_COLOR: Record<string, string> = {
  new: '#3b4656', ready: '#64748b', running: '#5eead4', blocked: '#f59e0b', terminated: '#1f2833'
};
export const BLOCK_COLOR: Record<string, string> = {
  io: '#60a5fa', sleep: '#94a3b8', fault: '#f472b6', lock: '#f87171', sem: '#fb923c'
};

export type EventCategory = 'sched' | 'mem' | 'sync' | 'data' | 'error' | 'sys';
export const CATEGORY: Record<string, EventCategory> = {
  ARRIVE: 'sched', DISPATCH: 'sched', SWITCH_START: 'sched', PREEMPT: 'sched', YIELD: 'sched', BLOCK: 'sched', WAKE: 'sched', EXIT: 'sched', PROCESS_EXIT: 'sched',
  AGING: 'sched', STARVATION: 'error', PRIORITY_INHERIT: 'sync', PRIORITY_RESTORE: 'sync',
  SYSCALL_ENTER: 'sys', SYSCALL_EXIT: 'sys', INJECT: 'sys', HALT: 'sys',
  MEM_ACCESS: 'mem', TLB_HIT: 'mem', TLB_MISS: 'mem', TLB_FLUSH: 'mem', TLB_SHOOTDOWN: 'mem', PAGE_FAULT: 'mem', PAGE_EVICT: 'mem', PAGE_IN: 'mem', SEGFAULT: 'error',
  LOCK_ACQUIRE: 'sync', LOCK_CONTEND: 'sync', LOCK_HANDOFF: 'sync', LOCK_RELEASE: 'sync', LOCK_ABANDONED: 'error', UNLOCK_NOT_OWNER: 'error',
  SEM_WAIT: 'sync', SEM_BLOCK: 'sync', SEM_SIGNAL: 'sync', SEM_HANDOFF: 'sync',
  VAR_READ: 'data', VAR_WRITE: 'data', VAR_ATOMIC: 'data', LOST_UPDATE: 'error', RACE: 'error',
  DEADLOCK: 'error', STALL: 'error'
};
export const CATEGORY_COLOR: Record<EventCategory, string> = {
  sched: '#5eead4', mem: '#f472b6', sync: '#fbbf24', data: '#a78bfa', error: '#f87171', sys: '#60a5fa'
};
