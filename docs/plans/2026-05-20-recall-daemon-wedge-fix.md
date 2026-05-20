# Recall Daemon Wedge Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the NLM daemon's `/api/recall` from wedging by making recall fetch only the hit sessions (not the whole 99 MB corpus), and bound the SQLite WAL with checkpoint management.

**Architecture:** `RecallService.search()` currently calls `SqliteSessionStore.list()` on every request, which `SELECT`s the `body` column — 99 MB of session markdown across 2,097 rows — synchronously on the Node event loop (measured 239ms vs 35ms without `body`). better-sqlite3 is synchronous and single-threaded, so concurrent recalls serialize into multi-second head-of-line blocking. The fix: the FTS5 `keywordSearch` / sqlite-vec `semanticSearch` legs already return ranked session IDs — resolve only those (~15) sessions via a new `getByIds` store method that omits `body`, and apply the entity/kind filter after the fetch. Separately, add a periodic `wal_checkpoint(TRUNCATE)` to the daemon so the WAL (currently 38 MB, never drained) stays bounded.

**Tech Stack:** TypeScript (NodeNext, strict), better-sqlite3 11, vitest, Node 22. Hexagonal — `RecallService` depends on the `SessionStore` port; `SqliteSessionStore` is the adapter.

**Root cause** (confirmed by profiling): `sample` of the daemon during a wedge showed ~50% of the window in one synchronous better-sqlite3 query, 85% of that in `vdbeColumnFromOverflow` → `pread` (reading `body` overflow pages). A `/api/health` call measured 8.2s during recall load — the event loop is blocked.

**Branch:** Create and work on `fix/recall-daemon-wedge` off `main`.

**Must stay green:** `tests/integration/recall-golden.test.ts` (the recall-correctness regression gate) and `tests/integration/recall-sqlite.test.ts`.

**Out of scope:** Reducing the leaked `nlm mcp` processes; rearchitecting better-sqlite3 off the main thread. Do not do these.

---

## File Structure

| File | Change |
|---|---|
| `src/ports/session-store.ts` | Add `getByIds` to the `SessionStore` interface. |
| `src/core/storage/sqlite-session-store.ts` | Implement `getByIds` (no `body` column); add `checkpoint()`. |
| `src/core/recall/recall-service.ts` | `search()` fetches only hit sessions; delete `runKeyword`/`runSemantic`; add `uniqueIds`. |
| `src/cli/nlm.ts` | Wire a periodic + boot `wal_checkpoint` into `nlm start`. |
| `tests/unit/core/recall-service.test.ts` | `InMemoryStore` fake gains `getByIds` + call counters; add root-cause test. |
| `tests/integration/getbyids-sqlite.test.ts` | New — covers `SqliteSessionStore.getByIds`. |
| `tests/integration/wal-checkpoint.test.ts` | New — covers `SqliteSessionStore.checkpoint()`. |

---

## Task 1: `getByIds` on the SessionStore port

Add a batched, body-free session fetch. The recall path needs id/label/summary/entities/decisions/open/status for a handful of sessions — never `body`. Omitting `body` is the core of the fix (it is the 99 MB / 239ms cost).

**Files:**
- Modify: `src/ports/session-store.ts`
- Modify: `src/core/storage/sqlite-session-store.ts`
- Modify: `tests/unit/core/recall-service.test.ts` (add `getByIds` to the `InMemoryStore` fake — keeps typecheck green when the port changes)
- Test: `tests/integration/getbyids-sqlite.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/getbyids-sqlite.test.ts`:

```typescript
/**
 * SqliteSessionStore.getByIds — batched, body-free session fetch used by
 * the recall path so it never loads the full corpus.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.getByIds", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-getbyids-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.insertSessionForTest(
      makeSession({ id: "s1", label: "alpha", body: "BODY ONE", entities: ["NLM"], decisions: ["d1"] }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s2", label: "beta", body: "BODY TWO", open: ["q1"] }),
    );
    store.insertSessionForTest(makeSession({ id: "s3", label: "gamma" }));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns only the requested sessions", async () => {
    const got = await store.getByIds(["s1", "s3"]);
    expect(got.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("returns an empty array for an empty id list", async () => {
    expect(await store.getByIds([])).toEqual([]);
  });

  it("ignores ids that do not exist", async () => {
    const got = await store.getByIds(["s2", "missing"]);
    expect(got.map((s) => s.id)).toEqual(["s2"]);
  });

  it("populates entities and markers but omits body (body is empty)", async () => {
    const got = await store.getByIds(["s1"]);
    const s1 = got[0];
    expect(s1?.entities).toEqual(["NLM"]);
    expect(s1?.decisions).toEqual(["d1"]);
    expect(s1?.body).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/getbyids-sqlite.test.ts`
Expected: FAIL — `store.getByIds is not a function`.

- [ ] **Step 3: Add `getByIds` to the port**

In `src/ports/session-store.ts`, add this method to the `SessionStore` interface, immediately after the `getById` declaration:

```typescript
  getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>;
```

- [ ] **Step 4: Implement `getByIds` in `SqliteSessionStore`**

First read `src/core/storage/sqlite-session-store.ts` to confirm the exact shapes of `SessionRow` (a type with `id, runtime, runtime_session_id, started_at, ended_at, duration_min, label, summary, status, transcript_kind, transcript_path, body`), the private helpers `loadEntities(ids)` / `loadMarkers(ids)`, the free function `loadActionOverlay(db)`, and `rowToSession(row, entitiesById, markersById, overlay)` (which sets `body: row.body ?? ""`).

Add this method immediately after `getById` (around line 441):

```typescript
  /**
   * Batched session fetch for the recall path. Deliberately omits the
   * `body` column — body is ~48KB/row of session markdown that recall
   * never reads, and SELECTing it for the corpus is what wedged the
   * daemon. Resolved sessions carry `body: ""`.
   */
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], Omit<SessionRow, "body">>(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path
        FROM sessions
        WHERE id IN (${placeholders})
      `)
      .all(...ids);

    if (rows.length === 0) return [];
    const foundIds = rows.map((r) => r.id);
    const entitiesByIdMap = this.loadEntities(foundIds);
    const markersByIdMap = this.loadMarkers(foundIds);
    const overlay = loadActionOverlay(this.db);
    return rows.map((r) =>
      this.rowToSession({ ...r, body: null }, entitiesByIdMap, markersByIdMap, overlay),
    );
  }
```

Note: `{ ...r, body: null }` reconstitutes a full `SessionRow` so `rowToSession` is reused unchanged — `rowToSession` does `body: row.body ?? ""`, so `null` yields `""`. Do not modify `rowToSession`, `list`, or `getById`.

- [ ] **Step 5: Add `getByIds` to the `InMemoryStore` test fake**

In `tests/unit/core/recall-service.test.ts`, the `InMemoryStore` class `implements SessionStore` and will not compile without the new method. Add this method to `InMemoryStore`, immediately after its `getById` method:

```typescript
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    return this.sessions.filter((s) => ids.includes(s.id));
  }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/integration/getbyids-sqlite.test.ts && npm run typecheck`
Expected: PASS — all 4 `getByIds` cases; typecheck clean (the port change is satisfied by both `SqliteSessionStore` and the `InMemoryStore` fake).

Run: `npm test -- tests/integration/recall-golden.test.ts`
Expected: PASS — golden gate still green (`RecallService` unchanged this task).

- [ ] **Step 7: Commit**

```bash
git checkout -b fix/recall-daemon-wedge
git add src/ports/session-store.ts src/core/storage/sqlite-session-store.ts tests/unit/core/recall-service.test.ts tests/integration/getbyids-sqlite.test.ts
git commit -m "feat: add body-free getByIds batch fetch to the SessionStore port"
```

---

## Task 2: Recall fetches only the hits, not the whole corpus

Refactor `RecallService.search()` so it never calls `store.list()`. The search legs already return ranked IDs — fetch only those sessions via `getByIds`, then apply the entity/kind filter post-fetch. This is the root-cause fix.

**Files:**
- Modify: `src/core/recall/recall-service.ts`
- Modify: `tests/unit/core/recall-service.test.ts`

- [ ] **Step 1: Write the failing root-cause test**

In `tests/unit/core/recall-service.test.ts`, add call counters to the `InMemoryStore` fake. Change the class so it has two public counter fields and increments them. The fake currently looks like:

```typescript
class InMemoryStore implements SessionStore {
  constructor(
    private readonly sessions: Session[],
    private readonly neighbors: SemanticNeighbor[] = [],
    private readonly keywordHits: KeywordNeighbor[] = [],
  ) {}
  async list(): Promise<ReadonlyArray<Session>> {
    return this.sessions;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    return this.sessions.filter((s) => ids.includes(s.id));
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return this.neighbors;
  }
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> {
    return this.keywordHits;
  }
  async updateStatus(): Promise<void> {}
}
```

Replace it with:

```typescript
class InMemoryStore implements SessionStore {
  listCalls = 0;
  getByIdsCalls = 0;
  constructor(
    private readonly sessions: Session[],
    private readonly neighbors: SemanticNeighbor[] = [],
    private readonly keywordHits: KeywordNeighbor[] = [],
  ) {}
  async list(): Promise<ReadonlyArray<Session>> {
    this.listCalls += 1;
    return this.sessions;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    this.getByIdsCalls += 1;
    return this.sessions.filter((s) => ids.includes(s.id));
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return this.neighbors;
  }
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> {
    return this.keywordHits;
  }
  async updateStatus(): Promise<void> {}
}
```

Then add this test inside the `describe("RecallService.search", ...)` block:

```typescript
  it("resolves only the hit sessions and never loads the full corpus", async () => {
    const big: Session[] = Array.from({ length: 100 }, (_, i) =>
      makeSession({ id: `s${i}`, label: `session ${i}` }),
    );
    const store = new InMemoryStore(big, [], [
      { sessionId: "s7", score: 9 },
      { sessionId: "s42", score: 8 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "anything", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["s7", "s42"]);
    expect(store.listCalls).toBe(0);
    expect(store.getByIdsCalls).toBe(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/core/recall-service.test.ts -t "resolves only the hit sessions"`
Expected: FAIL — `store.listCalls` is `1` (the current `search()` calls `list()`), not `0`.

- [ ] **Step 3: Refactor `RecallService.search`**

In `src/core/recall/recall-service.ts`:

(a) Change the port import to add the neighbor types. Replace:

```typescript
import type { SessionStore } from "@ports/session-store.js";
```

with:

```typescript
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionStore,
} from "@ports/session-store.js";
```

(b) Replace the entire `search` method (currently lines 39–106, from `async search(` through its closing `}`) with:

```typescript
  async search(input: RecallQuery): Promise<RecallResult> {
    const mode: RecallMode = input.mode ?? "keyword";
    const limit = clampLimit(input.limit);
    const entity = input.entity ?? null;
    const kind = input.kind ?? null;

    const empty: RecallResult = {
      query: input.query,
      entity,
      kind,
      mode,
      limit,
      total: 0,
      results: [],
    };

    if (!input.query && !entity && !kind) return empty;

    // 1. Search legs — ranked neighbor IDs only. No session bodies loaded.
    const kwNeighbors: ReadonlyArray<KeywordNeighbor> =
      (mode === "keyword" || mode === "hybrid") && input.query
        ? await this.deps.store.keywordSearch(input.query, limit * KEYWORD_OVERFETCH)
        : [];

    let semNeighbors: ReadonlyArray<SemanticNeighbor> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && input.query) {
      try {
        const embedding = await this.deps.llm.embed(input.query, "query");
        semNeighbors = await this.deps.store.semanticSearch(
          embedding.vector,
          limit * SEMANTIC_OVERFETCH,
        );
      } catch (err) {
        if (err instanceof LLMUnreachableError) {
          semError = "ollama_unreachable";
        } else {
          throw err;
        }
      }
    }

    if (mode === "semantic" && semError) {
      return { ...empty, modeUnavailable: semError };
    }

    // 2. Resolve ONLY the hit sessions — never the whole corpus. The
    //    entity/kind filter is applied to the fetched hits; a filtered-out
    //    session is absent from byId and is skipped during resolution.
    const hitIds = uniqueIds(kwNeighbors, semNeighbors);
    const hitSessions = await this.deps.store.getByIds(hitIds);
    const filterArgs: { entity?: string; kind?: typeof input.kind } = {};
    if (input.entity !== undefined) filterArgs.entity = input.entity;
    if (input.kind !== undefined) filterArgs.kind = input.kind;
    const byId = new Map<string, Session>(
      applyFilter(hitSessions, filterArgs).map((s) => [s.id, s]),
    );

    // 3. Build hits from the resolved sessions, preserving leg rank order.
    const queryTokens = input.query
      ? new Set(tokenSet(input.query))
      : new Set<string>();

    const kwHits: KeywordHit[] = [];
    for (const n of kwNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      kwHits.push({
        session,
        score: n.score,
        matchedIn: keywordMatchFields(session, queryTokens),
      });
    }

    const semHits: SemanticHit[] = [];
    for (const n of semNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      semHits.push({ session, similarity: cosineFromL2(n.distance) });
    }

    // 4. Finalize per mode.
    if (mode === "keyword") {
      return finalize(input.query, entity, kind, mode, limit, kwHits.map(toKeywordHit));
    }
    if (mode === "semantic") {
      return finalize(input.query, entity, kind, mode, limit, semHits.map(toSemanticHit));
    }
    const merged = mergeHybrid(kwHits, semHits, byId);
    const result = finalize(input.query, entity, kind, mode, limit, merged);
    return semError ? { ...result, modeUnavailable: semError } : result;
  }
```

(c) Delete the `runSemantic` and `runKeyword` private methods entirely (currently lines 108–142). After this, the `RecallService` class body is just the constructor and `search`.

(d) Add this module-level helper immediately after the `RecallService` class closing brace (before the `interface KeywordHit` declaration):

```typescript
function uniqueIds(
  kw: ReadonlyArray<KeywordNeighbor>,
  sem: ReadonlyArray<SemanticNeighbor>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const n of kw) ids.add(n.sessionId);
  for (const n of sem) ids.add(n.sessionId);
  return [...ids];
}
```

Leave `KeywordHit`, `SemanticHit`, `mergeHybrid`, `toKeywordHit`, `toSemanticHit`, `sessionHitFields`, `finalize`, `clampLimit`, `cosineFromL2`, `round4`, `uniqueFields` unchanged. `applyFilter`, `keywordMatchFields`, `tokenSet` imports stay.

- [ ] **Step 4: Run the root-cause test**

Run: `npm test -- tests/unit/core/recall-service.test.ts`
Expected: PASS — the new root-cause test and all pre-existing `RecallService.search` tests. The pre-existing tests feed `neighbors`/`keywordHits` to the fake and assert ranking/filter/limit/hybrid behavior; the refactor preserves all of it (the fake's `getByIds` returns the corpus sessions matching the hit ids, `applyFilter` drops entity/kind mismatches exactly as before).

If a pre-existing test fails, do NOT weaken it — the refactor has a behavior bug; fix the refactor. The most likely culprit is the entity-filter test: confirm `applyFilter(hitSessions, filterArgs)` runs on the fetched hits and that filtered-out sessions are correctly absent from `byId`.

- [ ] **Step 5: Run the integration + golden suites**

Run: `npm test -- tests/integration/recall-sqlite.test.ts tests/integration/recall-golden.test.ts && npm run typecheck`
Expected: PASS — `recall-golden.test.ts` (the recall-correctness regression gate) green proves the fetch-only-hits refactor did not regress recall quality; typecheck clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — whole suite green. If anything outside the recall files broke, STOP and report it.

- [ ] **Step 7: Commit**

```bash
git add src/core/recall/recall-service.ts tests/unit/core/recall-service.test.ts
git commit -m "fix: recall resolves only hit sessions, never loads the full corpus"
```

---

## Task 3: WAL checkpoint management

The codebase has no checkpoint management — the live WAL has grown to 38 MB and never drains. Add a `checkpoint()` method to the store and a periodic + boot checkpoint to the daemon.

**Files:**
- Modify: `src/core/storage/sqlite-session-store.ts`
- Modify: `src/cli/nlm.ts`
- Test: `tests/integration/wal-checkpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/wal-checkpoint.test.ts`:

```typescript
/**
 * SqliteSessionStore.checkpoint — drains the WAL into the main DB and
 * truncates the -wal file, so it cannot grow unbounded.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.checkpoint", () => {
  let tmp: string;
  let dbPath: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-wal-"));
    dbPath = join(tmp, "canonical.sqlite");
    store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("truncates the -wal file after checkpoint", () => {
    for (let i = 0; i < 30; i++) {
      store.insertSessionForTest(
        makeSession({ id: `s${i}`, label: `session ${i}`, body: "x".repeat(5000) }),
      );
    }
    const walBefore = statSync(`${dbPath}-wal`).size;
    expect(walBefore).toBeGreaterThan(0);

    store.checkpoint();

    const walAfter = statSync(`${dbPath}-wal`).size;
    expect(walAfter).toBe(0);
  });

  it("is safe to call when the WAL is already empty", () => {
    expect(() => store.checkpoint()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/wal-checkpoint.test.ts`
Expected: FAIL — `store.checkpoint is not a function`.

- [ ] **Step 3: Add `checkpoint()` to `SqliteSessionStore`**

In `src/core/storage/sqlite-session-store.ts`, add this method immediately after the `close()` method (near the top of the class, around line 116):

```typescript
  /**
   * Drains the WAL into the main database and truncates the -wal file.
   * WAL mode is on but nothing else checkpoints, so the file grows
   * unbounded under continuous readers. The daemon calls this on an
   * interval. Synchronous — keep the WAL small so each call is cheap.
   */
  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/wal-checkpoint.test.ts`
Expected: PASS — both cases.

- [ ] **Step 5: Wire periodic + boot checkpoint into the daemon**

In `src/cli/nlm.ts`, find the `start` command's `.action(async (opts) => { ... })` (around line 148). After the `serve({ fetch: app.fetch, port: p }, ...)` call and before the `if (opts.scheduler !== false)` block, insert:

```typescript
    // Keep the SQLite WAL bounded. WAL mode is on but nothing else
    // checkpoints it; under continuous readers it grows without limit
    // (it had reached 38 MB), which slows every read. Drain once at boot,
    // then every 5 minutes.
    const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000;
    try {
      store.checkpoint();
    } catch {
      // Boot checkpoint can lose a race with readers — the interval retries.
    }
    const checkpointTimer = setInterval(() => {
      try {
        store.checkpoint();
      } catch {
        // Checkpoint contention — the next tick retries.
      }
    }, WAL_CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref();
```

Then, in the existing `shutdown` function inside the `if (opts.scheduler !== false)` block (currently `const shutdown = () => { scheduler.stop(); store.close(); process.exit(0); };`), add a `clearInterval` call so it becomes:

```typescript
        const shutdown = () => {
          clearInterval(checkpointTimer);
          scheduler.stop();
          store.close();
          process.exit(0);
        };
```

Note: `store` is the concrete `SqliteSessionStore` from `buildStack()`, so `store.checkpoint()` is in scope. `checkpointTimer` is declared in the `.action` closure, so `shutdown` (also in that closure) can reference it.

- [ ] **Step 6: Verify typecheck and the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — typecheck clean, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/sqlite-session-store.ts src/cli/nlm.ts tests/integration/wal-checkpoint.test.ts
git commit -m "fix: bound the SQLite WAL with periodic checkpoint management"
```

---

## Task 4: Rebuild `dist/` and update the CHANGELOG

**Files:**
- Modify: `dist/` (regenerated)
- Modify: `logs/CHANGELOG/CHANGELOG.md`

- [ ] **Step 1: Rebuild `dist/`**

Run: `npm run build`
Expected: `build:server` and `build:ui` both succeed. If the build fails, STOP and report the error.

- [ ] **Step 2: Append the CHANGELOG entry**

Insert this as the newest (first) dated entry in `logs/CHANGELOG/CHANGELOG.md`, immediately below the title/intro block:

```markdown
## 2026-05-20 — Fix: recall daemon wedge (corpus-load + WAL bloat)

`/api/recall` intermittently wedged for 10-25s, starving the whole HTTP server (a health check measured 8.2s during recall load).

**Root cause** — `RecallService.search()` called `SqliteSessionStore.list()` on every request, which `SELECT`ed the `body` column: 99 MB of session markdown across 2,097 rows, loaded synchronously on the Node event loop (239ms with `body` vs 35ms without). better-sqlite3 is synchronous, so concurrent recalls serialized into multi-second head-of-line blocking. A `sample` confirmed ~50% of a wedge window in one synchronous query, 85% of that reading `body` overflow pages. The recall path never uses `body`.

**Changes**
- `SessionStore.getByIds(ids)` — batched session fetch that omits the `body` column.
- `RecallService.search()` no longer calls `list()`. The FTS5 / sqlite-vec legs already return ranked IDs; recall now resolves only those (~15) sessions via `getByIds` and applies the entity/kind filter post-fetch. Per-query cost is O(hits), not O(corpus).
- `SqliteSessionStore.checkpoint()` + a 5-minute (and boot) `wal_checkpoint(TRUNCATE)` in `nlm start` — the WAL had grown to 38 MB with no checkpoint management and never drained.

**State:** v0.3.0. Recall is O(hits); the WAL stays bounded.
```

If `CHANGELOG.md` now exceeds 10 `## ` dated headings, move the oldest beyond 10 into `logs/CHANGELOG/CHANGELOG-2026.md` (prepend) and ensure the `_Older entries archived in CHANGELOG-2026.md_` pointer line is present at the bottom of `CHANGELOG.md`.

- [ ] **Step 3: Final verification**

Run: `npm test && npm run typecheck`
Expected: PASS — full suite green (~290 tests), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add dist logs/CHANGELOG/CHANGELOG.md
git commit -m "build: rebuild dist for the recall wedge fix + CHANGELOG"
```

If Step 2 created/modified `CHANGELOG-2026.md`, `git add logs/CHANGELOG/CHANGELOG-2026.md` before committing.

---

## Self-Review

**Spec coverage:**
- Recall stops loading the whole corpus / `body` → Task 1 (`getByIds` omits `body`) + Task 2 (`search` uses `getByIds`, not `list`). ✓
- Entity/kind filter moves post-fetch → Task 2 Step 3(b), `applyFilter(hitSessions, filterArgs)`. ✓
- WAL checkpoint management → Task 3 (`checkpoint()` + daemon interval + boot drain). ✓
- One-time drain of the current 38 MB WAL → Task 3 Step 5, the boot `store.checkpoint()` runs when the rebuilt daemon next starts. ✓
- Failing test reproducing the root cause → Task 2 Step 1 (`listCalls`/`getByIdsCalls` assertion). ✓
- `dist/` rebuilt, CHANGELOG → Task 4. ✓
- Golden + `recall-sqlite` integration stay green → verified in Task 2 Step 5. ✓

**Placeholder scan:** No TBDs; every code step has complete code; every command has an expected result.

**Type consistency:** `getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>` — identical signature in the port (Task 1 Step 3), `SqliteSessionStore` (Step 4), and the `InMemoryStore` fake (Step 5, Task 2 Step 1). `KeywordNeighbor`/`SemanticNeighbor` imported in `recall-service.ts` (Task 2 Step 3a) and used for `kwNeighbors`/`semNeighbors`. `uniqueIds` defined in Task 2 Step 3d, called in the new `search`. `checkpoint(): void` — defined in Task 3 Step 3, called in Task 3 Step 5. `KeywordHit`/`SemanticHit` unchanged and still consumed by `mergeHybrid`/`toKeywordHit`/`toSemanticHit`. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-20-recall-daemon-wedge-fix.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
