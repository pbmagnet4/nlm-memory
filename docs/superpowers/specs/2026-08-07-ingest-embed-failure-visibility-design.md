# Ingest embed-failure visibility

Date: 2026-08-07
Status: design, pending review

## Problem

During ingest, session body chunks and fact triples are embedded best-effort,
outside the row-commit transaction, so a slow or unreachable embedder never
blocks the write. When an individual embed call throws, the failure is caught
and tolerated. That part is correct: the session/fact row still commits, and
the chunks that did embed still contribute to recall.

The defect is that some of these catches are **fully silent**, and the failure
is invisible after the fact. A chunk or fact that fails to embed is dropped
from the semantic index permanently, until an unrelated re-ingest happens to
rewrite it. Nothing logs it, nothing counts it, and the embedding-lane health
gauge does not see it (lane health tracks whether the prose lane is reachable,
not whether an individual per-chunk call failed). The result is silent,
gradual, partial index rot: recall quietly answers keyword-only for some
content while reporting nothing wrong.

Two things make this worth fixing now and cheap to fix:

1. **It is a parity bug, not just a gap.** The Postgres store already logs
   chunk-embed failures (`pg-session-store.ts:666`,
   `[nlm] embedding chunk failed session=... chunk=...`). The SQLite store's
   chunk-embed loop swallows the same failure with an empty `catch {}`
   (`sqlite-session-store.ts:549`). So the SQLite path is a silent regression
   against the Postgres path.
2. **Fact-embed is silent on both stores.** `embedFacts` in SQLite
   (`sqlite-session-store.ts:671`) and the fact-embed loop in Postgres
   (`pg-session-store.ts:681`) both use an empty `catch {}`.

## Non-goals

- **No behavior change to the fallback itself.** Tolerating per-embed failures
  outside the txn is correct and stays. This spec only makes the failure
  observable.
- **Recall-path degradation is out of scope.** It is already observable: both
  session and fact recall attach `modeUnavailable: "ollama_unreachable"` to the
  payload (`recall-service.ts:50`, `fact-recall-service.ts:167`), and the root
  cause (prose lane cold) already fires the `nlm.health.embedder_cold` alert
  and shows in `laneHealth`. Adding per-recall instrumentation would duplicate
  an existing surface and touch the hot path.
- **Self-healing is deferred** (see Future work). This spec makes rot visible,
  not recoverable.

## Design

Two changes, both matching conventions already in the codebase.

### 1. Log every tolerated embed failure (parity + coverage)

At each of the currently-silent catches, emit the same `[nlm]` stderr line the
Postgres chunk-embed path already writes, naming the session id, the kind
(chunk or fact), and the identifier (chunk index or fact id):

- `sqlite-session-store.ts` chunk-embed catch (~:549) — currently empty.
- `sqlite-session-store.ts` `embedFacts` catch (inside the method at ~:671) —
  currently empty.
- `pg-session-store.ts` fact-embed catch (~:681) — currently empty.
- `pg-session-store.ts` chunk-embed catch (~:666) — already logs; left as the
  reference line, or normalized to match the shared format if trivial. Still
  gets a `recordEmbedFailure` call so the counter sees all four sites.

Store-level best-effort failures already use `process.stderr.write("[nlm] ...")`
directly rather than a dependency-injected logger, so this needs no new
constructor dependency and no logger threading.

### 2. Aggregate counter in the health substrate

A stderr line answers "did it fail" but not "how often." Add a small in-memory
counter module mirroring the existing `embedding-lane-state.ts` gauge:

`src/core/health/embed-failure-state.ts`
- `recordEmbedFailure(kind: "chunk" | "fact"): void` — increment.
- `embedFailureSnapshot(): Readonly<{ chunk: number; fact: number }>` — read.
- `resetEmbedFailureForTests(): void`.

Each of the four catches calls `recordEmbedFailure(kind)` alongside its log
line. Both stores import the module function directly, same as they already
import `laneHealth` — no constructor change.

**Durability limitation, stated honestly:** like the other health gauges
(`embedding-lane-state`, `corpus-state`), this counter is a process-lifetime
in-memory singleton and resets on daemon restart. That is the codebase's
existing convention for health state and is sufficient for "is this happening
a lot right now." Durable history is explicitly deferred.

### 3. Surface through `/api/health`

Include `embedFailureSnapshot()` in the `GET /api/health` payload, which already
assembles `laneHealthSnapshot()`, `inflightSnapshot()`, and `corpusSnapshot()`
(`http/app.ts:715`). This is the correct and only v1 surface: the counter is a
per-process in-memory gauge, and `/api/health` is served by the daemon itself,
so it reads the live in-process count.

A CLI readout is explicitly **not** in scope. A separate `nlm <cmd>` invocation
calls `buildStack()` in its own process and would see a freshly-zeroed counter,
not the daemon's. A CLI surface would have to HTTP-poll the running daemon's
`/api/health`; that is deferred.

## Data flow

```
ingest → store.insertSession(embedder)
           └─ per chunk/fact: embedder.embed()
                └─ throws  → catch:
                              process.stderr.write("[nlm] embedding <kind> failed session=<id> ...")
                              recordEmbedFailure(<kind>)
                              (continue; row already committed)

GET /api/health (daemon process) → embedFailureSnapshot() → { chunk, fact }
```

## Error handling

The instrumentation is itself best-effort and must never worsen ingest:
`recordEmbedFailure` is a pure in-memory increment that cannot throw;
`process.stderr.write` is already the established store-level convention. The
existing "continue, do not abort subsequent chunks, do not roll back the txn"
behavior is unchanged.

## Testing

- **Unit — `embed-failure-state`:** record increments per kind; snapshot
  reflects counts; reset zeroes. Mirrors `embedding-lane-state` tests.
- **SQLite store:** with an embedder stub that throws on a specific chunk and
  on a specific fact, assert (a) the session and remaining chunks/facts still
  commit, (b) `embedFailureSnapshot()` shows the expected chunk and fact
  counts, (c) a `[nlm]` line was written. Assert the success path records zero.
- **Postgres store:** same assertions via the existing PG contract suite, so
  the two stores stay at parity (this is the parity-bug guard).

## Future work (deferred, not this spec)

Turn visible rot into recoverable rot: mark sessions/facts that failed to embed
so the existing `reprocess` / backfill machinery can find and re-embed them.
That is a self-healing feature; this spec is observability only.

## Files touched

- `src/core/health/embed-failure-state.ts` (new)
- `src/core/storage/sqlite-session-store.ts` (two catches)
- `src/core/storage/pg-session-store.ts` (one catch; one existing line as reference)
- `/api/health` assembler in `src/http/app.ts:715` (surface the snapshot)
- tests for the above

## Implementation note

The repo is currently on `fix/hook-env-lazy-reads-and-http-mcp-default`. This
work should land on its own branch cut from the intended base, not on top of
that unrelated feature branch.
