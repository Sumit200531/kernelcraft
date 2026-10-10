# HTTP API

The API is served by `apps/api` (Fastify). All bodies are JSON, and every request is validated with zod.

- Base URL in development: `http://127.0.0.1:8787`. The web dev server proxies `/api`.
- Request bodies are limited to 512 KB, and workload sources to 100,000 characters.
- Recording ids are UUIDs.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "invalid_workload", "message": "The workload has 2 error(s).", "diagnostics": [ … ] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body or query fails schema validation (includes `issues`) or is not valid JSON. |
| 404 | `not_found` | Unknown route, sample, recording or event. |
| 422 | `invalid_workload` | The source does not parse (includes `diagnostics` with line and column). |
| 422 | `invalid_input` | An operator input names a thread, semaphore, mutex or variable that does not exist. |
| 500 | `internal` | Unexpected; logged server-side. |

An **operator input** is `{ "at": <tick>, "action": A }`, where `A` is one of:

- `{ "type": "kill", "tid": 1 }`
- `{ "type": "signal", "s": "empty" }`
- `{ "type": "unlock", "m": "bus" }`

## Endpoints

### `GET /api/health`
```json
{ "ok": true, "engine": "1.0.0", "storage": "postgres", "database": "up", "narration": "deterministic" }
```

### `GET /api/samples` · `GET /api/samples/:id`
The list endpoint returns ids, titles, topics and blurbs. The single-sample endpoint also returns `source`.

### `POST /api/parse`
`{ "source": "…" }` → `{ ok, diagnostics, config?, processes?, mutexes?, semaphores?, shared? }`

### `POST /api/simulate`
```json
{ "source": "…", "inputs": [], "until": 40, "include": ["events", "timeline", "analysis", "final"], "experiments": true }
```

- **`until`** (optional) stops at that tick instead of running to the end.
- **`include`** selects heavy sections. It defaults to events, timeline and analysis.

Response fields:

- **Run summary:** `status` (`done` | `deadlock` | `stalled` | `max-ticks` | `running`), `tick`, `finished`, `traceHash`, `engine`.
- **Workload description:** `warnings`, `config`, `processes`, `threads`, `mutexes`, `semaphores`, `shared`.
- **Always included:** `metrics`, `eventCount`.
- **Optional sections:**
  - `events`: at most 50,000, with `eventsTruncated`;
  - `timeline`: one record per tick, with what each core ran and each thread's state;
  - `state`: the full machine state;
  - `analysis`: `{ headline, findings }`.

Experiments only run when the run has finished.

```bash
curl -s localhost:8787/api/simulate -H 'content-type: application/json' \
  -d '{"source":"config scheduler=fcfs\nprocess A\n  compute 24\nprocess B\n  compute 3","include":["analysis"]}'
```

### `POST /api/experiments/run`
Run a custom what-if against the same workload and inputs.
```json
{ "source": "…", "inputs": [], "change": { "kind": "config", "patch": { "quantum": 12 } }, "metrics": ["switchOverhead", "ticks"] }
```

- `change.kind` is one of:
  - `config` (any config key, strictly validated);
  - `inject` (`at` plus an operator action);
  - `atomic` (`var`: turns `inc`/`dec` of that variable into atomic instructions).
- Metric keys:
  - `avgWaiting`, `avgTurnaround`, `ticks`, `pageFaults`, `switchOverhead`, `completed`, `cpuWork`;
  - per thread: `threadWait:<tid>`, `threadFinish:<tid>`, `threadBlocked:<tid>`, `threadResponse:<tid>`;
  - per variable: `varError:<var>`.

The response is `{ "result": { deltas: [{ key, label, before, after, better }], improved, statusBefore, statusAfter, hashBefore, hashAfter, summary } }`.

### `POST /api/explain`
`{ source, inputs, eventId }` → `{ eventId, title, text, citations, lines, event }`. The text cites related events as `[#id]`.

### `POST /api/assistant/ask`
```json
{ "source": "…", "inputs": [], "question": "why is control late?", "at": 12, "narrate": false, "recordingId": null }
```

Returns `{ intent, text, citations, findings, experiments, tick, traceHash, narration, narrationError }`.

- **The answer is always computed deterministically** from the trace.
- **Narration:** if `narrate` is true and an LLM is configured, the server asks the model to rephrase the answer using only the cited events. It rejects the narration, and reports why in `narrationError`, if the narration:
  - cites an event that does not exist;
  - cites an event outside the supplied evidence;
  - drops every citation.
- **Logging:** each question is logged in `assistant_log` with its intent and citations.

### Recordings
| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/recordings` | `{ title, notes?, source, inputs? }` | `201` with the recording. The run is executed and its `traceHash`, status, ticks and summary are stored. |
| `GET` | `/api/recordings?limit=20&offset=0` | — | `{ items, total, limit, offset }` |
| `GET` | `/api/recordings/:id` | — | The full recording, including source and inputs. |
| `PATCH` | `/api/recordings/:id` | `{ title?, notes? }` | The updated recording. |
| `DELETE` | `/api/recordings/:id` | — | `204` |
| `POST` | `/api/recordings/:id/verify` | — | `{ reproducible, stored, actual, storedEngine, engine, status, ticks }`. Re-executes the recording and compares trace hashes. |

## Storage

With `DATABASE_URL` set, the API runs the SQL migrations in `apps/api/migrations` at startup. Each migration runs once, inside a transaction, under an advisory lock. The API then stores data in PostgreSQL:

- `recordings` has check constraints on title length, status values and the shape of `inputs`.
- `assistant_log` references `recordings` with `ON DELETE CASCADE`.

Without `DATABASE_URL`, recordings are kept in memory, which suits demos.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `STATIC_DIR` | — | Serve the built web app (single-container deployments) |
| `LLM_BASE_URL` | — | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, OpenRouter, Groq, …) |
| `LLM_API_KEY` | — | Bearer token for that endpoint, if needed |
| `LLM_MODEL` | `llama3.1` | Model name |
| `LLM_TIMEOUT_MS` | `20000` | Narration timeout |
| `LOG_LEVEL` | `info` | Fastify log level, or `silent` |
