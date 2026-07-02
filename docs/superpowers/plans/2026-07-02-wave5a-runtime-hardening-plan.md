# Wave 5a: Runtime Hardening + Observability-Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-operation runtime cost on the hot paths (overlay reloads, statement re-prepares, whole-file transcript reads, serial hook fan-out) and make the daemon's cold-start and deadline behavior observable and bounded, without changing recall semantics except where a defect (Hermes noise-floor parity, adapter_state TOCTOU) is being corrected. Each fix pins BEHAVIOR (cache invalidation correctness, deadline fail-open, TOCTOU size used, floor parity), not just a latency number.

**Architecture:** Instance-scoped caches invalidated at the single-writer choke point (action HTTP handlers); tail-read the transcript with a cap that preserves all-turns semantics under the cap; parallelize independent fail-open I/O with `Promise.allSettled` / `Promise.all`; one wall-clock deadline raced around the recall+gate stages; parse-time file size threaded through `ScanResult` so commit records what was classified; workstream membership pushed into the recall SQL leg via `idx_sessions_workstream` behind an additive `SearchOptions` field.

**Tech Stack:** TypeScript ESM, better-sqlite3, pg Pool, Hono, Vitest.

**Verified against:** the working checkout on branch `feat/naming-eval-harness`, 2026-07-02. All line numbers below were re-read on that checkout after Waves 0-4 merged. Where a Wave-0-4 fix already landed part of a finding, the task notes it. Start the wave from a clean base branch (`git switch -c wave5a-runtime-hardening` off the current line); confirm `git status` is clean of unrelated `scripts/eval/_r3e-*` scratch files before committing.

## Global Constraints

- **Postgres is NOT required for most tasks.** Only Task 3 (pg overlay-cache test), Task 5 (pg TOCTOU variant), and Task 7 (pg workstream-SQL parity) need a pg container. Tasks 1, 2, 4, 6 run entirely on sqlite + unit tests with `npm test` and never touch pg.
- pg tests are env-gated on `NLM_PG_TEST_URL` via `describe.skipIf`; they run ONLY via the serial pass `npm run test:pg` (never a parallel multi-file vitest invocation against pg).
- Local pg (Tasks 3/5/7 only): `docker run --rm -d --name nlm-pg-test -e POSTGRES_USER=nlm_test -e POSTGRES_PASSWORD=nlm_test -e POSTGRES_DB=nlm_test -p 5432:5432 pgvector/pgvector:pg16`; `export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"`.
- Full gate after every task: `npm run typecheck` clean + `npm test` green (tolerated: the pre-existing cli-work-digest subprocess flake) + `npm run test:pg` zero failures for the pg-touching tasks (3/5/7); for the sqlite-only tasks (1/2/4/6) `npm run test:pg` is unaffected and may be skipped.
- No new dependencies. No em dashes in ANY text including test names, comments, and commit messages. No comments narrating changes; comments only for non-obvious invariants. Never write a literal NUL byte in source; use the escape sequence.
- Test seeding goes through production write paths (insertSession with factSink, real store methods, real write functions), never a test-only bypass, unless seeding a corrupt state production cannot produce.
- Commit style: `fix(...): ...` / `feat(...): ...` / `perf(...): ...` / `test(...): ...`, one commit per task.
- The `.superpowers/` directory is excluded from all commits; never stage it.

---

### Task 1: Hot-path micro-opts (sqlite insertStmt cache + transcript tail-read)

Two behavior-preserving perf fixes on independent hot paths, no pg. **(A)** `SqliteFactStore.insertStmt()` re-prepares a statement via `db.prepare(...)` on every call (`src/core/storage/sqlite-fact-store.ts:411-421`); the single-fact `insert()` path (line 54) pays a re-prepare per fact. **(B)** `readAllAssistantTurns` reads the ENTIRE transcript via `readFileSync` (`src/core/hook/transcript.ts:72`) on every Stop fire; multi-MB sessions pay it per model response. The citation scan (`src/hook/stop-hook.ts:90-113`) unions text + tool_uses across turns, but the tool_use to prose gap spans a handful of turns, not the whole session, so a generous tail cap preserves the signal.

**Files:**
- Modify: `src/core/storage/sqlite-fact-store.ts` (cache the prepared statement)
- Modify: `src/core/hook/transcript.ts` (tail-read with a cap in `readLines`)
- Test: `tests/unit/core/storage/fact-insert-stmt.test.ts` (new)
- Test: extend `tests/integration/stop-hook.test.ts` (transcript read tests already live here, lines 18-115)

**Interfaces:**
- No public signature changes. `insertStmt()` becomes a lazily-cached getter returning the same `Statement<FactRow>`. `readLines` gains an internal cap constant; `readAllAssistantTurns` / `readLastAssistantTurn` keep their exact return contract for files under the cap.

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/storage/fact-insert-stmt.test.ts` (new). Instantiate a migrated in-memory or temp sqlite store the way `tests/contract/fact-store.contract.ts` harness does (via `SqliteStorage.create`), seed a parent session, then pin statement identity and insert correctness:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../../../fixtures/sessions.js";
import { makeFact } from "../../../fixtures/facts.js";

describe("SqliteFactStore insert statement caching", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-insertstmt-"));
    storage = await SqliteStorage.create({ dbPath: join(dir, "t.db") });
    await storage.sessions.insertSessionForTest(makeSession({ id: "sess_parent" }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses one prepared statement across repeated single inserts", async () => {
    const store = storage.facts as unknown as { insertStmt(): unknown };
    const first = store.insertStmt();
    const second = store.insertStmt();
    expect(second).toBe(first);
  });

  it("cached statement inserts each fact correctly", async () => {
    await storage.facts.insert(makeFact({ id: "fact_1", sourceSessionId: "sess_parent" }));
    await storage.facts.insert(makeFact({ id: "fact_2", sourceSessionId: "sess_parent" }));
    expect(await storage.facts.getById("fact_1")).not.toBeNull();
    expect(await storage.facts.getById("fact_2")).not.toBeNull();
  });
});
```

If `insertSessionForTest` does not exist on the sqlite store, seed the parent session through whatever thin seed the existing `fact-store.contract.ts` sqlite harness uses (read `tests/integration/sqlite-fact-store.test.ts` for the exact seed helper) rather than inventing one.

Then extend `tests/integration/stop-hook.test.ts` in the `readAllAssistantTurns` area. Add a cap-boundary case: write a transcript larger than the cap where the OLDEST turn falls outside the tail window, assert the recent turns are still returned and parseable; and a small-file case asserting ALL turns are returned unchanged (regression guard for under-cap all-turns semantics):

```typescript
it("readAllAssistantTurns returns every turn for a file under the cap", () => {
  const path = join(tmp, "small.jsonl");
  writeTranscript(path, [
    { type: "assistant", message: { content: [{ type: "text", text: "alpha" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "beta" }] } },
  ]);
  const turns = readAllAssistantTurns(path);
  expect(turns.map((t) => t.text)).toEqual(["alpha", "beta"]);
});

it("readAllAssistantTurns tail-reads and drops the truncated leading line for a file over the cap", () => {
  const path = join(tmp, "big.jsonl");
  const filler = { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(4096) }] } };
  const lines: object[] = [];
  // First line is a unique marker we expect to be dropped once the file exceeds the cap.
  lines.push({ type: "assistant", message: { content: [{ type: "text", text: "OLDEST_MARKER" }] } });
  for (let i = 0; i < 200; i++) lines.push(filler);
  lines.push({ type: "assistant", message: { content: [{ type: "text", text: "NEWEST_MARKER" }] } });
  writeTranscript(path, lines);
  const turns = readAllAssistantTurns(path);
  const texts = turns.map((t) => t.text);
  expect(texts).toContain("NEWEST_MARKER");
  expect(texts).not.toContain("OLDEST_MARKER");
});
```

Size the filler so the total comfortably exceeds the 256KB cap (200 * ~4KB ~= 800KB). `writeTranscript` already exists at `tests/integration/stop-hook.test.ts:14`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/core/storage/fact-insert-stmt.test.ts tests/integration/stop-hook.test.ts`
Expected: the statement-identity test FAILS (`insertStmt()` returns a fresh statement each call); the over-cap transcript test FAILS (whole-file read still returns `OLDEST_MARKER`).

- [ ] **Step 3: Cache the prepared statement**

In `src/core/storage/sqlite-fact-store.ts`, add a private cache field on the class (near the constructor at line 45-51) and make `insertStmt()` lazy. Replace lines 411-421:

```typescript
  private cachedInsertStmt: Statement<FactRow> | undefined;

  private insertStmt(): Statement<FactRow> {
    if (!this.cachedInsertStmt) {
      this.cachedInsertStmt = this.db.prepare<FactRow>(`
        INSERT INTO facts (
          id, kind, subject, predicate, value, source_session_id,
          source_quote, created_at, superseded_by, confidence, retired_at
        ) VALUES (
          @id, @kind, @subject, @predicate, @value, @source_session_id,
          @source_quote, @created_at, @superseded_by, @confidence, @retired_at
        )
      `);
    }
    return this.cachedInsertStmt;
  }
```

Import `Statement` from `better-sqlite3` if not already imported (check the existing `import ... from "better-sqlite3"` at the top; `Statement` is a named type export). The `db` handle is fixed at construction (line 51 `private readonly db`), so a cached statement is bound to a stable connection and safe to reuse for the store's lifetime. `insertMany` (line 59) and `ingestSessionFactsInTxn` (line 380) already call `insertStmt()` once per call; they now get the cached instance for free.

- [ ] **Step 4: Tail-read the transcript with a cap**

In `src/core/hook/transcript.ts`, add a cap constant and replace the whole-file read in `readLines` (lines 69-76) with a tail-read. Change the import at line 21 to add the fd primitives:

```typescript
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_TRANSCRIPT_BYTES = 256 * 1024;

function readLines(transcriptPath: string): string[] | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      const start = size > MAX_TRANSCRIPT_BYTES ? size - MAX_TRANSCRIPT_BYTES : 0;
      const len = size - start;
      if (len <= 0) return [];
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8").split("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
```

For files at or under the cap `start === 0`, so the entire file is read and all-turns semantics are byte-identical to today. For files over the cap the tail is read; the (possibly truncated) leading line fails `JSON.parse` in the `readAllAssistantTurns` loop (line 88-91 `try { JSON.parse } catch { continue }`) and is skipped, which is the intended drop-partial-leading-line behavior. `readLastAssistantTurn` (line 99) routes through the same `readLines` and only ever wants the last turn, so the cap never affects it. The cap of 256KB is 4x the recent-context tail (`src/hook/recent-context.ts:21`, 64KB): the citation scan needs the tool_use to prose span (a handful of recent turns) rather than the 3-turn topic window recent-context needs, so a larger cap is defensible; the previous whole-file read was purely defensive.

- [ ] **Step 5: Verify green, gate, commit**

Run the two test files, then `npm run typecheck` + `npm test`.

```bash
git add src/core/storage/sqlite-fact-store.ts src/core/hook/transcript.ts tests/unit/core/storage/fact-insert-stmt.test.ts tests/integration/stop-hook.test.ts
git commit -m "perf(hotpath): cache sqlite fact insert statement; tail-read transcript at 256KB"
```

---

### Task 2: Parallel hook fan-out + Hermes noise-floor parity

Three small hook edits, no pg. **(A, O-3)** stop-hook fires citation POSTs serially (`src/hook/stop-hook.ts:140-147`, `await` inside a `for` loop, `POST_TIMEOUT_MS = 1500` each), worst case `N * 1500ms`. **(B, O-3)** session-start-hook awaits recall then the failure-mode fetch serially (`src/hook/session-start-hook.ts:143-151`), two independent HTTP calls back-to-back, worst case ~4000ms. **(C, I-16)** the Hermes pre-turn lane calls `selectHits` without a `relativeFloor` (`src/http/app.ts:876`), so it runs with the noise floor disabled (0), while both Claude Code lanes apply `parseRelativeFloor(process.env["NLM_RECALL_REL_FLOOR"], 0.9)` (`src/hook/prompt-recall-hook.ts:39,156-163` and `src/hook/session-start-hook.ts:34,64-71`).

**Files:**
- Modify: `src/hook/stop-hook.ts` (allSettled the POSTs)
- Modify: `src/hook/session-start-hook.ts` (Promise.all recall + failure-mode)
- Modify: `src/http/app.ts` (thread relativeFloor into the Hermes selectHits)
- Test: extend `tests/integration/stop-hook.test.ts`, `tests/integration/session-start-hook.test.ts`, `tests/integration/hermes-agent-hooks.test.ts`

**Interfaces:** No signature changes. `runStopHook` still returns the same `StopHookResult`; fail-open behavior is preserved (a failed POST is swallowed and the local memo still records via `recordCited`).

- [ ] **Step 1: Write the failing tests**

Stop-hook concurrency: use a barrier stub so the test fails if POSTs run serially. Add to `tests/integration/stop-hook.test.ts` (in the `runStopHook` describe; read the existing setup that calls `recordSurfaced` to seed surfaced ids and writes a transcript containing NLM tool_use blocks so `fresh` has >= 2 citations):

```typescript
it("fires citation POSTs concurrently, not serially", async () => {
  // Seed >= 2 surfaced ids that the transcript cites so `fresh` has >= 2 entries.
  // (Mirror the existing multi-citation setup in this file.)
  let inFlight = 0;
  let maxInFlight = 0;
  const postCitation = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  };
  await runStopHook(input, { postCitation });
  expect(maxInFlight).toBeGreaterThan(1);
});

it("a rejected citation POST does not abort the others or throw", async () => {
  let calls = 0;
  const postCitation = async () => {
    calls++;
    if (calls === 1) throw new Error("daemon down");
  };
  await expect(runStopHook(input, { postCitation })).resolves.toBeDefined();
  expect(calls).toBeGreaterThan(1);
});
```

Session-start parallelism: `main()` is not directly unit-testable (it reads stdin), so pin the observable ordering behavior at the `runHook` + failure-mode seam. Since `fetchFailureModeBlock` is module-private, add the concurrency assertion at the integration layer already used in `tests/integration/session-start-hook.test.ts`: assert that with both a slow recall and a slow failure-mode endpoint the combined wall time is closer to `max(a,b)` than `a+b`. If the existing test file stubs the HTTP layer, reuse that stub with two ~50ms delays and assert total < 90ms. If it does not, add a focused test that spins the daemon's failure-mode + recall routes with an injected delay; keep it in the same file and same harness style.

Hermes floor: add to `tests/integration/hermes-agent-hooks.test.ts` a case where two hits have a wide score gap (e.g. `matchScore` 0.95 and 0.10) so the 0.9 relative floor drops the low hit; assert the Hermes pre-turn response surfaces only the high hit. Mirror the assertion shape the Claude-lane floor tests already use (search `tests/unit/hook/score-floor.test.ts` for the median-times-floor expectation).

- [ ] **Step 2: RED**

Run: `npx vitest run tests/integration/stop-hook.test.ts tests/integration/session-start-hook.test.ts tests/integration/hermes-agent-hooks.test.ts`
Expected: concurrency test FAILS (`maxInFlight === 1`); session-start timing test FAILS (serial ~100ms); Hermes floor test FAILS (low hit still surfaced).

- [ ] **Step 3: Parallelize the stop-hook POSTs**

In `src/hook/stop-hook.ts`, replace the serial loop (lines 140-147) with `Promise.allSettled`, keeping the local-memo record unconditional:

```typescript
  await Promise.allSettled(
    fresh.map((c) => deps.postCitation(input.conversationId, c.id, c.kind, preview)),
  );
  if (fresh.length > 0) {
    recordCited(input.conversationId, fresh.map((c) => c.id));
  }
```

`allSettled` never rejects, so a single daemon-down POST no longer aborts the batch, and `recordCited` still runs regardless (preserving the do-not-repost-next-fire behavior the old per-POST catch guaranteed).

- [ ] **Step 4: Parallelize session-start recall + failure-mode**

In `src/hook/session-start-hook.ts` `main()`, replace the two serial awaits (lines 143-151) with a single `Promise.all`:

```typescript
    const [out, failureModes] = await Promise.all([
      runHook(
        { conversationId, query },
        {
          mode,
          recall: async (q, cid) =>
            (await recallOverHttp(q, "claude-code", cid === "unknown" ? undefined : cid, "hybrid")).hits,
        },
      ),
      mode === "live" ? fetchFailureModeBlock(workingDirectory) : Promise.resolve(""),
    ]);
    const combined = composeSessionStartOutput(failureModes, out);
```

Both branches are already independently fail-open (`runHook` recall try/catch at lines 57-61; `fetchFailureModeBlock` try/catch returning `""` at lines 102-111), and the outer `main` try/catch (lines 122-155) still fails open, so parallelizing changes only timing.

- [ ] **Step 5: Add the Hermes relativeFloor**

In `src/http/app.ts`, at the top of `registerHermesAgentHookRoutes` (or module scope near the other hook constants) compute the floor once, then thread it into the `selectHits` call at line 876:

```typescript
import { parseRelativeFloor } from "../hook/score-floor.js";

const HERMES_RELATIVE_FLOOR = parseRelativeFloor(process.env["NLM_RECALL_REL_FLOOR"], 0.9);
```

```typescript
      const selected = selectHits({
        hits,
        surfaced,
        scoreThreshold: 0,
        relativeFloor: HERMES_RELATIVE_FLOOR,
        perFireCap: 3,
        perConversationCap: 10,
      });
```

Confirm the import path (`../hook/score-floor.js`) resolves from `src/http/app.ts`; if app.ts uses a path alias for hook modules, match it. `parseRelativeFloor` is a pure function with no sqlite/pg deps (`src/hook/score-floor.ts:33-38`), so importing it into the HTTP layer is safe. Reusing `NLM_RECALL_REL_FLOOR` gives one operator knob across all three lanes.

- [ ] **Step 6: Green, gate, commit**

```bash
git add src/hook/stop-hook.ts src/hook/session-start-hook.ts src/http/app.ts tests/integration/stop-hook.test.ts tests/integration/session-start-hook.test.ts tests/integration/hermes-agent-hooks.test.ts
git commit -m "perf(hooks): parallelize citation POSTs and session-start fetches; add Hermes relative floor parity"
```

---

### Task 3: Overlay caching with invalidation at the write choke point (O-1)

`loadActionOverlay` (sqlite) and `loadActionOverlayPg` (pg) run the append-only actions SELECT + reducer on EVERY session read: sqlite call sites `sqlite-session-store.ts:557,586,612,632` (four read methods including the hot `getByIds` recall path); pg call sites `pg-session-store.ts:91,115,135,154`. The reducer is already extracted (`reduceActionRows`, `overlay.ts:69`, done in Wave 2b). Design: an instance-scoped overlay cache on each session store, invalidated at the ONLY write surface, which is the three action HTTP handlers (`app.ts:1178-1213`, holding `deps.liveStore`). The same store instance is wired to both recall reads and the action handlers (`nlm.ts:306-309` passes `store` as both `store` and `liveStore`), so instance-scoped invalidation reaches the read path.

**Invalidation mechanism decision (PICK ONE, justified):** exported instance method `invalidateOverlayCache()` on each store, called from the three action handlers. Rejected the monotonic actions-count / max-id per-read check because it still costs one query per read, which undercuts O-1's whole point (eliminating per-read DB work on the recall hot path); the invalidate approach gives a TRUE zero-query cache hit. It is race-free because the daemon is single-writer/single-threaded synchronous (sqlite) and the write surface is exactly three handlers on one shared store instance. Rejected a module-level singleton cache in `overlay.ts` because vitest runs many stores in one process and a module global would leak overlay state across independent test stores and across the sqlite/pg boundary; instance scoping isolates it.

**buildDataset decision:** `build-dataset.ts:287` calls `loadActionOverlay(db)` on its OWN transient db handle opened per `/api/dataset` request (`app.ts:1072`). It does NOT share the store cache: it is a low-frequency UI endpoint off the recall hot path, and coupling a transient handle into the store's invalidation lifecycle adds risk for negligible benefit. Leave `buildDataset` uncached.

**Files:**
- Modify: `src/core/storage/sqlite-session-store.ts` (instance cache + `invalidateOverlayCache`)
- Modify: `src/core/storage/pg-session-store.ts` (instance cache + `invalidateOverlayCache`)
- Modify: `src/http/app.ts` (call `invalidateOverlayCache` after each action write)
- Test: `tests/integration/overlay-cache.test.ts` (new, sqlite, NO pg)
- Test: `tests/integration/pg-action-overlay.pg.test.ts` (extend, pg) **[needs pg container]**

**Interfaces:**
- Produces: `invalidateOverlayCache(): void` on both `SqliteSessionStore` and `PgSessionStore`. Read methods consult the instance cache and populate it on miss.

- [ ] **Step 1: Write the failing sqlite test (no pg)**

`tests/integration/overlay-cache.test.ts`. Build a sqlite store via `SqliteStorage.create`, seed a session with one open question through the production insert path, then prove (a) invalidation makes a new action visible and (b) the cache is actually live (a direct write bypassing invalidation stays hidden until `invalidateOverlayCache()`):

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { writeAction } from "../../src/core/actions/actions-log.js";
import { openQuestionId } from "../../src/core/actions/overlay.js";

describe("overlay cache invalidation (sqlite)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-overlaycache-"));
    storage = await SqliteStorage.create({ dbPath: join(dir, "t.db") });
    // Seed a session carrying one open question via the production insert path.
    // (Mirror the seed used in pg-action-overlay.pg.test.ts, sqlite side.)
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a resolve_open action becomes visible after invalidateOverlayCache", async () => {
    const before = await storage.sessions.getByIds(["sess_1"]);
    expect(before[0]?.open?.some((q) => q.text === "the open question")).toBe(true);
    writeAction(storage.sessions.rawDb(), {
      kind: "resolve", subjectType: "open", subjectId: openQuestionId("sess_1", "the open question"),
      /* fill remaining ActionInput fields per parseActionInput's shape */
    });
    storage.sessions.invalidateOverlayCache();
    const after = await storage.sessions.getByIds(["sess_1"]);
    expect(after[0]?.open?.some((q) => q.text === "the open question")).toBe(false);
  });

  it("the cache is live: a write without invalidation stays hidden until invalidated", async () => {
    await storage.sessions.getByIds(["sess_1"]); // populate cache
    writeAction(storage.sessions.rawDb(), { kind: "resolve", subjectType: "open", subjectId: openQuestionId("sess_1", "the open question") /* ... */ });
    const stale = await storage.sessions.getByIds(["sess_1"]);
    expect(stale[0]?.open?.some((q) => q.text === "the open question")).toBe(true); // cache still active
    storage.sessions.invalidateOverlayCache();
    const fresh = await storage.sessions.getByIds(["sess_1"]);
    expect(fresh[0]?.open?.some((q) => q.text === "the open question")).toBe(false);
  });
});
```

Before writing assertions, READ how the sqlite read path projects `resolvedOpens` onto `session.open` (via `rowToSession` + the overlay) and match the field name/shape exactly. Fill the `ActionInput` fields per `parseActionInput` in `app.ts` / the `ActionInput` type in `actions-log.ts` (the second `ActionRow`/`ActionInput` in that module, 9 fields). Reuse the exact `openQuestionId(sessionId, text)` the seed used.

- [ ] **Step 2: RED**

Run: `npx vitest run tests/integration/overlay-cache.test.ts`
Expected: FAIL with `invalidateOverlayCache is not a function` (method does not exist yet).

- [ ] **Step 3: Add the sqlite instance cache**

In `src/core/storage/sqlite-session-store.ts`, add a field near line 174 and a method; change the four read call sites to consult the cache. Import `ActionOverlay` type if not already in scope.

```typescript
  private overlayCache: ActionOverlay | null = null;
  private overlayCacheAt = 0;

  invalidateOverlayCache(): void {
    this.overlayCache = null;
  }

  private overlay(): ActionOverlay {
    // TTL backstop: explicit invalidation covers the daemon's own writers; the
    // 30s expiry bounds staleness if another process ever writes actions to
    // this database file.
    if (this.overlayCache !== null && Date.now() - this.overlayCacheAt < 30_000) {
      return this.overlayCache;
    }
    this.overlayCache = loadActionOverlay(this.db);
    this.overlayCacheAt = Date.now();
    return this.overlayCache;
  }
```

Reviewer amendment: the TTL backstop above is REQUIRED (both adapters, same shape on pg with the async loader). Add one test using vi.useFakeTimers advancing past 30s to prove expiry refreshes without an explicit invalidate.

Replace each `const overlay = loadActionOverlay(this.db);` (lines 557, 586, 612, 632) with `const overlay = this.overlay();`.

- [ ] **Step 4: Add the pg instance cache**

In `src/core/storage/pg-session-store.ts`, add the same field + method, and change the four `Promise.all` legs so the overlay is served from cache on hit:

```typescript
  private overlayCache: ActionOverlay | null = null;

  invalidateOverlayCache(): void {
    this.overlayCache = null;
  }

  private async overlay(): Promise<ActionOverlay> {
    return (this.overlayCache ??= await loadActionOverlayPg(this.pool));
  }
```

At each read method (lines 88-91, 111-116, 132-136, 151-155), drop `loadActionOverlayPg(this.pool)` from the `Promise.all` and instead `await this.overlay()` (either as a separate `await` before/after the `Promise.all`, or keep it inside the array as `this.overlay()`). Keeping it inside the array is fine since `this.overlay()` returns a promise; on a cache hit that promise resolves without a query.

- [ ] **Step 5: Invalidate at the write handlers**

In `src/http/app.ts` `registerActionRoutes`, after each successful write call `store.invalidateOverlayCache()` (`store` is `deps.liveStore`, the concrete union type that has the method on both members):

- `POST /api/action` (after line 1186): `store.invalidateOverlayCache();`
- `POST /api/action/batch` (after line 1201, guard on `ids.length > 0`): `store.invalidateOverlayCache();`
- `POST /api/action/:id/undo` (after the `if (!result) return 404` at line 1211, since undo mutates the overlay): `store.invalidateOverlayCache();`

- [ ] **Step 6: Extend the pg test (needs pg container)**

In `tests/integration/pg-action-overlay.pg.test.ts` add a case mirroring the sqlite live-cache test: read (populate), write an action DIRECTLY via `writeActionPg` (bypassing the handler invalidation), assert the read is still cached, then `storage.sessions.invalidateOverlayCache()` and assert it updates. This proves the pg cache is live and its invalidation works.

- [ ] **Step 7: Green, gate, commit**

Run the sqlite test, then (with pg up) the pg file, then the full three-part gate.

```bash
git add src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts src/http/app.ts tests/integration/overlay-cache.test.ts tests/integration/pg-action-overlay.pg.test.ts
git commit -m "perf(storage): instance-scoped overlay cache invalidated at the action write handlers"
```

---

### Task 4: Hook end-to-end deadline (O-5)

`prompt-recall-hook.ts` `runHook` stacks the recall stage (`await deps.recall(...)`, line 149, bounded by `RECALL_TIMEOUT_MS = 2000` inside `recall-over-http.ts:23`) and the gate stage (`await Promise.all(... g.judge ...)`, line 174, bounded by `GATE_TIMEOUT_MS = 4000` inside `recall-gate.ts:41`) serially, worst case ~6000ms, with NO shared wall-clock deadline and no operator knob (both timeouts are hardcoded constants; no `NLM_*_TIMEOUT` env exists). No pg.

**Deadline default decision:** introduce `NLM_HOOK_DEADLINE_MS`, default **4000**. Justification: 6s stacked is too long to block a user's prompt submission; 4s is a defensible ceiling for a pre-prompt hook, and it tightens rather than merely preserves. The recall stage keeps its own 2s sub-budget; the gate (the expensive, optional stage) is bounded by the REMAINING budget rather than a fixed 4s, so total never exceeds the deadline. At the deadline the hook fails open: it injects whatever candidates it already has (recall timeout yields the same empty result the current catch produces; gate timeout keeps all selected candidates as relevant, matching the gate's own fail-open which returns "relevant" on error).

**Files:**
- Modify: `src/hook/prompt-recall-hook.ts` (shared deadline around the two stages)
- Test: extend `tests/integration/prompt-recall-hook.test.ts`

**Interfaces:**
- `RunHookDeps` gains optional `deadlineMs?: number` (default from env). No caller must change; `main()` passes the env-derived default.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/prompt-recall-hook.test.ts` (the `runHook` describe already injects `recall` and `recallGate.judge` deps, so slow stubs are trivial):

```typescript
it("fails open and skips the gate when the recall stage eats the whole deadline", async () => {
  const out = await runHook(
    { prompt: "what did we decide about pgvector", conversationId: "c1" },
    {
      mode: "live",
      deadlineMs: 60,
      recall: async () => { await new Promise((r) => setTimeout(r, 200)); return hits("sess_a"); },
      recallGate: { mode: "live", judge: async () => { throw new Error("gate must not run"); } },
    },
  );
  expect(out).toBe(""); // recall timed out -> empty -> nothing injected
});

it("keeps all selected candidates when the gate exceeds the remaining deadline", async () => {
  const start = Date.now();
  const out = await runHook(
    { prompt: "what did we decide about pgvector", conversationId: "c1" },
    {
      mode: "live",
      deadlineMs: 120,
      recall: async () => hits("sess_a", "sess_b"),
      recallGate: { mode: "live", judge: async () => { await new Promise((r) => setTimeout(r, 500)); return "irrelevant"; } },
    },
  );
  expect(Date.now() - start).toBeLessThan(300); // did not wait the full 500ms judge
  expect(out).toContain("sess_a"); // gate deadline -> keep all as relevant
  expect(out).toContain("sess_b");
});

it("defaults the deadline from NLM_HOOK_DEADLINE_MS", () => {
  // Assert the exported default parser: parseHookDeadline(undefined) === 4000,
  // parseHookDeadline("2500") === 2500, parseHookDeadline("garbage") === 4000.
});
```

- [ ] **Step 2: RED**

Run: `npx vitest run tests/integration/prompt-recall-hook.test.ts`
Expected: the recall-deadline test FAILS (recall waits 200ms and the gate throws); the gate-deadline test FAILS (waits the full 500ms).

- [ ] **Step 3: Implement the shared deadline**

In `src/hook/prompt-recall-hook.ts`, add a parser and constant near the other env-derived constants (line 39 area), a `withDeadline` helper, and thread the budget through `runHook`:

```typescript
export function parseHookDeadline(raw: string | undefined): number {
  if (raw === undefined) return 4000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

const HOOK_DEADLINE_MS = parseHookDeadline(process.env["NLM_HOOK_DEADLINE_MS"]);

async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
```

Add `readonly deadlineMs?: number;` to `RunHookDeps`. In `runHook` (line 129), compute `const deadline = Date.now() + (deps.deadlineMs ?? HOOK_DEADLINE_MS);` at entry. Wrap the recall stage (line 149):

```typescript
    fetched = normalizeRecall(
      await withDeadline(deps.recall(buildRecallQuery(input)), deadline - Date.now(), { hits: [], facts: [] }),
    );
```

(keep the surrounding try/catch so a rejection still yields the empty result). Wrap the gate stage (lines 171-176): before judging, `const remaining = deadline - Date.now();` and if `remaining <= 0` skip the gate entirely (leave `selected` untouched, i.e. keep all as if relevant). Otherwise race the `Promise.all` of judges against the remaining budget with a fallback that marks every gated candidate `relevant`:

```typescript
    const gateFallback = toGate.map((h) => ({ id: h.id, gate: "relevant" as const }));
    gateDecisions = await withDeadline(
      Promise.all(toGate.map(async (h) => ({ id: h.id, gate: await g.judge(input.prompt, `${h.label}\n${h.summary ?? ""}`) }))),
      remaining,
      gateFallback,
    );
```

Confirm `"relevant"` is the exact gate-decision literal the downstream drop logic treats as keep (read the code just below line 176 that filters `selected` by `gateDecisions`); match it exactly.

Thread the default from `main()` if `main` constructs the deps explicitly (grep for the `runHook(` call in this file's `main`); passing nothing is fine since the default falls back to `HOOK_DEADLINE_MS`.

- [ ] **Step 4: Green, gate, commit**

```bash
git add src/hook/prompt-recall-hook.ts tests/integration/prompt-recall-hook.test.ts
git commit -m "feat(hooks): shared end-to-end recall+gate deadline (NLM_HOOK_DEADLINE_MS, default 4s, fail-open)"
```

---

### Task 5: adapter_state TOCTOU (I-13)

`scan-once.ts` captures the file size at parse time (`st.size`, line 66, used by the unchanged-size gate at line 75) but every record/commit path re-stats the file at commit time instead: `recordClassified:106`, `recordFailed:130`, `recordClassifiedPg:229` (via `getFileSize`), `recordSkippedLowConfidence:250`, `recordSkippedLowConfidencePg:271`; and the scheduler feeds `getFileSize(chunk.sourcePath)` (a fresh stat) to `recordFailedPg` at `scheduler.ts:256,361`. Bytes appended to the transcript during the async `classifyAdaptive` window (`scheduler.ts:248`) are then stamped into `adapter_state.file_size` as processed, but were never classified, and the next tick's unchanged-size gate skips the file forever. `ScanResult` (`scan-once.ts:32-35`) carries no size field. **Verified STILL BROKEN.** Fix: thread the parse-time size through `ScanResult` into the record calls.

**Files:**
- Modify: `src/core/scheduler/scan-once.ts` (add `fileSize` to `ScanResult`; record functions take a size param instead of re-statting)
- Modify: `src/core/scheduler/scheduler.ts` (pass the parse-time size to every record call)
- Test: `tests/unit/core/scheduler/scan-once-toctou.test.ts` (new, sqlite, NO pg)
- Test: extend `tests/integration/scan-once.pg.test.ts` (pg variant) **[needs pg container]**

**Interfaces:**
- `ScanResult` gains `readonly fileSize: number`. `recordClassified` / `recordFailed` / `recordSkippedLowConfidence` and their `*Pg` variants take an explicit `fileSize: number` param (pg `recordFailedPg` already does). `getFileSize` stays (still used by the `scanOncePg` unchanged-size gate).

- [ ] **Step 1: Write the failing sqlite test (no pg)**

`tests/unit/core/scheduler/scan-once-toctou.test.ts`. There is no existing sqlite scan-once test, so mirror the pg harness at `tests/integration/scan-once.pg.test.ts` (its `FixtureAdapter` at lines 45-76, `mkdtempSync` temp file, `utimesSync` to backdate mtime past the idle gate) against `scanOnce` + `recordClassified` on a migrated temp sqlite db:

```typescript
it("records the parse-time size, not the commit-time size, so appended bytes are re-scanned", async () => {
  // 1. Write fixture "line one\n"; backdate mtime.
  // 2. const results = await scanOnce(adapter, 15, db); expect(results).toHaveLength(1);
  //    const parseSize = results[0].fileSize;
  // 3. Simulate the classify window: append "line two\n" to the file AFTER the scan.
  // 4. recordClassified(db, adapter.name, sourcePath, chunk.id, results[0].fileSize);
  // 5. Read adapter_state.file_size; assert it equals parseSize (the pre-append size), NOT the grown size.
  // 6. Backdate mtime again; const next = await scanOnce(adapter, 15, db);
  //    expect(next).toHaveLength(1);  // grew relative to recorded size -> re-scanned
});
```

Assert on `adapter_state.file_size` via a direct `SELECT` (this is an integrity assertion on state production can produce, so a raw read is fine). The key expectation: `file_size === parseSize` and the file is re-surfaced next tick.

- [ ] **Step 2: RED**

Run: `npx vitest run tests/unit/core/scheduler/scan-once-toctou.test.ts`
Expected: FAIL because `results[0].fileSize` is undefined (no field yet) and/or `recordClassified` has no size param and re-stats the grown file, so `file_size` equals the grown size and the next scan returns length 0.

- [ ] **Step 3: Thread the parse-time size**

In `src/core/scheduler/scan-once.ts`:

Add the field to `ScanResult` (lines 32-35):

```typescript
export interface ScanResult {
  readonly chunk: SessionChunk;
  readonly supersedes: string | null;
  readonly fileSize: number;
}
```

Populate it at the sqlite push (line 93) and pg push (line 217) from the parse-time `st.size`:

```typescript
    out.push({ chunk, supersedes, fileSize: st.size });
```
```typescript
    results.push({ chunk, supersedes, fileSize: st.size });
```

In `scanOncePg`, also fix the redundant second stat in the unchanged-size gate (line 200): reuse `st.size` instead of calling `getFileSize(sourcePath)` again, so the gate compares the same parse-time stat:

```typescript
    if (state?.fileSize !== undefined && state.fileSize !== null) {
      if (st.size === state.fileSize) continue;
    }
```

Change the record functions to take `fileSize` and drop the internal `statSync` / `getFileSize`:
- `recordClassified` (98-121): signature `(db, adapterName, sourcePath, sessionId, fileSize: number)`; delete the try/statSync block (104-109) and use `fileSize` in the `.run(...)`.
- `recordFailed` (123-143): signature `(db, adapterName, sourcePath, fileSize: number)`; delete 128-133; use `fileSize`.
- `recordSkippedLowConfidence` (243-264): signature `(db, adapterName, sourcePath, fileSize: number)`; delete 248-253; use `fileSize`.
- `recordClassifiedPg` (223-241): signature `(pool, adapterName, sourcePath, sessionId, fileSize: number)`; delete the `getFileSize` + null-guard (229-230); use `fileSize`.
- `recordSkippedLowConfidencePg` (266-282): signature `(pool, adapterName, sourcePath, fileSize: number)`; delete 271-272; use `fileSize`.
- `recordFailedPg` (284-301): already takes `fileSize`; no change.

Keep `getFileSize` (still used by the `scanOncePg` gate path if you did not inline all of it, and possibly by tests/other callers; grep before deleting).

- [ ] **Step 4: Pass the parse-time size from the scheduler**

In `src/core/scheduler/scheduler.ts`, destructure `fileSize` from each result (line 242) and pass it to every record call:

```typescript
      for (const { chunk, supersedes, fileSize } of results) {
```

- classify failure (255-258): `recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, fileSize)` and `recordFailed(sqliteDb!, adapter.name, chunk.sourcePath, fileSize)`.
- low confidence (272-275): `recordSkippedLowConfidencePg(_pgPool, adapter.name, chunk.sourcePath, fileSize)` and `recordSkippedLowConfidence(sqliteDb!, adapter.name, chunk.sourcePath, fileSize)`.
- classified success (319-322): `recordClassifiedPg(_pgPool, adapter.name, chunk.sourcePath, chunk.id, fileSize)` and `recordClassified(sqliteDb!, adapter.name, chunk.sourcePath, chunk.id, fileSize)`.
- storage failure (360-363): `recordFailedPg(_pgPool, adapter.name, chunk.sourcePath, fileSize)` and `recordFailed(sqliteDb!, adapter.name, chunk.sourcePath, fileSize)`.

This replaces the four `getFileSize(chunk.sourcePath)` fresh-stat calls at commit time with the parse-time `fileSize`. Update the existing pg test's direct `recordFailedPg(...)` calls (`scan-once.pg.test.ts:129,157`) to pass the size they already compute; they can keep using `getFileSize(fixturePath)` since those tests do not simulate an append between parse and commit.

- [ ] **Step 5: Extend the pg TOCTOU test (needs pg container)**

Add a case to `tests/integration/scan-once.pg.test.ts` mirroring Step 1 against `scanOncePg` + `recordClassifiedPg`: scan (capture `fileSize`), append bytes, `recordClassifiedPg(pool, name, path, id, fileSize)`, assert `adapter_state.file_size` equals the parse-time size and the next `scanOncePg` re-surfaces the file.

- [ ] **Step 6: Green, gate, commit**

```bash
git add src/core/scheduler/scan-once.ts src/core/scheduler/scheduler.ts tests/unit/core/scheduler/scan-once-toctou.test.ts tests/integration/scan-once.pg.test.ts
git commit -m "fix(scheduler): record parse-time file size so classify-window appends are re-scanned not lost"
```

---

### Task 6: Warmup readiness + text-embedder warm + /api/health field (O-4 / I-15)

Partially landed already: the CODE embedder warm is fire-and-forget BEFORE `serve()` (`nlm.ts:355`), and the FTS5 warm is fire-and-forget inside the listen callback (`nlm.ts:358-364`). Still open: **(I-15)** the TEXT/recall embedder is NEVER warmed (the only warm helper is `warmCodeEmbedder`; the FTS5 warm uses `mode:"keyword"` which never calls `llm.embed`, so the first `semantic`/`hybrid` recall pays the cold-start cost, blowing the SessionStart 2s budget); and **(O-4 observability)** `/api/health` (`app.ts:526-529`) returns only `{status, service, version}` with no way to tell whether recall is warm, so the ~30-40s cold-boot blind window is silent. No pg.

**Design:** a small shared warmup-state module (process-global, correct for a single daemon; test-resettable). Begin BOTH warmups just before `serve()`; the FTS5 warm (a synchronous better-sqlite3 scan that blocks the loop whenever it runs) is scheduled via `setImmediate` so socket bind is not delayed, then marks the state ready on completion; add a fire-and-forget text-embedder warm ping that marks its own state; expose `warmup` in `/api/health`. This does not eliminate the sync scan's blocking (better-sqlite3 is synchronous) but starts it as early as possible without delaying listen and makes the cold window observable rather than silent.

**Files:**
- Create: `src/core/health/warmup-state.ts`
- Modify: `src/cli/nlm.ts` (begin both warmups before serve, mark state)
- Modify: `src/http/app.ts` (health route returns warmup snapshot)
- Test: `tests/unit/core/health/warmup-state.test.ts` (new)
- Test: extend `tests/integration/http.test.ts` and/or `tests/unit/install/health.test.ts`

**Interfaces:**
- Produces: `markWarm(stage: "fts5" | "textEmbedder"): void`, `warmupSnapshot(): { fts5: boolean; textEmbedder: boolean; ready: boolean }`, `resetWarmupState(): void` (test-only).

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/health/warmup-state.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { markWarm, warmupSnapshot, resetWarmupState } from "../../../../src/core/health/warmup-state.js";

describe("warmup state", () => {
  beforeEach(() => resetWarmupState());

  it("starts cold and not ready", () => {
    expect(warmupSnapshot()).toEqual({ fts5: false, textEmbedder: false, ready: false });
  });

  it("is ready only after both stages warm", () => {
    markWarm("fts5");
    expect(warmupSnapshot().ready).toBe(false);
    markWarm("textEmbedder");
    expect(warmupSnapshot()).toEqual({ fts5: true, textEmbedder: true, ready: true });
  });
});
```

Then extend the health-route test (`tests/integration/http.test.ts`, which already exercises the Hono app): assert `GET /api/health` includes a `warmup` object with `fts5`, `textEmbedder`, `ready` booleans. Reset the module state in the test setup so the assertion is deterministic.

- [ ] **Step 2: RED**

Run: `npx vitest run tests/unit/core/health/warmup-state.test.ts tests/integration/http.test.ts`
Expected: module test FAILS (module missing); health test FAILS (no `warmup` key).

- [ ] **Step 3: Create the warmup-state module**

`src/core/health/warmup-state.ts`:

```typescript
interface WarmupState {
  fts5: boolean;
  textEmbedder: boolean;
}

const state: WarmupState = { fts5: false, textEmbedder: false };

export function markWarm(stage: keyof WarmupState): void {
  state[stage] = true;
}

export function warmupSnapshot(): { fts5: boolean; textEmbedder: boolean; ready: boolean } {
  return { fts5: state.fts5, textEmbedder: state.textEmbedder, ready: state.fts5 && state.textEmbedder };
}

export function resetWarmupState(): void {
  state.fts5 = false;
  state.textEmbedder = false;
}
```

- [ ] **Step 4: Wire the health route**

In `src/http/app.ts` `registerHealthRoute` (lines 526-529), import `warmupSnapshot` from `@core/health/warmup-state.js` (match the alias style app.ts uses) and add the field:

```typescript
  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "nlm-memory", version: pkg.version, warmup: warmupSnapshot() }),
  );
```

`/api/health` stays past the auth gate (whitelisted at app.ts:406-408), so readiness is reachable unauthenticated, which is correct for a liveness/readiness probe.

- [ ] **Step 5: Begin both warmups before serve and mark state**

In `src/cli/nlm.ts` `start` action, replace the current warm placement (the code-embedder warm at 355 and the in-listen-callback FTS5 warm at 358-364) so both warmups begin before `serve()` and each marks its stage. Read the exact `embedder.embed` arity first (recall-service calls `llm.embed(query, "query")`, so the text embedder takes `(text, "query")`):

```typescript
    warmCodeEmbedder(buildCodeEmbedder());

    // Text/recall embedder: fire-and-forget so the first semantic/hybrid recall
    // is not cold. Marks readiness so /api/health reports the warm window.
    void embedder
      .embed("warmup init", "query")
      .then(() => markWarm("textEmbedder"))
      .catch(() => {});

    // FTS5 page-cache warm is a synchronous sqlite scan; defer it past socket
    // bind with setImmediate so listen is not delayed, then mark readiness.
    setImmediate(() => {
      void recall
        .search({ query: "warmup init", mode: "keyword", limit: 1 })
        .then(() => markWarm("fts5"))
        .catch(() => {});
    });

    const p = port();
    serve({ fetch: app.fetch, port: p, hostname: "127.0.0.1" }, (info) => {
      console.error(`nlm-memory http listening on http://localhost:${info.port}`);
    });
```

Import `markWarm` from `@core/health/warmup-state.js`. `embedder` is the recall embedder built at nlm.ts:259; confirm its variable name and `embed` signature at that line and match exactly. If the text embedder is behind a runtime flag the way the code embedder is, mark `textEmbedder` ready immediately when disabled so `ready` is not permanently false on installs that do not use semantic recall (decide based on what `buildEmbedder` returns; if it is always present, no guard is needed).

- [ ] **Step 6: Green, gate, commit**

```bash
git add src/core/health/warmup-state.ts src/cli/nlm.ts src/http/app.ts tests/unit/core/health/warmup-state.test.ts tests/integration/http.test.ts
git commit -m "feat(daemon): warm text embedder at boot and expose warmup readiness on /api/health"
```

---

### Task 7: Push workstream membership into the recall SQL (O-7)

`resolveWorkstreamSessions` (`nlm.ts:269-278`) materializes the full member session-id Set in JS (`listSessionIdsByWorkstreams(members)` wrapped in `new Set(...)`), and `RecallService.search` applies it as a post-fetch JS `.filter()` (`recall-service.ts:169-178`) after the search legs have overfetched with no workstream constraint. `idx_sessions_workstream` (`migrations/025_workstreams.sql:28`, pg parity `migrations/pg/025_workstreams.sql:32` and `001_initial.sql`) covers `sessions.workstream_id`, and the keyword leg SQL already JOINs `sessions s` (`sqlite-session-store.ts:720-730`), so `AND s.workstream_id IN (...)` is trivially addable. This is the highest-risk task because it requires a port change.

**Port-change decision (justified, additive + one resolver reshape):** the search legs (`keywordSearch`/`semanticSearch`) accept only `SearchOptions` which today carries just `includeSuperseded`, so there is NO channel to pass a workstream constraint into the SQL. Extend `SearchOptions` with an optional `workstreamIds?: ReadonlyArray<string>` (backward-compatible: unset means no filter). Change the recall path to resolve the query's workstream to its member WORKSTREAM ids (the survivor chain, already computed as `members` at nlm.ts:276) rather than to a session-id Set, pass them as `searchOpts.workstreamIds`, and delete the post-fetch JS `.filter()`. This replaces the `resolveWorkstreamSessions` dep (returns `Set<string>` session ids) with `resolveWorkstreamMembers` (returns `ReadonlyArray<string>` workstream ids). The change is internal (wired in nlm.ts + createApp, stubbed in tests). It also removes the `listSessionIdsByWorkstreams` round-trip from the recall hot path.

**Files:**
- Modify: `src/ports/session-store.ts` (`SearchOptions.workstreamIds`)
- Modify: `src/core/storage/sqlite-session-store.ts` (keyword + semantic legs honor `workstreamIds`)
- Modify: `src/core/storage/pg-session-store.ts` (same)
- Modify: `src/core/recall/recall-service.ts` (resolver reshape; pass workstreamIds; drop JS filter)
- Modify: `src/cli/nlm.ts` (resolver returns member workstream ids)
- Test: `tests/unit/core/recall/recall-service.test.ts` (extend; stub the reshaped resolver, assert legs receive workstreamIds and JS-filter no longer needed)
- Test: `tests/integration/sqlite-session-store.test.ts` or a focused new file (keyword leg honors `workstreamIds`)
- Test: pg parity in an existing `*.pg.test.ts` session-search file **[needs pg container]**

**Interfaces:**
- `SearchOptions` gains `readonly workstreamIds?: ReadonlyArray<string>`.
- `RecallServiceDeps.resolveWorkstreamSessions?` (recall-service.ts:76) becomes `resolveWorkstreamMembers?: (idOrLabel: string) => Promise<ReadonlyArray<string>>` returning member workstream ids.

- [ ] **Step 1: Grep the blast radius first**

Grep for `resolveWorkstreamSessions` and `listSessionIdsByWorkstreams` across `src/` and `tests/`. Record every caller. If `listSessionIdsByWorkstreams` has callers other than the recall resolver (e.g. MCP `recall_workstream`, CLI), KEEP the method; if the recall resolver was its only caller, removing that call makes it dead and it must be removed (no-dead-code). Note the findings before editing so the final diff has no orphan.

- [ ] **Step 2: Write the failing tests**

Recall-service unit (`tests/unit/core/recall/recall-service.test.ts`): construct a `RecallService` with a fake store whose `keywordSearch` records the `opts` it received, and a `resolveWorkstreamMembers` stub returning `["ws_a"]`. Call `search` with `{ workstream: "Project A", mode: "keyword", ... }`. Assert the store leg received `opts.workstreamIds === ["ws_a"]` and that a hit whose session is NOT in the workstream is absent from the result WITHOUT relying on a post-fetch JS filter (i.e. the fake store returns only member sessions when `workstreamIds` is set):

```typescript
it("passes resolved member workstream ids into the search leg", async () => {
  let seenOpts: unknown;
  const store = makeFakeStore({ keywordSearch: async (_q, _l, opts) => { seenOpts = opts; return [/* member hit */]; } });
  const svc = new RecallService({ store, llm, resolveWorkstreamMembers: async () => ["ws_a"] });
  await svc.search({ query: "x", mode: "keyword", workstream: "Project A", limit: 5 });
  expect((seenOpts as { workstreamIds?: string[] }).workstreamIds).toEqual(["ws_a"]);
});

it("returns empty when the workstream resolves to no members", async () => {
  const svc = new RecallService({ store, llm, resolveWorkstreamMembers: async () => [] });
  const out = await svc.search({ query: "x", mode: "keyword", workstream: "Ghost", limit: 5 });
  expect(out.hits).toEqual([]);
});
```

Storage leg (sqlite): seed two sessions in different workstreams via the production insert path (set `workstream_id`), FTS-match both, call `keywordSearch(q, limit, { workstreamIds: ["ws_a"] })`, assert only the `ws_a` session returns.

- [ ] **Step 3: RED**

Run: `npx vitest run tests/unit/core/recall/recall-service.test.ts tests/integration/sqlite-session-store.test.ts`
Expected: FAIL (`workstreamIds` not in `SearchOptions`; resolver name mismatch; leg ignores the field).

- [ ] **Step 4: Extend the port + both storage legs**

`src/ports/session-store.ts` (lines 34-36):

```typescript
export interface SearchOptions {
  readonly includeSuperseded?: boolean;
  readonly workstreamIds?: ReadonlyArray<string>;
}
```

`sqlite-session-store.ts` `keywordSearch` (713-731): when `opts?.workstreamIds?.length`, append `AND s.workstream_id IN (${placeholders})` to the WHERE and bind the ids (keep the existing `matchExpr` + `k` binds ordered correctly). Do the same in `semanticSearch` (find its JOIN on `sessions s` and add the same clause). When `workstreamIds` is an empty array, return `[]` (a workstream with no members yields no hits, matching the recall-service empty case). Mirror both in `pg-session-store.ts` with `$n` placeholders.

- [ ] **Step 5: Reshape the resolver + drop the JS filter**

`recall-service.ts:70-76` rename the dep to `resolveWorkstreamMembers?: (idOrLabel: string) => Promise<ReadonlyArray<string>>`. In `search` (164-178):

```typescript
    let workstreamIds: ReadonlyArray<string> | null = null;
    if (input.workstream && this.deps.resolveWorkstreamMembers) {
      workstreamIds = await this.deps.resolveWorkstreamMembers(input.workstream);
      if (workstreamIds.length === 0) return empty;
    }
    const searchOpts = {
      ...(input.includeSuperseded === true ? { includeSuperseded: true } : {}),
      ...(workstreamIds ? { workstreamIds } : {}),
    };
```

Build `searchOpts` BEFORE the legs (it is currently built at line 126) and pass it into both `keywordSearch` (129) and `semanticSearch` (137-141). Remove the `allowedWorkstreamIds` block (169-172) and the `.filter(...)` at line 176 so `byId` is built from `applyFilter(hitSessions, filterArgs)` directly. Confirm `empty` is the same empty-result object the method already returns elsewhere.

`nlm.ts:269-278` rename to `resolveWorkstreamMembers` and return the member workstream ids directly (drop the `listSessionIdsByWorkstreams` + `new Set`):

```typescript
    resolveWorkstreamMembers: async (idOrLabel: string): Promise<ReadonlyArray<string>> => {
      const all = await wsStore.listAll();
      const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
      const target = all.find((w) => w.id === idOrLabel)
        ?? all.find((w) => normalizeLabel(w.label) === normalizeLabel(idOrLabel));
      if (!target) return [];
      const survivor = resolveWorkstreamId(target.id, byId);
      return all.filter((w) => resolveWorkstreamId(w.id, byId) === survivor).map((w) => w.id);
    },
```

Update any other `resolveWorkstreamSessions` wiring (createApp / test stubs) found in Step 1. If `listSessionIdsByWorkstreams` is now orphaned per Step 1, remove it from the port and both adapters; if it still has other callers, leave it.

- [ ] **Step 6: pg parity test (needs pg container)**

Add a case to the pg session-search test file asserting `keywordSearch(q, limit, { workstreamIds: [...] })` filters by `workstream_id` on pg identically to sqlite.

- [ ] **Step 7: Green, gate, commit**

```bash
git add src/ports/session-store.ts src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts src/core/recall/recall-service.ts src/cli/nlm.ts tests/
git commit -m "perf(recall): push workstream membership into the search SQL via idx_sessions_workstream"
```

---

## Out of scope

- Making the FTS5 warm truly non-blocking (better-sqlite3 is synchronous; a worker-thread scan is a larger change than this wave warrants; Task 6 makes the window observable and starts it as early as possible instead).
- Sharing the overlay cache with `buildDataset` (Task 3 decision: transient per-request handle, off the hot path, left uncached).
- Env-tuning the recall/gate sub-budgets independently (Task 4 introduces one shared deadline knob, `NLM_HOOK_DEADLINE_MS`; per-stage env knobs are not needed).
- Extracting a shared tail-read helper between `transcript.ts` and `recent-context.ts` (the ~12-line fd pattern is duplicated intentionally to keep Task 1 self-contained and avoid touching the working recent-context module).
- Reworking `resolveWorkstreamId` merge-chain resolution or the workstream store itself (Task 7 only changes what the recall resolver returns and where the filter is applied).
