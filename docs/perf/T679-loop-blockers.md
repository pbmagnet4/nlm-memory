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
answers in 0.3-0.6 s. Live build 0.21.21-t1641.1 (main + T806 semantic workers),
DB 1,960,620,032 bytes (1.9 GB), per `[corpus-monitor] warn` in `~/.nlm/daemon.err`.

A query that is fast when idle and times out two thirds of the time is not a slow
query. `recall-over-http.ts` waits `NLM_HOOK_RECALL_TIMEOUT_MS` (default 4000 ms)
for a response inside an outer `NLM_HOOK_DEADLINE_MS` budget (6000 ms): the daemon
was not answering, and the only thing that can stop a single-threaded Node server
from answering is work that never yields. better-sqlite3 is synchronous, so every
statement below runs with the whole HTTP surface frozen for its duration.

## Reading the new instrumentation

Part 1 added (`src/core/scheduler/loop-monitor.ts`, muted with `NLM_LOOP_LOG=0`):

- `[loop] lag p99=<ms> (p50=.. max=.. window=..)` every 5 minutes — the loop is
  blocked even outside a job boundary if `max` is large and no `[loop] <job>` line
  appeared near it.
- `[loop] <job> took <wall>ms (sync slice <ms>; hook budget 4000ms)` whenever one
  synchronous slice inside that named job reached 250 ms. Wall time is not the
  trigger: an ingest tick may await a 90 s classify call and freeze nothing.

Every `setInterval` daemon job in `src/cli/nlm.ts`, the scheduler tick, the
integrity check and each dream pass are named in these lines;
`grep '\[loop\]' ~/.nlm/daemon.err` is the whole investigation.

## Every job with unbounded synchronous SQLite work in one tick

Ranked by how often it runs, because the timeout rate has to be explained by
frequency, not by one expensive daily job. "Slice" is what the whole loop loses.

### 1. `fact-embed-sweep` — every 2 min (`src/cli/nlm.ts:907-927`)

**`computeFactEmbedStats` — `src/core/facts/embed-missing.ts:23-31`.** Three
`COUNT(*)` statements over `facts`, one per slice:

- `:25` active count — full scan of `facts`.
- `:26` missing count — full scan of `facts` *plus* `f.id NOT IN (SELECT id FROM
  fact_embeddings_rowids)`, which materialises the whole embedding rowid set
  (~10^5 rows) into an ephemeral index before probing. Three full passes over a
  1.9 GB database's largest table, in one synchronous slice, 720 times a day.
- `:28` pending count — same anti-join, plus a join.

Called from the daemon at `src/cli/nlm.ts:916`, and also by `/api/health` and
`nlm doctor`, which inherit the same stall.

**`listFactsDueForEmbedding` — `src/core/storage/sqlite-fact-store.ts:496-512`.**
`LIMIT 25` bounds the *output*, not the work: the same
`f.id NOT IN (SELECT id FROM fact_embeddings_rowids)` anti-join at `:507` runs over
every active fact and the result is sorted by `f.created_at` to take the first 25.
Runs every 2 min whether or not anything is pending. The Postgres twin is fine
(`async`, off the loop).

### 2. `wal-checkpoint` — every 5 min (`src/cli/nlm.ts:698-716`)

`src/core/storage/sqlite-session-store.ts:277` runs
`PRAGMA wal_checkpoint(TRUNCATE)`, which drains the WAL and then waits for readers
to drain. Unbounded by construction (WAL had reached 38 MB before this job existed)
and it can block on a busy reader. Kept as-is pending measurement — it is now named
`wal-checkpoint` in the `[loop]` lines, and "only checkpoint when the WAL is above
a threshold" is the obvious fix if it shows up.

### 3. Scheduler tick — every 30 min plus at boot (`src/core/scheduler/scheduler.ts`)

All of these run in the tick's own slices (the tick and each phase are now timed as
`scheduler-tick`, `integrity-check`, `dream-pass:<name>`):

- **`runCheapChecksOnSqlite` — `src/core/integrity/check-invariants.ts`** (called at
  `scheduler.ts:360`. Every check is `SELECT ... FROM <table> WHERE NOT EXISTS
  (...)`; the `LIMIT 6` on each (`:67-180`) caps reported violations, not the scan,
  so each of the ~20 checks is a full scan of `sessions`, `facts`, `session_edges`,
  `session_projects`, `fact_edges` …, and the cycle walk (`:385`, `:517`) runs over
  the whole supersession graph. Once per 24 h via the cache file, but it lands
  inside a serving tick.
- **`pruneReverted` — `src/core/storage/sqlite-code-exemplar-store.ts:304-324`.**
  Collects *every* non-survived exemplar id for the scope, then deletes them, row by
  row, from `code_exemplars` and the `code_exemplars_vec` virtual table, inside one
  `db.transaction(...)`. One slice, size proportional to the backlog.
  `scheduler.ts:598`, every tick when `NLM_CODE_EXEMPLARS_ENABLED=1`.
- **`applyBucketCap` — same file `:254-302`**, `scheduler.ts:608`: same shape
  (`SELECT DISTINCT repo, lang …` over the scope, then per-bucket deletes in one
  transaction).
- `scanOnce` (`src/core/scheduler/scan-once.ts:112-115`) loads all `adapter_state`
  rows per adapter — bounded by the number of tracked source files, so far smaller
  than the items above.
- `insertSession` writes the row, its FTS rows, entity links, markers and vec
  embedding in one synchronous transaction per session (body capped at 200 KB).
  Bounded per session, but it is the per-chunk writes, not the loop, that make
  `scheduler-tick` slices.

### 4. Dream passes — 24 h cadence by default (`src/core/dream/settings.ts:46`)

Registered from `scheduler.ts` and therefore also inside a serving tick:

- **`ORDER BY random() LIMIT ?` over `facts`** — `contradiction-pass.ts:208-216`
  (sample 20), `dedup-pass.ts:139-147` (sample 200),
  `promotion-pass.ts:222-236`. `random()` forces a full scan *and* a sort of every
  tenant-scoped active fact before the `LIMIT` applies. The `LIMIT ?` (200 rows
  "sampling 200 rows") never reduces the scanned set — this is the classic
  "sampled, still scanned the table" mistake.
- **`listActiveFactIdsSqlite` — `promotion-pass.ts:243-255`**: the whole active-fact
  id set, deliberately unsampled (the comment says why), in one slice.
- **`readJsonl` over hook/citation telemetry — `promotion-pass.ts:280-300`**:
  `readFileSync` of `~/.nlm/hook-log.jsonl` (13,145,149 bytes on this machine as of
  2026-11-11) and a `JSON.parse` per line, in one synchronous slice — and the
  window filter at `:302-322` is applied *after* the whole file has been parsed.
  Promotion passes only run when `NLM_DREAM_PROMOTE_PASS` is set.

### 5. `corpus-monitor` — every 24 h (`src/cli/nlm.ts:762-805`)

- **`computeReDerivationRate` — `src/core/metrics/re-derivation.ts`**, called from
  `src/cli/nlm.ts:801` (`persistReDerivationPairs`, 42-day window, not rate-limited
  by `shouldAppendTrend`). Three compounding problems, all in one slice:
  - `:98-118` `listSessionsWithin`: every session in the window, no `LIMIT`, then
    two more queries per session (`session_entities`, `markers`) — an N+1 over the
    whole window, synchronously, thousands of statements without a yield.
  - `:120-124` `listEdges`: every row of `session_edges`.
  - `:155-180`: the pairwise O(n²) loop, whose inner `s.entities.filter(e =>
    t.entities.includes(e))` (`:161`) makes it O(n² · entities) with array scans
    instead of set lookups. The header comment of `persistReDerivationPairs`
    (`src/cli/nlm.ts:244-253`) already calls it "the same O(n^2) scan" — which is
    exactly why `sqlite-outcome-store.ts:80` reads its cache file instead.
- The `COUNT(*)`/`SUM` sweeps in `sqliteCorpusStatsDeps`
  (`src/core/metrics/corpus-stats.ts:92-135`): entity, fact and marker counts are
  each a full scan of their table in one slice.
  **Its `getBodyStats` (`:65-91`) is the pattern to copy** — `SUM(LENGTH(body))`
  chunked into 500-row rowid windows with `setImmediate` between them, added for
  exactly this reason and the reason the body scan is not on this list.

### 6. Opt-in jobs

- `wiki-projection` (`src/cli/nlm.ts:839-855`, only with `NLM_WIKI_DIR`): the whole
  active-fact set per projection, then thousands of sync `writeFileSync`/`statSync`
  calls for the markdown tree.
- `exemplar-backfill` (`src/cli/nlm.ts:874-890`, 24 h) and `signal-prune` (6 h)
  take explicit limits / DELETE-with-cutoff; not on the list.
- `chunk-embed-sweep` (`src/core/embedding/chunk-retry.ts:51-53`, 2 min) is the
  other good example: `listChunksDueForEmbedding(limit 10)` and a per-item await on
  the embedder between writes. `stuckChunksOnSqlite` (`:99-102`) is unbounded but
  runs only under `nlm doctor`.

## What this means for the fix

The two 2-minute statements (missing-embedding stats and the due-list anti-join) are
the only unbounded work that runs often enough to produce the observed
two-thirds-timeout rate, so they are the first to be bounded: count in rowid windows
with a yield between them, and let the anti-join probe by rowid instead of
materialising the rowid set. Everything else on this list is real but daily or
per-tick — a daily freeze explains a few timeouts in a cluster, not most prompts —
so those get the `[loop]` lines first and a bounded fix in follow-up work, with
`wal-checkpoint` and the dream samplers the next suspects once the log says which.
