# The KernelCraft engine

`packages/engine` is a deterministic, discrete-time model of a small operating system. It is plain TypeScript with no runtime dependencies, so the same code runs in the browser (for instant stepping and scrubbing) and in Node (the API, the tests, and the analyzer's what-if re-runs).

Everything below is enforced by tests in `packages/engine/test`.

## Time

The machine advances in **ticks**. Tick `t` covers the interval `[t, t+1)`. A thread that executes its last instruction during tick `t` finishes at time `t+1`. When the UI shows state "at t=30", that is the state after ticks `0…29` have run and before tick 30 runs.

Each tick runs the same eight phases in a fixed order:

| # | Phase | Rule |
|---|-------|------|
| 1 | Injections | Recorded operator actions (`kill`, `signal`, `unlock`) for this tick are applied. |
| 2 | Arrivals | Threads whose `arrive` time is reached become READY, in declaration order. |
| 3 | Timed wake-ups | Threads whose I/O, sleep or page-in completes become READY, in ascending tid order. |
| 4 | Quantum expiry | Under round robin, a thread that used its whole quantum goes to the back of the ready queue, **behind** this tick's arrivals. |
| 5 | Preemption | SRTF and preemptive priority preempt a running thread only if a ready thread is *strictly* better on the primary key. |
| 6 | Dispatch | Idle cores (in core order) take the best ready thread: policy key first, then FIFO order. |
| 7 | Execute | Each core executes one tick of its thread. |
| 8 | Accounting | Ready/blocked time, aging, starvation warnings, then deadlock, stall, completion and tick-limit checks. |

No randomness is used anywhere. The same workload and the same operator inputs always produce the same event log.

## Instructions and costs

| Instruction | Cost | Notes |
|---|---|---|
| `compute n` | n ticks | Preemptible between ticks. |
| `load a` / `store a` | 1 tick (+ `tlbpenalty` on a TLB miss) | Can page-fault (blocks) or segfault (kills the process). |
| `syscall io n`, `syscall sleep n` | 1 tick to enter, then blocked for n ticks | The CPU is free for other threads meanwhile. |
| `lock`, `unlock`, `wait`, `signal`, `yield` | 1 tick | |
| `inc v` / `dec v` | 3 ticks: `ldv`, `add`, `stv` | Each micro-op is preemptible, which is what creates lost updates. |
| `atomic_inc v` / `atomic_dec v` | 1 tick | Indivisible. |
| `exit [code]` | — | The thread terminates with that exit code. |

## Scheduling

| Policy | Key (lower runs first) | Preemptive |
|---|---|---|
| `fcfs` | ready-queue order | no |
| `sjf` | length of the next CPU burst | no |
| `srtf` | remaining length of the current burst | yes |
| `priority` | effective priority (lower number = more important) | if `preempt=true` |
| `rr` | ready-queue order | at quantum expiry |

A **CPU burst** is the CPU time from the current instruction up to and including the next `io`/`sleep` system call (or the end of the thread). The scheduler knows bursts exactly, as in textbook SJF; locks and page faults are not predicted.

**Context switches** cost `cs` ticks whenever a core switches to a different thread than the one it ran last. The first dispatch on an idle core is free. Switch time counts as waiting time for the incoming thread and as overhead, not useful work, for the core.

**Aging** (`aging=N`, priority scheduler only) improves a waiting thread's effective priority by one level for every N ticks it has waited. The boost is cleared once the thread has run and queues again.

**Priority inheritance** (`inherit=true`) gives a mutex holder the best priority among the threads waiting on any lock it holds. It is computed to a fixed point, so chains of locks work, and it emits `PRIORITY_INHERIT` and `PRIORITY_RESTORE` events.

**Metrics:**
- waiting = ticks READY, including switch time;
- turnaround = finish − arrive;
- response = first dispatch − arrive.

Averages use threads that exited normally (exit code 0).

## Virtual memory

- Each process has `pages` virtual pages of `pagesize` bytes, and its own page table.
- Physical memory has `frames` frames shared by all processes, with global replacement.
- **Page fault:** the thread blocks for `fault` ticks. If the victim page is dirty, it blocks `writeback` ticks longer. The faulting access is retried when the page arrives. A frame that is being loaded is pinned. A second thread touching a page that is still loading waits for the same I/O instead of faulting again.
- **Replacement policies:**
  - `fifo` evicts the page that was loaded earliest;
  - `lru` evicts the page that was used least recently;
  - `clock` is second chance: the hand clears reference bits until it finds a page whose bit is already clear.

  The kernel's choices are checked against an independent reference-string oracle (`refstring.ts`, which also implements OPT) on Belady's string and on 300 generated strings. The check compares both the fault counts and the exact sequence of victims.
- **TLB:** each core has its own TLB with LRU replacement of entries. It is flushed when the core switches to a different address space, and evicted pages are shot down from every core's TLB.
- **Segmentation fault:** an access beyond the process's pages kills the whole process with exit code 139 and frees its frames.

## Synchronization

- **Mutexes** are non-recursive and use **FIFO handoff**: `unlock` passes ownership directly to the longest waiter.
  - Unlocking a mutex the thread does not own aborts the thread (`UNLOCK_NOT_OWNER`, exit code 134).
  - A thread that dies while holding locks releases them (`LOCK_ABANDONED`).
- **Semaphores** are counting semaphores with FIFO wake-up. A semaphore whose initial value is 1 is treated as a lock for race detection.
- **Deadlock detection** follows the wait-for graph after every tick (thread → owner of the mutex it waits for). A cycle emits `DEADLOCK` with the threads and resources involved. With `deadlock=halt` (the default) the run stops there; with `deadlock=continue` it keeps going.
- **Stall detection:** if every live thread is blocked, nothing is pending (no I/O, no timer, no page-in) and there is no cycle, the run stops with `STALL`. A typical cause is a missing `signal`.

## Data races

Shared variables are checked with the **Eraser lockset algorithm**. Each variable moves through the states virgin → exclusive → shared → shared-modified, and keeps the set of locks held at every access. When a variable is shared-modified and that set becomes empty, the engine emits one `RACE` event. The event cites the two conflicting accesses.

Independently, every non-atomic write is checked for staleness. If other threads wrote the variable between this thread's `ldv` and its `stv`, the engine emits `LOST_UPDATE` with `lost = before + delta − written`. These amounts telescope: over a whole run, their sum equals exactly `expected − actual` for any number of threads. A test asserts this equality.

## Recording, replay and time travel

`Session` wraps a `Machine`:

- **Keyframes:** a full snapshot is kept every `interval` ticks (32 by default).
- **`seek(t)`** restores the nearest earlier keyframe and re-executes forward. Every state you scrub to was actually computed, and a test checks that seeking in any order gives a state byte-identical (as JSON) to a straight run.
- **Operator actions** are recorded as inputs `{at, action}` and re-applied during replay. An action recorded after a deadlock or stall reopens the run, which is how recovery is replayed.
- **Branching:** injecting an action in the past discards the recorded future and starts a new branch.
- **`traceHash`** is an FNV-1a hash of the visible event log plus the final tick and status. Two runs are identical exactly when their hashes match. Recordings store this hash, and `POST /api/recordings/:id/verify` re-executes the recording to check it.

## Analysis and the assistant

`analyze(machine)` derives findings from the event log only. Each finding lists the event ids it is based on, sorted in time order, and a test checks that every cited event exists. It detects:

- deadlocks, with each thread's lock acquisition order;
- stalls, with wait and signal counts per semaphore;
- races, with the exact lost-update total;
- segfaults and lock misuse;
- thrashing, from the ratio of refaults (a page evicted and then faulted back in);
- the convoy effect;
- starvation;
- priority inversion (medium-priority threads running while a high-priority thread waits on a lock held by a low-priority one);
- context-switch overhead;
- lock contention.

Most findings carry an **experiment**: a config patch, an operator injection, or a code transform (turning `inc` into `atomic_inc`). The analyzer actually executes it and reports measured before/after metrics and both trace hashes. Nothing is estimated.

`explainEvent` walks the causal chain of one event. For example, for a page fault it says whether it was a cold miss or a refault, why that victim was chosen, and how the delay breaks down. `answerQuestion` routes a free-text question to the relevant evidence: a thread, a tick, an event, or a topic. Every answer cites events as `[#id]`. `validateCitations` rejects text that cites events that don't exist. The API uses it to vet optional LLM narration.

## Limits

These limits keep inputs bounded and are validated by the parser and the API:

- 1–4 cores;
- up to 64 threads and 20,000 instructions per thread after `repeat` expansion;
- up to 256 frames;
- `maxticks` of 200,000 at most.

The model is deliberately simple in places:

- there are no interrupts or kernel threads;
- disk I/O has a fixed latency;
- there is no working-set or page-fault-frequency allocator;
- memory is a flat address space per process, with no segments or shared pages.
