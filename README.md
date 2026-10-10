<div align="center">

# KernelCraft

**An interactive operating-system lab: write a workload, watch a deterministic kernel run it, rewind time, break it, and ask why.**

[Live demo](https://sumit200531.github.io/kernelcraft/) · [Architecture](docs/ARCHITECTURE.md) · [Engine internals](docs/ENGINE.md) · [Workload language](docs/WORKLOAD_LANGUAGE.md) · [API](docs/API.md)

![KernelCraft: dining philosophers deadlock with the resource-allocation graph, findings and terminal](docs/screenshots/deadlock.png)

</div>

KernelCraft is a real simulator, not an animation. A small kernel advances tick by tick through a fixed sequence of phases. It schedules threads on up to four cores, pages memory through a TLB, hands off mutexes, counts semaphores, detects deadlocks and data races, and records every decision as an event. Because the kernel is fully deterministic, any run can be scrubbed backwards and forwards, branched by killing a thread in the past, saved, and later verified to reproduce bit for bit.

The built-in debugging assistant answers questions from the trace, citing the events it relies on. When it suggests a fix (`inherit=true`, `frames=16`, `atomic_inc`), it has already re-run the workload with that change and shows you the measured difference.

## Highlights

- **Scheduling:** FCFS, SJF, SRTF, priority (preemptive or not, with aging and priority inheritance) and round robin, with configurable quantum, context-switch cost and core count. The scheduler-comparison table re-runs your workload under every policy.
- **Virtual memory:** per-process page tables and global FIFO / LRU / Clock replacement, with dirty write-back, per-core TLBs, flushes and shootdowns, and segmentation faults. The kernel's victim choices are checked against an independent oracle that also implements OPT, on 300 generated reference strings.
- **Synchronization:** mutexes with FIFO handoff, counting semaphores, wait-for-graph deadlock detection, stall detection, Eraser lockset race detection, and exact lost-update accounting (the reported losses always add up to `expected − actual`).
- **Time travel:** keyframes plus re-execution. Every state you scrub to was actually computed. Operator actions (`kill`, `signal`, `unlock`) are recorded inputs; making one in the past starts a new branch.
- **Evidence-based assistant:** findings and answers cite event ids as clickable chips, and suggested experiments are real counterfactual runs. LLM narration is optional, works with any OpenAI-compatible endpoint (for example Ollama), and is accepted only if its citations check out.
- **IDE-style workspace:**
  - an editor with live diagnostics and per-thread program-counter markers;
  - a canvas timeline with zoom, pan and hover;
  - a memory frame map with page tables and TLBs;
  - an animated resource-allocation graph;
  - metrics, a reference-string lab, a terminal, a filterable event log and keyboard shortcuts throughout.
- **Persistence:** recordings and assistant logs are stored in PostgreSQL through a validated Fastify API. The UI falls back to browser storage when no API is running, so the demo works as a single static file.

| Overview | Race and assistant |
|---|---|
| ![overview](docs/screenshots/overview.png) | ![race](docs/screenshots/race-assistant.png) |
| **Thrashing in the memory view** | **Scheduler comparison** |
| ![memory](docs/screenshots/memory.png) | ![metrics](docs/screenshots/scheduler-comparison.png) |

## Quick start

You need Node.js 20 or newer. PostgreSQL is optional.

```bash
git clone https://github.com/Sumit200531/kernelcraft.git
cd kernelcraft
npm install

npm run dev:api    # terminal 1: API on http://127.0.0.1:8787 (in-memory storage)
npm run dev        # terminal 2: UI on http://localhost:5173
```

The UI alone (`npm run dev`) is fully functional, because the engine runs in the browser. Start the API as well to keep recordings in a database and to use LLM narration.

**With PostgreSQL:**

```bash
# any PostgreSQL 13+; migrations run automatically at startup
DATABASE_URL=postgres://user:pass@localhost:5432/kernelcraft npm run dev:api
```

On Windows PowerShell, use `$env:DATABASE_URL="postgres://…"; npm run dev:api` instead.

**With Docker** (app and PostgreSQL 16):

```bash
docker compose up --build      # → http://localhost:8787
```

**Optional LLM narration** with a local open-source model:

```bash
ollama pull llama3.1
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.1 npm run dev:api
```

Then tick **LLM narration** in the Assistant panel.

**Single-file demo:** `npm run build:demo` writes `apps/web/dist-single/kernelcraft.html`, which opens anywhere. The Pages workflow deploys it on every push to `main`.

## A five-minute tour

1. Pick **ABBA deadlock** from the sample menu. The status turns `DEADLOCK`, the Sync tab shows the red cycle, and the finding lists each thread's lock order.
2. In the terminal, type `locks`, then `kill 1`. The future is re-simulated from that tick, and the run now finishes. Press <kbd>Home</kbd> then <kbd>End</kbd>: the replay produces the same trace hash.
3. Open **Lost updates on a shared counter**. The counter ends at 40 instead of 80. Click a `LOST_UPDATE` event to see the stale read and the intervening writes it overwrote. Click **Apply** on the finding: the source is rewritten to use `atomic_inc`, and the race disappears.
4. Open **Priority inversion** and ask the assistant *"why is control late?"*. It cites the blocking `LOCK_CONTEND` and the medium thread's dispatches, and shows that `inherit=true` cuts control's finish time from 25 to 11.
5. Type `set scheduler=sjf` in the terminal, or use the Metrics tab's comparison table, and watch the averages change.

**Keyboard:**

| Keys | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | Step one tick (hold <kbd>Shift</kbd> for ten) |
| <kbd>Home</kbd> <kbd>End</kbd> | Jump to the start / end of the run |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Run the workload |
| <kbd>1</kbd>–<kbd>5</kbd> | Switch view |
| <kbd>`</kbd> | Focus the terminal |
| <kbd>/</kbd> | Ask the assistant |
| <kbd>?</kbd> | Show all shortcuts |

## Writing workloads

```text
config cores=2 scheduler=priority preempt=true inherit=true frames=8 replacement=clock
mutex bus
shared hits=0

process control priority=1 arrive=2 pages=4
  lock bus
  load 0x120
  compute 2
  unlock bus

process logger priority=8
  repeat 5
    lock bus
    inc hits          # non-atomic: ldv / add / stv
    unlock bus
    syscall io 3
  end
```

See [docs/WORKLOAD_LANGUAGE.md](docs/WORKLOAD_LANGUAGE.md) for every instruction and config key. The eleven [samples](samples/) each reproduce one classic behaviour: convoy, switch overhead, lost updates, ABBA, dining philosophers, thrashing, priority inversion, missing signal, starvation and segfault.

## Architecture

```mermaid
flowchart LR
  W["apps/web<br/>React · canvas timeline · terminal"] -- runs locally --> E["packages/engine<br/>parser · kernel · session · analyze · assistant"]
  W -- "/api (optional)" --> A["apps/api<br/>Fastify · zod"]
  A -- same engine --> E
  A --> D[("PostgreSQL")]
  A -.-> L(["OpenAI-compatible LLM<br/>(optional)"])
```

The engine is pure, dependency-free TypeScript, so the browser and the server run identical code, and a recording made in one verifies in the other. The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the tick model and algorithms are in [docs/ENGINE.md](docs/ENGINE.md).

## Testing

```bash
npm run test:engine   # 78 tests: scheduling, memory, sync, replay, analysis, assistant
npm run test:api      # 29 tests: endpoints + real PostgreSQL (embedded) integration
npm run test:e2e      # 9 Playwright workflows against the real UI and API
```

The tests compare against known answers:

- **Scheduling:** textbook values, e.g. FCFS waits of 0/24/27, SRTF's Gantt chart and its 6.5 average wait, and the exact effect of priority inheritance.
- **Paging:** Belady's anomaly (FIFO gives 9 faults with 3 frames and 10 with 4), plus differential testing against the oracle.
- **Races:** lost-update totals checked against `expected − actual` with two and four threads.
- **Replay:** a state seeked to by any route is JSON-identical to a straight run, and replayed recordings reproduce their hashes.

The PostgreSQL suite starts a real PostgreSQL 17 server (embedded-postgres). In CI it uses a `postgres:16` service via `TEST_DATABASE_URL`. It covers migrations, concurrent migrators, constraints, pagination, cascade deletes and tamper detection via `verify`.

## Project layout

```
packages/engine   deterministic simulator (TypeScript, zero runtime deps)
apps/api          Fastify + zod API, PostgreSQL store, migrations, LLM narration
apps/web          React + Vite UI
e2e               Playwright workflows
samples           reproducible .kc workloads
docs              architecture, engine, language, API, screenshots
```

## Design decisions

- **TypeScript for the engine rather than Rust/WASM.** One implementation runs in the browser (for interactive time travel) and in Node (for the API and tests), with no serialization boundary. Determinism comes from the algorithms, not the language.
- **A discrete tick model with explicit phases** makes every ordering decision observable and testable. That is what lets the textbook examples be matched exactly.
- **Keyframes plus re-execution** for time travel, rather than storing every state: memory stays bounded, and correctness is easy to test.
- **Deterministic analysis first, LLM second.** The assistant's facts come from the trace. A language model may only rephrase them, and only if its citations check out.

## Limitations

- KernelCraft is a teaching and debugging model, not an emulator: there is no instruction set, interrupt controller or file system.
- Disk latency is fixed.
- There is no working-set allocator.
- The API has no authentication or rate limiting, so put it behind a gateway before exposing it.

## License

[MIT](LICENSE) © Sumit Goswami
