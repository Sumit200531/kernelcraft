# Workload language (`.kc`)

A workload is a plain-text program. It describes the machine, the shared resources and the processes, and it is written one statement per line. Comments start with `#` or `//`. Indentation is for readability only.

```text
# two threads racing on a counter
config scheduler=rr quantum=2
shared counter=0

process bank pages=4
  thread teller1
    repeat 40
      inc counter
    end
  thread teller2 arrive=3
    repeat 40
      inc counter
    end
```

Numbers can be decimal (`256`), hex (`0x1f0`), binary (`0b1010`) or kilobytes (`4k`).

## Declarations

| Statement | Meaning |
|---|---|
| `config key=value …` | Machine settings (see below). May appear more than once; the last value wins. |
| `mutex a b …` | Declare mutexes. |
| `sem name=N …` | Declare counting semaphores with initial value N. |
| `shared name=N …` | Declare shared integer variables. |
| `process NAME [priority=P] [arrive=T] [pages=N]` | Start a process. Defaults: priority 10, arrive 0, 8 pages. |
| `thread NAME [priority=P] [arrive=T]` | Start a thread inside the current process. Without `thread`, instructions go to an implicit `main` thread. |
| `repeat N` … `end` | Repeat a block N times (blocks can be nested). |

Priorities run from 0 to 99, and **lower numbers are more important**. Thread names in the UI are written as `process.thread`.

## Instructions

| Instruction | Effect |
|---|---|
| `compute N` | Use the CPU for N ticks. |
| `load ADDR` · `store ADDR` | Read or write a virtual address. `store` marks the page dirty. |
| `syscall io N` · `syscall sleep N` | Block for N ticks. `io N` and `sleep N` are shorthands. |
| `syscall getpid` | A system call that returns immediately. |
| `lock M` · `unlock M` | Acquire or release a mutex. |
| `wait S` · `signal S` | Semaphore P and V operations. |
| `inc V` · `dec V` | Non-atomic read-modify-write (three preemptible micro-ops). |
| `atomic_inc V` · `atomic_dec V` | Atomic update. |
| `yield` | Give up the CPU. |
| `exit [CODE]` | Terminate the thread with an exit code (0–255). |

Aliases: `cpu`/`run` for `compute`; `read`/`write` for `load`/`store`; `acquire`/`release` for `lock`/`unlock`; `p`/`down` for `wait`; `v`/`up`/`post` for `signal`.

## Config keys

| Key | Values | Default | Meaning |
|---|---|---|---|
| `cores` | 1–4 | 1 | CPU cores |
| `scheduler` | `fcfs` `sjf` `srtf` `priority` `rr` | `rr` | Scheduling policy |
| `quantum` | 1–1000 | 4 | Round-robin time slice |
| `preempt` | true/false | false | Preemptive priority scheduling |
| `aging` | 0–10000 | 0 | Improve priority by 1 every N waiting ticks (0 = off) |
| `inherit` | true/false | false | Priority inheritance on mutexes |
| `cs` | 0–50 | 0 | Context-switch cost in ticks |
| `frames` | 1–256 | 8 | Physical frames |
| `pagesize` | power of two, 16–65536 | 256 | Bytes per page |
| `replacement` | `fifo` `lru` `clock` | `lru` | Page replacement policy |
| `tlb` | 0–64 | 4 | TLB entries per core (0 disables the TLB) |
| `tlbpenalty` | 0–20 | 1 | Extra ticks on a TLB miss |
| `fault` | 1–500 | 6 | Ticks to service a page fault |
| `writeback` | 0–500 | 4 | Extra ticks to write back a dirty victim |
| `starve` | 0–100000 | 0 | Warn when a thread is ready this long without running (0 = off) |
| `deadlock` | `halt` `continue` | `halt` | Stop at a deadlock, or keep running |
| `maxticks` | 1–200000 | 5000 | Hard stop |

## Diagnostics

The parser reports every problem with its line and column. For example:

```text
1:8   scheduler must be one of fcfs, sjf, srtf, priority, rr.
3:8   Unknown mutex `nope`. Declare it with `mutex nope`.
5:3   Unknown instruction `frobnicate`. Try compute, load, store, …
```

Accessing an address beyond a process's `pages` produces a **warning**, not an error, because a segfault is something you may want to simulate. A program can expand to at most 20,000 instructions per thread and 64 threads. A `repeat` that would exceed this is rejected before it is expanded.

## Samples

`samples/` holds eleven reproducible workloads, each targeting one behaviour. A test keeps these files byte-identical to the samples built into the app.

| File | Shows |
|---|---|
| `web-stack.kc` | Two cores, I/O, a shared lock and paging: an overview |
| `convoy.kc` | FCFS convoy effect (try `scheduler=sjf`) |
| `round-robin.kc` | Context-switch overhead versus quantum |
| `race-counter.kc` | Lost updates and lockset race detection |
| `deadlock-abba.kc` | Two-lock ABBA deadlock |
| `philosophers.kc` | Five-way circular wait |
| `thrashing.kc` | Working sets larger than memory |
| `priority-inversion.kc` | The Mars Pathfinder bug, fixed with `inherit=true` |
| `producer-consumer.kc` | Missing `signal`, which leads to a stall rather than a deadlock |
| `starvation.kc` | Priority starvation, fixed with `aging=4` |
| `segfault.kc` | An access outside the address space |
