# T679 — synchronous SQLite work that freezes the serving event loop

## The symptom being explained

`~/.nlm/hook-log.jsonl`, prompt-recall records (lines with `recallOutcome`, no `kind`):

| day (2026-11) | ok | timeout |
|---|---|---|
| 11-09 | 39 | 27 |
| 11-10 | 14 | 75 |
| 11-11 | 15 | 47 |

The same request made by hand while the daemon is idle —
`GET /api/recall?q=..&mode=keyword&limit=5&withFacts=true&withExemplars=true&withConcepts=true` —
answers in 0.3-0.6 s. Live build 0.21.21 (rc.1 in the hook log, 0.21.21-t1641.1 in
`daemon.err`; main + T806 semantic workers), DB 1,960,620,032 bytes (1.9 GB).
Timeouts are spread over every hour of the day, not clustered in one window.

A query that is fast when idle and times out two thirds of the time is not a slow
query. `recall-over-http.ts` waits `NLM_HOOK_RECALL_TIMEOUT_MS` (default 4000 ms)
inside an outer `NLM_HOOK_DEADLINE_MS` budget (6000 ms): the daemon was not
answering, and the only thing that stops a single-threaded Node server from
answering is work that never yields. better-sqlite3 is synchronous, so every
statement and every CPU loop below runs with the whole HTTP surface frozen for its
duration.

## Measured against the live corpus (read-only, 2026-11-11)

Contents, so "unbounded" means something concrete: 36,142 sessions (17,263 inside
the 42-day window), 5,393 of them decision-bearing; 86,308 facts, 48,126 active,
48,126 embedding rowids (so **zero** active facts are missing an embedding);
89,723 markers; 114,121 `session_entities`; 4,806 `session_edges`;
`SUM(LENGTH(body))` ≈ 14.5 MB per 500-session rowid window (7.6 ms per window).

| what | measured |
|---|---|
| one `COUNT(*)` over active facts | 53 ms |
| missing-embedding `COUNT(*) … NOT IN (SELECT id FROM fact_embeddings_rowids)` | 86 ms |
| same count as `NOT EXISTS` | 83 ms |
| `ORDER BY random() LIMIT 200` over 48,126 active facts | 47 ms |
| `NOT EXISTS … LIMIT 6` integrity-style probe | 0.05 ms (early exit) |
| re-derivation session enrichment (17,263 sessions, 2 statements each) | 124 ms |
| **re-derivation pair loop, pre-T679 code, one synchronous slice** | **13,891 ms** |

The cadence matters as much as the cost. `~/.nlm/daemon.err` contains 106 boot
banners and 114 corpus-monitor runs: the corpus monitor's first run is scheduled
60 s after every boot (`CORPUS_MONITOR_INITIAL_DELAY_MS`,
`src/cli/nlm.ts:756,816`) besides its 24 h timer, and this daemon restarts many
 times a day. So the daily job is really a per-boot job — and its pair loop is a **13.9-second freeze**, more
than three times a hook's entire timeout budget. Any prompt issued in the first
minutes after a restart loses.

That single number changes the ranking that a pure code read produced, so the
sections below are ordered by measurement, not by how alarming the SQL looks.

## Reading the instrumentation (Part 1)

`src/core/scheduler/loop-monitor.ts`, muted with `NLM_LOOP_LOG=0`:

- `[loop] lag p99=<ms> (p50=.. max=.. window=..)` every 5 minutes — the loop is
  blocked even outside a job boundary if `max` is large and no `[loop] <job>` line
  appeared near it.
- `[loop] <job> took <wall>ms (sync slice <ms>; hook budget 4000ms)` whenever one
  synchronous slice inside that named job reached 250 ms. Wall time is not the
  trigger: an ingest tick may await a 90 s classify call and freeze nothing.

Every `setInterval` daemon job in `src/cli/nlm.ts`, the scheduler tick, the
integrity check and each dream pass are named in those lines;
`grep '\[loop\]' ~/.nlm/daemon.err` is the whole investigation.

## Every job with unbounded synchronous SQLite work in one tick

### 1. `corpus-monitor` → `computeReDerivationRate` — per boot and every 24 h — **fixed**

Called from `src/cli/nlm.ts:801` (`persistReDerivationPairs`, 42-day window, not
gated by `shouldAppendTrend`, which only paces the separate trend log). Three
compounding problems, all in one slice:

- `src/core/metrics/re-derivation.ts:138-165` `listSessionsWithin`: every session
  in the window with no `LIMIT`, then two statements per session — 34.5k
  statements with nothing yielding between them (124 ms, measured).
- `:167-172` `listEdges`: every row of `session_edges`.
- `:209-277` the pairwise loop: 14.5M candidate pairs among the decision-bearing
  sessions, re-tokenizing both sides' decision text and building two `Date`s per
  candidate pair (13,891 ms, measured). The header comment of
  `persistReDerivationPairs` (`src/cli/nlm.ts:244-253`) already calls it "the same
  O(n^2) scan" — which is why `sqlite-outcome-store.ts:80` reads its cache file
  instead of computing it on the request path.

**Fix (Part 3).** Enrichment runs in `RE_DERIVATION_ENRICH_BATCH_ROWS` chunks and
the pair loop yields every `RE_DERIVATION_YIELD_EVERY_PAIRS` candidate pairs
(`await yieldToEventLoop()`, `@core/util/yield-loop.js`); per-session work is
hoisted out of the loop and tokenization is computed once per session on first use.
Measured on the same corpus with the same window, through the real module:

| | pre-T679 | post-T679 |
|---|---|---|
| longest synchronous slice | 13,891 ms | 73-91 ms |
| wall time | 14.0 s | 2.9-3.1 s |
| eligible pairs / pairs / rate | 1,037,608 / 7 / 6.75e-6 | identical |

`tests/unit/core/metrics/re-derivation-pacing.test.ts` keeps the pre-T679
implementation as an oracle and asserts the report is unchanged, including on
pseudo-random fixtures with duplicate entities, decisionless sessions, edges,
near-7-day gaps and unparseable timestamps.

### 2. `wal-checkpoint` — every 5 min (`src/cli/nlm.ts:698-716`)

`src/core/storage/sqlite-session-store.ts:277` runs
`PRAGMA wal_checkpoint(TRUNCATE)`, which drains the WAL and then waits for readers
to drain. Unbounded by construction (the WAL had reached 38 MB before this job
existed) and it can block behind a busy reader. Left as-is: it is now named
`wal-checkpoint` in the `[loop]` lines, and "only checkpoint when the WAL exceeds a
threshold" is the obvious change once the log says whether it is worth it.

### 3. `fact-embed-sweep` — every 2 min (`src/cli/nlm.ts:907-927`)

- `computeFactEmbedStats` (`src/core/facts/embed-missing.ts:23-31`): three full
  scans of `facts`, the missing one through
  `f.id NOT IN (SELECT id FROM fact_embeddings_rowids)`. Measured 53-86 ms each,
  so ~240 ms per run — real, scaling with the fact count, and below the logging
  threshold at today's 86k facts. Called from `src/cli/nlm.ts:916`, `/api/health`
  and `nlm doctor`, all of which inherit the stall.
- `listFactsDueForEmbedding` (`src/core/storage/sqlite-fact-store.ts:496-512`):
  `LIMIT 25` bounds the output, not the work — the same anti-join plus a sort by
  `f.created_at` runs over every active fact, whether or not anything is pending.
  The Postgres twin is fine (async, off the loop).

Not changed in this task: at 0 missing embeddings the sweep is currently doing
~240 ms of arithmetic to conclude there is nothing to do, and the measurement (a
`[loop] fact-embed-sweep took` line, or its absence) decides whether bounding those
counts into rowid windows is worth the churn.

### 4. Scheduler tick — every 30 min plus at boot (`src/core/scheduler/scheduler.ts`) — sweeps fixed

- **`runCheapChecksOnSqlite` — `src/core/integrity/check-invariants.ts`**, called at
  `scheduler.ts:360`. Every check is `SELECT … FROM <table> WHERE NOT EXISTS (…)`,
  and the `LIMIT 6` (`:67-180`) caps what is reported, not what is scanned; the
  supersession-cycle walk (`:385`, `:517`) traverses the whole graph. The probes
  measured are cheap because they exit early (`NOT EXISTS … LIMIT 6` 0.05 ms), but
  the aggregate checks have no such exit. Once per 24 h via the cache file, inside
  a serving tick. Now timed as `integrity-check`.
- **`pruneReverted` — `src/core/storage/sqlite-code-exemplar-store.ts`**,
  `scheduler.ts:598`, and **`applyBucketCap`** — `scheduler.ts:608`: both collected
  their whole backlog (every non-survived id for the scope, or every over-cap id
  per bucket) and then deleted it row by row from `code_exemplars` plus the
  `code_exemplars_vec` virtual table **inside one `db.transaction`** — one slice,
  proportional to the backlog, on every tick when `NLM_CODE_EXEMPLARS_ENABLED=1`
  (which it is: it is in the boot banner). **Fixed (Part 3):** the deletes now run
  in `DEFAULT_EXEMPLAR_DELETE_CHUNK` (200; the store's `deleteChunkRows`
  construction option overrides it, which is also how the tests count chunk
  boundaries) chunks, one
  transaction each, with `await yieldToEventLoop()` between them. The id list is
  still chosen up front and the sweep guard is still consulted once for the whole
  run, so the rows deleted are the same; the difference is that a crash mid-prune
  leaves a partial prune the next tick completes, instead of a rolled-back one.
  `tests/unit/core/storage/sqlite-code-exemplar-sweep-batching.test.ts` asserts the
  same rows go at any chunk size, that the guard can still refuse everything, and
  that the loop gets a turn.
- `scanOnce` (`src/core/scheduler/scan-once.ts:112-115`) loads all `adapter_state`
  rows per adapter — bounded by tracked source files, far smaller than the above.
- `insertSession` writes row, FTS rows, entity links, markers and vec embedding in
  one synchronous transaction per session (body capped at 200 KB): bounded per
  session, and the reason `scheduler-tick` slices exist at all.

### 5. Dream passes — 24 h cadence by default (`src/core/dream/settings.ts:46`)

Registered from `scheduler.ts`, so they also run inside a serving tick:

- **`ORDER BY random() LIMIT ?` over `facts`** — `contradiction-pass.ts:208-216`
  (sample 20), `dedup-pass.ts:139-147` (sample 200), `promotion-pass.ts:222-236`.
  `random()` forces a scan *and* a sort of every tenant-scoped active fact before
  `LIMIT` applies — "sampled, still scanned the table". Measured 47 ms at 48,126
  active facts, so it is a scaling liability rather than today's blocker.
- **`listActiveFactIdsSqlite` — `promotion-pass.ts:243-255`**: the whole active-fact
  id set, deliberately unsampled (the comment explains why), in one slice.
- **`readJsonl` over hook telemetry — `promotion-pass.ts:280-300`**: `readFileSync`
  of `~/.nlm/hook-log.jsonl` (13,145,149 bytes on this machine) and a `JSON.parse`
  per line in one slice, with the window filter at `:302-322` applied *after* the
  whole file was parsed. Only with `NLM_DREAM_PROMOTE_PASS` set.

### 6. Other `corpus-monitor` work — per boot and every 24 h

`sqliteCorpusStatsDeps` (`src/core/metrics/corpus-stats.ts:93-136`): entity, fact
and marker counts are each a full scan of their table in one slice (sub-millisecond
at these row counts, unbounded in general). Its `getBodyStats` (`:66-92`) is the
pattern this task applies elsewhere — `SUM(LENGTH(body))` chunked into 500-session
rowid windows with a yield between them — and is the reason the 1.9 GB body scan is
not on this list.

### 7. Opt-in jobs

- `wiki-projection` (`src/cli/nlm.ts:839-855`, only with `NLM_WIKI_DIR`): the whole
  active-fact set per projection plus thousands of synchronous `writeFileSync` /
  `statSync` calls for the markdown tree.
- `exemplar-backfill` (`src/cli/nlm.ts:874-890`, 24 h) and `signal-prune` (6 h) take
  explicit limits or DELETE-with-cutoff.
- `chunk-embed-sweep` (`src/core/embedding/chunk-retry.ts:51-53`, 2 min) is the other
  good example: `listChunksDueForEmbedding(limit 10)` and an awaited embed between
  writes. `stuckChunksOnSqlite` (`:99-102`) is unbounded but runs only under
  `nlm doctor`.

## What is left

The 13.9-second slice that explained the timeout rate is gone, and the per-tick
exemplar sweeps no longer hold the loop for a backlog-sized transaction. The next
things this file says to fix, in order, once `grep '\[loop\]' ~/.nlm/daemon.err`
confirms them: the fact-embed counts and due-list anti-join (rowid windows, `NOT
EXISTS` probe instead of `NOT IN`), the integrity sweep's aggregate checks (one
check per slice), the dream samplers' `ORDER BY random()` (random rowid start +
`ORDER BY rowid LIMIT 1` per draw), and promotion's whole-file hook-log parse (read
the tail, filter by timestamp while streaming).

---

# Phase 2 (T1757) — what the instrumentation then saw, and what it is

T679 shipped the two `[loop]` hooks and chunked the one offender that measurement
had already caught. This phase is what the live daemon (0.21.21-t679.1, measured
2026-11-11 over `~/.nlm/daemon.err`, 67 `[loop]` lines) reported afterwards, and
the code read that explains each line. The headline: **the hook timeouts did not
stop**, and for the first time the log says how long each freeze was.

## What the log says

```
[loop] lag p99=23.3ms (p50=22.1ms max=363.7ms window=300s)
[loop] scheduler-tick took 166164ms (sync slice 5750.8ms; hook budget 4000ms)
[loop] lag p99=24.1ms (p50=22.1ms max=13652ms window=300s)
[loop] alert-health took 4949ms (sync slice 1229.5ms; hook budget 4000ms)
[loop] fact-embed-sweep took 2347ms (sync slice 605ms; hook budget 4000ms)
[loop] lag p99=41.1ms (p50=22.1ms max=17649.3ms window=300s)
```

Percentiles stay at 22-55 ms — the loop is healthy *most* of the time — while
individual blocks run to 13.7 s and 17.6 s. p50 is pinned near the 20 ms probe
resolution, so nothing here is background noise: every `max` is one deliberate
synchronous block. Read against the 4 s hook budget, a 17.6 s block misses two
consecutive prompts; a 1.2 s block is a coin flip.

Three findings, in the order the evidence supports:

1. **p99 ≈ 22 ms with max up to 17.6 s is the signature of a few huge blocks, not
   of general load.** Nothing about the corpus needs to be faster on average; a
   handful of statements need to stop holding the loop.
2. **The named sync slices are 286-5 751 ms**, i.e. every one of them is bigger
   than the 250 ms threshold and several are longer than a hook's whole budget.
   The named offenders are all real and all fixable by bounding a loop.
3. **Several of the largest blocks have no `[loop] <job> took` line near them**
   (`max=17649.3ms`, `max=13652ms`, `max=10737.8ms`, `max=8498.9ms`). Two causes,
   both fixed in T1757 Part 1: a job's line is printed when the job *ends*, up to
   166 s after the block that caused it, and code that no `timedJob` wrapper names
   at all (`MemoSweepScheduler`, HTTP handlers, anything behind a SQLite lock wait)
   can never produce one. `[loop] stall <ms>ms during: …` closes the first gap and
   either names or explicitly clears the second (`during: no tracked job`).

## Synchronous hot spots, by job

### `alert-health` — every 5 min (`src/cli/nlm.ts:748`)

The three checks themselves are clean: `checkEmbedderAndAlert` and
`checkDriftAndAlert` (`src/core/alerts/check-and-alert.ts:31,60`) do
`readFile`/`writeFile` of `~/.nlm/alert-state.json` (async, tiny), a cached
in-process warmup flag read, and `fireAlert`, which returns immediately with zero
work unless `NLM_ALERT_WEBHOOK` is set. `checkDriftAndAlert`'s npm registry call is
24 h-cached and awaited. **Nothing in these two can hold the loop**, which is why
the 286-1229 ms slices `alert-health` reports must come from the third check:

- **`checkIngestLagAndAlert` → `ingestLag.get()` → `computeIngestLag`
  (`src/core/health/ingest-lag.ts:146`) — the whole 14-day source scan, in one
  slice.** Two blocks:
  - `sqliteStateReader` `:76-81`: `SELECT … FROM adapter_state WHERE adapter_name = ?`
    `.all()` for **every row of that adapter**, then `new Map(rows.map(…))`. On this
    machine `adapter_state` carries one row per transcript path ever ingested
    (36 k+ sessions), and the whole result set plus the Map build is one synchronous
    statement. Same shape as `scanOnce:115`, which this file already lists.
  - `adapterLag` `:123-139`: `for (const path of await adapter.discover({since}))`
    then `statSource` → **`statSync` per path with no `await` at all in the loop
    body**. `adapter.discover()` in `claude-code.ts:68-97` awaits a real `fs.stat`
    per file, so *the walk yields*; the lag pass throws that away by re-statting
    every returned path synchronously. `LOOKBACK_MS` (`:23`) is 14 days, i.e.
    thousands of files on a busy machine, and the cache in `createIngestLagMonitor`
    (`:211`) is 60 s, so this runs once per alert round — one 1.2 s freeze every
    five minutes, forever, from a job whose whole purpose is to *report* health.

### Scheduler tick — every 30 min (`src/core/scheduler/scheduler.ts`)

`scheduler-tick took 166164ms (sync slice 5750.8ms)`. Wall time is dominated by
classify calls (fine); the 5.75 s slice is not. Per-step, in tick order:

| step | sync? | verdict |
|---|---|---|
| `runCheapChecksOnSqlite` (`integrity/check-invariants.ts:553-593`) | 7 full-table scans + a `COUNT` of each, one slice | already yielded-into via `timeSync("integrity-check")`, but the block itself is unbounded (already §4 above; once/24 h) |
| `scanOnce` (`scan-once.ts:103-158`) | `.all(adapter.name)` of every `adapter_state` row `:112-116`, **then a `statSync` per discovered path `:122-146` with no yield**, then `.run()` per row it must reset | **the tick's 5.75 s slice.** Identical shape to the ingest-lag loop, and it runs every tick for every adapter |
| `parseOrLog` → `adapter.parseSession` | async reads, `JSON.parse` per line of one transcript | yields; bounded by one file |
| `contentHash`, `extractFacts`, `deriveSubagentMeta`, `scanTranscriptDerivables` | per session, CPU only | bounded per session |
| `recordClassified` / `recordSkipped` / `recordFailed` (`scan-once.ts:160-194`) | one indexed upsert + one `SELECT` each | fine per session; the failure path runs *two* statements per failed file inside the loop |
| `insertSession` | row + FTS + entities + markers + vec in one transaction | bounded per session (§4) |
| `bindSessionToWorkstream`, `drainSessionExemplars`, `drainSignals` | awaited, embedder round-trips between writes | fine |
| `pruneReverted` / `applyBucketCap` | was one backlog-sized transaction | fixed in T679 §4 |
| dream passes | `ORDER BY random()`, whole-id-set reads, `readFileSync` of the 13 MB hook log | unchanged, §5 |

### `corpus-monitor` — per boot + every 24 h (`src/cli/nlm.ts:770-822`)

- `computeCorpusStats` (`metrics/corpus-stats.ts:60-130`): `getBodyStats` is the
  chunked model already (`:66-92`). Still one slice each: `COUNT(*) FROM sessions`
  `:63`, the `entities`/`hapaxEntities` pair `:96-101` (`COUNT(CASE WHEN
  session_count = 1 …)` is a full scan, not index-only), the three-way `facts`
  count `:106-113`, `markers` `:121`, `code_exemplars` `:125`. Sub-millisecond each
  at today's row counts; unbounded in general, and 5 of them per run.
- `readFileSync(rederivTrendPath)` `nlm.ts:800` reads the whole append-only trend
  JSONL to look at its last line, then `JSON.parse`s it. The file grows daily —
  today ~114 lines, so minutes-per-year of headroom, all of it synchronous.
- `persistReDerivationPairs` — chunked in T679 §1; `re-derivation.ts:146` (`all
  sessions in the window`) and `:170` (`all edges`) still materialise in one slice,
  and `:183` `JSON.parse`s the whole pairs cache.
- The `store.rawDb()` above means the monitor reads through the serving connection,
  so any of the above freezes request handling directly.

### Jobs the monitor cannot name

`MemoSweepScheduler` (`src/core/hooks/memo-sweep.ts:110-155`, every 5 min, started
outside `timedJob` at `nlm.ts:968`) is `readdirSync` + `statSync` per entry +
`rmSync` (`:70-91`). Small, but it is untracked, and "untracked" is indistinguishable
from "the HTTP path itself" in a stall line — which is exactly the ambiguity Phase 2
is trying to remove.

## Phase 2 conclusion

The timeouts that survive T679 are two directory-scale `statSync` loops that share
one bug — a per-file loop that never yields — living in `ingest-lag.ts:123` (5 min
cadence, and the reason `alert-health` freezes) and `scan-once.ts:122` (30 min
cadence, the tick's 5.75 s slice); plus `computeFactEmbedStats`
(`facts/embed-missing.ts:23-31`), whose three full `facts` counts are now measured
rather than estimated: the `[loop] fact-embed-sweep took … (sync slice 392-605ms)`
lines are those counts, every 2 minutes, so the bound this file deferred in §3 is
now justified by measurement. Everything else on the list above is either already
chunked, sub-millisecond at today's row counts, or documented and cadence-limited.
Part 3 fixes those three and adds `[loop] sync …` instrumentation on the segments it
does not bound, so the next phase starts from numbers instead of from a code read.
