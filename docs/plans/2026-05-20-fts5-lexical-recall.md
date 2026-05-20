# FTS5 Lexical Recall Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NLM's in-memory token-intersection keyword scorer with a SQLite FTS5 BM25-ranked lexical search, behind the existing `SessionStore` port, without regressing recall quality.

**Architecture:** The keyword leg of recall moves from a pure core function (`scoreKeyword`, loads every session into memory and scores by token overlap) to a new `SessionStore.keywordSearch` port method backed by the FTS5 virtual table `sessions_fts`. This mirrors how the semantic leg already works (`semanticSearch` → sqlite-vec). `RecallService` keeps orchestrating filter + merge; it just sources keyword hits from the store instead of computing them. The byte-for-byte parity test suite (pinned to a retired Python scorer) is replaced — *before any production code changes* — by a tolerant golden-set recall-quality test that must stay green through the swap. That golden test is the regression net.

**Key design decision (documented tradeoff):** `sessions_fts` already exists in migration 000 with columns `(label, summary, body)` and sync triggers — it is created and maintained, just never queried. We reuse it as-is rather than adding dedicated `decisions`/`open` FTS columns. Decision and open-question text already lives inside `body` (markers are extracted *from* the body markdown), so BM25 over `(label, summary, body)` covers the same text the old scorer covered. What changes: decision/open lines get `body` column weight rather than the old explicit 2x. BM25's IDF term-rarity weighting compensates. The `matchedIn` badges stay accurate — they are computed in `RecallService` from the resolved `Session` object (which has `decisions[]`/`open[]` from the `markers` table), not from FTS. No FTS schema change, no `MatchField` type change.

**Tech Stack:** TypeScript, better-sqlite3, SQLite FTS5 (built in), vitest. Hexagonal architecture — `core/` depends on the `SessionStore` port; `SqliteSessionStore` is the adapter.

**Branch:** Create and work on `feat/fts5-lexical-recall` off `main`.

**Out of scope:** pgvector (stays the optional power-tier swap, open task #96). The vector leg (`semanticSearch` / sqlite-vec) is untouched.

---

## File Structure

**Created:**
- `tests/fixtures/golden-corpus.ts` — fixed 8-session corpus with realistic `body`, used by the golden recall test.
- `tests/integration/recall-golden.test.ts` — the regression gate: query → expected top-3 assertions, run through `RecallService` + real `SqliteSessionStore`.
- `migrations/008_fts_rebuild.sql` — one-time `INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')` safety rebuild.
- `tests/integration/fts-index.test.ts` — asserts `sessions_fts` is populated and synced after migrations + inserts.
- `tests/integration/keyword-search-fts.test.ts` — exercises `SqliteSessionStore.keywordSearch` directly (ranking + FTS-syntax safety).
- `src/core/recall/match-fields.ts` — pure helper computing `matchedIn` fields for a session against query tokens (the `matchedIn` half of the old `scoreKeyword`).

**Modified:**
- `src/ports/session-store.ts` — add `KeywordNeighbor` interface + `keywordSearch` method.
- `src/core/storage/sqlite-session-store.ts` — implement `keywordSearch`.
- `src/core/recall/recall-service.ts` — keyword + hybrid legs call `store.keywordSearch`; add `runKeyword`; delete `scoreAll`.
- `src/core/recall/index.ts` — drop `scoreKeyword` export; add `keywordMatchFields` export.
- `tests/unit/core/recall-service.test.ts` — `InMemoryStore` fake implements `keywordSearch`; keyword/hybrid tests feed pre-baked hits.
- `tests/integration/recall-sqlite.test.ts` — populate `body` on seed sessions so FTS keyword recall works.

**Deleted:**
- `src/core/recall/score-keyword.ts` — ranking moves to FTS; `matchedIn` logic moves to `match-fields.ts`.
- `tests/unit/core/score-keyword.test.ts` — byte-parity suite, replaced by the golden test.

**Kept (do not delete):**
- `src/core/recall/tokenize.ts` — still imported by `src/core/recall-facts/fact-recall-service.ts` and reused by `keywordSearch` + `match-fields.ts`.

---

## Task 1: Golden-set recall regression test (the gate)

Write the regression net **first**, against the current (unchanged) in-memory scorer. It must pass now and stay green through every later task. Assertions are tolerant — "expected session in top 3" — so they survive the ranking-algorithm change from token-overlap to BM25.

**Files:**
- Create: `tests/fixtures/golden-corpus.ts`
- Create: `tests/integration/recall-golden.test.ts`

- [ ] **Step 1: Create the golden corpus fixture**

Create `tests/fixtures/golden-corpus.ts`:

```typescript
import type { Session } from "../../src/shared/types.js";
import { makeSession } from "./sessions.js";

/**
 * A fixed, realistic corpus for recall-quality regression testing.
 * `body` is populated on every session because FTS5 keyword search indexes
 * label + summary + body. Decision/open text is also present in `body`
 * (mirrors production: markers are extracted from the body markdown).
 */
export const GOLDEN_CORPUS: ReadonlyArray<Session> = [
  makeSession({
    id: "g_fts",
    label: "FTS5 vs pgvector for recall search backend",
    summary: "Compared SQLite FTS5 lexical search against pgvector for the recall layer",
    body: "Evaluated FTS5 versus pgvector. FTS5 ships with SQLite and stays zero-config. pgvector needs Postgres running which breaks the five-minute install.",
    decisions: ["Use FTS5 for the lexical recall leg"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_hono",
    label: "Hono router setup on port 3940",
    summary: "Wired the Hono HTTP router and mounted the recall API",
    body: "Set up Hono as the HTTP framework. Mounted routes for recall, sessions, and the live dashboard on port 3940.",
    decisions: ["Chose Hono over Express for HTTP routing"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_pgvector",
    label: "pgvector migration plan for the power tier",
    summary: "Sketched the Postgres mirror behind the SessionStore port",
    body: "Planned a PostgresSessionStore satisfying the same port as SqliteSessionStore. pgvector handles the vector index for users already running Postgres.",
    open: ["Timing of the SQLite to Postgres cutover"],
    entities: ["NLM", "Postgres"],
  }),
  makeSession({
    id: "g_tauri",
    label: "Tauri desktop packaging for v2 distribution",
    summary: "Plan to wrap the server and SPA in Tauri for signed installers",
    body: "Tauri hosts the Vite SPA in a webview and runs the Node server as a sidecar. Produces dmg, exe, and deb installers.",
    open: ["Whether to rewrite the server in Rust later"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_classifier",
    label: "Ollama classifier latency during backfill",
    summary: "The Ollama classifier runs about one session per second",
    body: "Backfilling a year of history is slow because the Ollama classifier processes roughly one session per second. Considered parallelizing the calls.",
    open: ["Parallelize classifier calls or document the DeepSeek path"],
    entities: ["NLM", "Ollama"],
  }),
  makeSession({
    id: "g_supersede",
    label: "Fact supersedence policy on subject predicate collision",
    summary: "Deterministic supersedence when a newer fact collides with an older one",
    body: "When a new fact shares the same subject and predicate as a current fact, the older row is marked superseded by the new one. Always supersede, even on same value.",
    decisions: ["Always supersede on subject predicate collision"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_toon",
    label: "TOON encoding for MCP tool responses",
    summary: "Encode MCP responses as TOON to cut token usage",
    body: "The MCP server encodes tool responses as TOON when NLM_FORMAT is set to toon. Falls back to JSON when toonEncode throws.",
    decisions: ["TOON-encode MCP responses behind the NLM_FORMAT env flag"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_camofox",
    label: "Camofox audit of the search page",
    summary: "Ran a Camofox browser audit against the recall search UI",
    body: "Camofox audit found the search page returned zero results because the static build ignored query strings. Fixed with client-side hydration.",
    open: ["Should entity facet links filter within search"],
    entities: ["NLM", "Camofox"],
  }),
];

/** query → session id expected to appear in the top 3 keyword results. */
export const GOLDEN_QUERIES: ReadonlyArray<{ query: string; expectTop3: string }> = [
  { query: "FTS5 pgvector search backend", expectTop3: "g_fts" },
  { query: "Hono router", expectTop3: "g_hono" },
  { query: "Tauri packaging installers", expectTop3: "g_tauri" },
  { query: "Ollama classifier latency", expectTop3: "g_classifier" },
  { query: "fact supersedence collision", expectTop3: "g_supersede" },
  { query: "TOON encoding MCP", expectTop3: "g_toon" },
];
```

- [ ] **Step 2: Write the golden recall test**

Create `tests/integration/recall-golden.test.ts`:

```typescript
/**
 * Recall-quality regression gate. A fixed corpus + query/expectation pairs,
 * run through RecallService against a real SqliteSessionStore. Assertions are
 * tolerant (expected session within top 3) so they survive the swap from the
 * token-overlap scorer to FTS5 BM25 ranking. This test must stay green from
 * the current code through every task in this plan.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { GOLDEN_CORPUS, GOLDEN_QUERIES } from "../fixtures/golden-corpus.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

// Keyword-only recall must never touch the embedder; this stub proves it.
class UnreachableEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new LLMUnreachableError("ollama");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("golden recall regression gate", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-golden-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    for (const session of GOLDEN_CORPUS) {
      store.insertSessionForTest(session);
    }
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const { query, expectTop3 } of GOLDEN_QUERIES) {
    it(`keyword recall surfaces "${expectTop3}" in the top 3 for "${query}"`, async () => {
      const svc = new RecallService({ store, llm: new UnreachableEmbedder() });
      const result = await svc.search({ query, mode: "keyword", limit: 10 });
      const top3 = result.results.slice(0, 3).map((r) => r.id);
      expect(top3).toContain(expectTop3);
    });
  }
});
```

- [ ] **Step 3: Run the golden test against current code**

Run: `npm test -- tests/integration/recall-golden.test.ts`
Expected: PASS — all 6 cases. This proves the current in-memory scorer satisfies the golden set; the same test will guard the FTS swap.

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/fts5-lexical-recall
git add tests/fixtures/golden-corpus.ts tests/integration/recall-golden.test.ts
git commit -m "test: add golden-set recall regression gate before FTS5 swap"
```

---

## Task 2: FTS index rebuild migration

`sessions_fts` and its `sessions_ai`/`sessions_au`/`sessions_ad` triggers were declared in migration `000` and have fired on every insert since — the index is normally in sync. Add a one-time `rebuild` as a safety net so the recall path can depend on FTS being complete for all pre-existing rows.

**Files:**
- Create: `migrations/008_fts_rebuild.sql`
- Create: `tests/integration/fts-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/fts-index.test.ts`:

```typescript
/**
 * Verifies the sessions_fts FTS5 index is present and kept in sync with the
 * sessions table after migrations run and rows are inserted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("sessions_fts index", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fts-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("populates sessions_fts via triggers on insert", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "alpha", body: "beta" }));
    store.insertSessionForTest(makeSession({ id: "s2", label: "gamma", body: "delta" }));
    const db = store.rawDb();
    const fts = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions_fts").get();
    const rows = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions").get();
    expect(fts?.n).toBe(rows?.n);
    expect(fts?.n).toBe(2);
  });

  it("records the 008 fts_rebuild migration as applied", () => {
    const db = store.rawDb();
    const row = db
      .prepare<[number], { name: string }>("SELECT name FROM schema_migrations WHERE version = ?")
      .get(8);
    expect(row?.name).toBe("fts_rebuild");
  });

  it("answers a raw FTS5 MATCH query", () => {
    store.insertSessionForTest(makeSession({ id: "s1", label: "pgvector plan", body: "" }));
    const db = store.rawDb();
    const hit = db
      .prepare<[string], { id: string }>(
        "SELECT s.id FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ?",
      )
      .get('"pgvector"');
    expect(hit?.id).toBe("s1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/fts-index.test.ts`
Expected: FAIL on the "records the 008 fts_rebuild migration" case — version 8 is not in `schema_migrations` because the migration file does not exist yet. (The other two cases may already pass — the triggers exist in migration 000.)

- [ ] **Step 3: Write the migration**

Create `migrations/008_fts_rebuild.sql`:

```sql
-- One-time safety rebuild of the sessions_fts external-content FTS5 index.
-- The virtual table and its sync triggers (sessions_ai / sessions_au /
-- sessions_ad) were declared in migration 000 and have fired on every write
-- since, so the index is normally already in sync. This rebuild guarantees
-- the index matches every existing sessions row before the recall path
-- starts depending on FTS5 for keyword search. Safe and idempotent.
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (8, 'fts_rebuild');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/fts-index.test.ts`
Expected: PASS — all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add migrations/008_fts_rebuild.sql tests/integration/fts-index.test.ts
git commit -m "feat: add FTS5 index rebuild migration with sync verification"
```

---

## Task 3: Add `keywordSearch` to the SessionStore port

Add the port method and its `SqliteSessionStore` implementation. The unit-test `InMemoryStore` fake (in `recall-service.test.ts`) also `implements SessionStore`, so it must gain a `keywordSearch` stub in this task or `typecheck` breaks — `RecallService` does not call it until Task 4, so a minimal stub is correct here.

**Files:**
- Modify: `src/ports/session-store.ts`
- Modify: `src/core/storage/sqlite-session-store.ts`
- Modify: `tests/unit/core/recall-service.test.ts:12-27` (add stub method to `InMemoryStore`)
- Test: `tests/integration/keyword-search-fts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/keyword-search-fts.test.ts`:

```typescript
/**
 * Direct coverage of SqliteSessionStore.keywordSearch — FTS5 BM25 ranking
 * and resilience to FTS5 query-syntax metacharacters in user input.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.keywordSearch", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-kw-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.insertSessionForTest(
      makeSession({ id: "s_pg", label: "pgvector migration plan", body: "postgres mirror" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_hono", label: "Hono router", body: "http framework setup" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_misc", label: "unrelated work", body: "nothing in common" }),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ranks the matching session first and returns a positive score", async () => {
    const hits = await store.keywordSearch("pgvector", 10);
    expect(hits[0]?.sessionId).toBe("s_pg");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("matches body text, not just the label", async () => {
    const hits = await store.keywordSearch("framework", 10);
    expect(hits.map((h) => h.sessionId)).toContain("s_hono");
  });

  it("returns an empty array for a query with no indexable tokens", async () => {
    const hits = await store.keywordSearch("---", 10);
    expect(hits).toEqual([]);
  });

  it("does not throw on FTS5 metacharacters in the query", async () => {
    const hits = await store.keywordSearch('pgvector OR (qdrant) NEAR "x"', 10);
    expect(hits.map((h) => h.sessionId)).toContain("s_pg");
  });

  it("respects the limit", async () => {
    const hits = await store.keywordSearch("plan router work", 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/keyword-search-fts.test.ts`
Expected: FAIL — `store.keywordSearch is not a function`.

- [ ] **Step 3: Add the port interface members**

In `src/ports/session-store.ts`, add the `KeywordNeighbor` interface immediately after the existing `SemanticNeighbor` interface (after line 20):

```typescript
export interface KeywordNeighbor {
  readonly sessionId: string;
  readonly score: number;
}
```

Then add the method to the `SessionStore` interface, immediately after the `semanticSearch` declaration (after line 30):

```typescript
  keywordSearch(
    query: string,
    limit: number,
  ): Promise<ReadonlyArray<KeywordNeighbor>>;
```

- [ ] **Step 4: Implement `keywordSearch` in `SqliteSessionStore`**

In `src/core/storage/sqlite-session-store.ts`:

Add to the import from `@ports/session-store.js` (currently `SemanticNeighbor, SessionFilter, SessionStore`) the new `KeywordNeighbor` type:

```typescript
import type {
  KeywordNeighbor,
  SemanticNeighbor,
  SessionFilter,
  SessionStore,
} from "@ports/session-store.js";
```

Add a `tokenize` import below the existing `runMigrations` import (after line 32):

```typescript
import { tokenize } from "@core/recall/tokenize.js";
```

Add the method immediately after `semanticSearch` (after line 461, before `updateStatus`):

```typescript
  /**
   * Lexical recall via the sessions_fts FTS5 index. BM25 column weights
   * favour label over summary over body. Returns sessions ranked best-first
   * with a positive score (the negated bm25() value — bm25 is more negative
   * for better matches). User input is tokenized and rebuilt into a quoted
   * OR query so FTS5 metacharacters cannot reach the MATCH parser.
   */
  async keywordSearch(
    query: string,
    limit: number,
  ): Promise<ReadonlyArray<KeywordNeighbor>> {
    const matchExpr = toMatchExpression(query);
    if (!matchExpr) return [];
    const k = Math.max(1, Math.trunc(limit));
    const rows = this.db
      .prepare<[string, number], { sessionId: string; score: number }>(`
        SELECT s.id AS sessionId,
               -bm25(sessions_fts, 10.0, 4.0, 1.0) AS score
        FROM sessions_fts
        JOIN sessions s ON s.rowid = sessions_fts.rowid
        WHERE sessions_fts MATCH ?
        ORDER BY score DESC
        LIMIT ?
      `)
      .all(matchExpr, k);
    return rows.map((r) => ({ sessionId: r.sessionId, score: r.score }));
  }
```

Add this module-level helper at the end of the file, after the closing brace of the `SqliteSessionStore` class:

```typescript
/**
 * Builds a safe FTS5 MATCH expression from raw user input. Each indexable
 * token becomes a double-quoted string literal; literals are OR-joined.
 * Quoting neutralizes FTS5 operators (AND, OR, NEAR, *, parentheses, colon).
 * Returns null when the query has no indexable tokens.
 */
function toMatchExpression(query: string): string | null {
  const terms = tokenize(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
```

- [ ] **Step 5: Add a `keywordSearch` stub to the `InMemoryStore` test fake**

In `tests/unit/core/recall-service.test.ts`, the `InMemoryStore` class (lines 12-27) `implements SessionStore` and will no longer compile without the new method. Add the import and a minimal stub — Task 4 replaces this stub with a real implementation.

Change the import block (lines 5-8) to include `KeywordNeighbor`:

```typescript
import type {
  KeywordNeighbor,
  SessionStore,
  SemanticNeighbor,
} from "../../../src/ports/session-store.js";
```

Add this method inside `InMemoryStore`, after `semanticSearch` (after line 25):

```typescript
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> {
    return [];
  }
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- tests/integration/keyword-search-fts.test.ts && npm run typecheck`
Expected: PASS — all 5 `keywordSearch` cases; `typecheck` clean.

Run: `npm test -- tests/integration/recall-golden.test.ts`
Expected: PASS — golden gate still green (`RecallService` unchanged, still uses the in-memory scorer).

- [ ] **Step 7: Commit**

```bash
git add src/ports/session-store.ts src/core/storage/sqlite-session-store.ts tests/unit/core/recall-service.test.ts tests/integration/keyword-search-fts.test.ts
git commit -m "feat: add FTS5-backed keywordSearch to the SessionStore port"
```

---

## Task 4: Rewire `RecallService` to use `keywordSearch`

Switch the keyword and hybrid legs from the in-memory `scoreAll`/`scoreKeyword` path to `store.keywordSearch`. `matchedIn` badges are computed in core from the resolved `Session` (which carries `decisions`/`open` from the `markers` table) via a new pure helper, so the `MatchField` type is unchanged and decision/open badges stay accurate.

**Hybrid weighting note:** `mergeHybrid` normalizes each leg by its own max (`score / maxKw`). That normalization absorbs the scale change from token-overlap counts to negated-BM25 values, so the 0.6 semantic / 0.4 keyword split is *deliberately retained* — this is the re-tuning conclusion, verified by the hybrid test below, not an oversight.

**Files:**
- Create: `src/core/recall/match-fields.ts`
- Modify: `src/core/recall/recall-service.ts`
- Modify: `src/core/recall/index.ts`
- Modify: `tests/unit/core/recall-service.test.ts`
- Modify: `tests/integration/recall-sqlite.test.ts`

- [ ] **Step 1: Write the `match-fields` helper with its test**

Create `src/core/recall/match-fields.ts`:

```typescript
/**
 * Computes which session fields a keyword query matched, for the `matchedIn`
 * badge on a RecallHit. Pure function — no DB, no I/O. FTS5 BM25 ranks the
 * whole row; this recovers per-field attribution from the resolved Session,
 * including decisions/open which live in the markers table (not in FTS).
 */

import type { MatchField, Session } from "@shared/types.js";
import { tokenSet } from "./tokenize.js";

type SessionFields = Pick<Session, "label" | "summary" | "decisions" | "open">;

export function keywordMatchFields(
  session: SessionFields,
  queryTokens: ReadonlySet<string>,
): ReadonlyArray<MatchField> {
  if (queryTokens.size === 0) return [];
  const fields: MatchField[] = [];

  if (overlaps(queryTokens, tokenSet(session.label))) fields.push("label");
  if (overlaps(queryTokens, joinedTokens(session.decisions))) fields.push("decisions");
  if (overlaps(queryTokens, joinedTokens(session.open))) fields.push("open");
  if (overlaps(queryTokens, tokenSet(session.summary))) fields.push("summary");

  return fields;
}

function joinedTokens(values: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    for (const t of tokenSet(v)) out.add(t);
  }
  return out;
}

function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) return true;
  return false;
}
```

Create `tests/unit/core/match-fields.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { keywordMatchFields } from "../../../src/core/recall/match-fields.js";
import { tokenSet } from "../../../src/core/recall/tokenize.js";
import { makeSession } from "../../fixtures/sessions.js";

describe("keywordMatchFields", () => {
  it("returns no fields for empty query tokens", () => {
    expect(keywordMatchFields(makeSession({ label: "anything" }), new Set())).toEqual([]);
  });

  it("reports the label field on a label match", () => {
    const session = makeSession({ label: "pgvector migration plan" });
    expect(keywordMatchFields(session, tokenSet("pgvector"))).toEqual(["label"]);
  });

  it("reports decisions and open from marker text", () => {
    const session = makeSession({
      decisions: ["picked Hono for HTTP"],
      open: ["whether to use Tauri later"],
    });
    expect(keywordMatchFields(session, tokenSet("Hono"))).toEqual(["decisions"]);
    expect(keywordMatchFields(session, tokenSet("Tauri"))).toEqual(["open"]);
  });

  it("reports every matching field in label, decisions, open, summary order", () => {
    const session = makeSession({
      label: "recall port",
      summary: "ported recall to TypeScript",
      decisions: ["use sqlite-vec for semantic recall"],
      open: ["recall stats endpoint"],
    });
    expect(keywordMatchFields(session, tokenSet("recall"))).toEqual([
      "label",
      "decisions",
      "open",
      "summary",
    ]);
  });
});
```

- [ ] **Step 2: Run the helper test**

Run: `npm test -- tests/unit/core/match-fields.test.ts`
Expected: PASS — all 4 cases.

- [ ] **Step 3: Rewire `RecallService`**

In `src/core/recall/recall-service.ts`:

Replace the two import lines for `score-keyword` and `tokenize` (lines 20-22) with:

```typescript
import { applyFilter } from "./filter.js";
import { keywordMatchFields } from "./match-fields.js";
import { tokenSet } from "./tokenize.js";
```

Add a keyword overfetch constant next to `SEMANTIC_OVERFETCH` (after line 28):

```typescript
const KEYWORD_OVERFETCH = 3;
```

Replace the keyword-hits block (lines 65-68):

```typescript
    const kwHits =
      mode === "keyword" || mode === "hybrid"
        ? scoreAll(filtered, queryTokens)
        : [];
```

with:

```typescript
    const kwHits =
      (mode === "keyword" || mode === "hybrid") && input.query
        ? await this.runKeyword(
            input.query,
            byId,
            queryTokens,
            limit * KEYWORD_OVERFETCH,
          )
        : [];
```

Add a `runKeyword` private method immediately after the `runSemantic` method (after line 116, before the closing brace of the class):

```typescript
  private async runKeyword(
    query: string,
    byId: ReadonlyMap<string, Session>,
    queryTokens: ReadonlySet<string>,
    fetchLimit: number,
  ): Promise<ReadonlyArray<KeywordHit>> {
    const neighbors = await this.deps.store.keywordSearch(query, fetchLimit);
    const hits: KeywordHit[] = [];
    for (const n of neighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      hits.push({
        session,
        score: n.score,
        matchedIn: keywordMatchFields(session, queryTokens),
      });
    }
    return hits;
  }
```

Delete the now-unused `scoreAll` function (lines 130-142):

```typescript
function scoreAll(
  sessions: ReadonlyArray<Session>,
  queryTokens: ReadonlySet<string>,
): ReadonlyArray<KeywordHit> {
  if (queryTokens.size === 0) return [];
  const hits: KeywordHit[] = [];
  for (const s of sessions) {
    const { score, matchedIn } = scoreKeyword(s, queryTokens);
    if (score > 0) hits.push({ session: s, score, matchedIn });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
```

Note: `filtered` is still used (it builds `byId`), and `queryTokens` is still used (passed to `runKeyword` for `matchedIn`). Leave both. `byId` is built from the entity/kind-filtered set, so `runKeyword` resolving through it naturally drops filtered-out sessions — same pattern as `runSemantic`.

- [ ] **Step 4: Update the recall barrel export**

In `src/core/recall/index.ts`, remove the `scoreKeyword` export (lines 3-4) and add the `keywordMatchFields` export. The file becomes:

```typescript
export { RecallService } from "./recall-service.js";
export type { RecallServiceDeps } from "./recall-service.js";
export { keywordMatchFields } from "./match-fields.js";
export { applyFilter } from "./filter.js";
export type { RecallFilter } from "./filter.js";
export { tokenize, tokenSet } from "./tokenize.js";
```

- [ ] **Step 5: Update the `InMemoryStore` fake and keyword/hybrid unit tests**

Replace the entire contents of `tests/unit/core/recall-service.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import { RecallService } from "../../../src/core/recall/recall-service.js";
import type { LLMClient, EmbedResult } from "../../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../../src/ports/llm-client.js";
import type {
  KeywordNeighbor,
  SessionStore,
  SemanticNeighbor,
} from "../../../src/ports/session-store.js";
import type { Session } from "../../../src/shared/types.js";
import { makeSession } from "../../fixtures/sessions.js";

// Fake store: keyword and semantic hits are pre-baked. Unit tests here cover
// RecallService orchestration (filter, merge, limit, error handling) — not
// keyword ranking quality, which is covered by the FTS integration tests.
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
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> {
    return this.neighbors;
  }
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> {
    return this.keywordHits;
  }
  async updateStatus(): Promise<void> {}
}

class StubEmbedder implements LLMClient {
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    if (this.fail) throw new LLMUnreachableError("ollama");
    return { vector: new Float32Array([1, 0, 0]), model: "stub" };
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

const corpus: Session[] = [
  makeSession({
    id: "a",
    label: "Hono router setup",
    entities: ["NLM"],
    decisions: ["chose Hono over Express"],
  }),
  makeSession({
    id: "b",
    label: "pgvector migration plan",
    entities: ["NLM", "Postgres"],
    open: ["timing of cutover"],
  }),
  makeSession({
    id: "c",
    label: "unrelated session",
    entities: ["Other"],
  }),
];

describe("RecallService.search", () => {
  it("returns empty result when query and filters are all blank", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(),
    });
    const result = await svc.search({ query: "" });
    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("keyword mode surfaces store keyword hits ranked by store score", async () => {
    const store = new InMemoryStore(corpus, [], [
      { sessionId: "b", score: 9.2 },
      { sessionId: "a", score: 2.1 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.results.map((r) => r.id)).toEqual(["b", "a"]);
    expect(result.results[0]?.matchScore).toBe(9.2);
  });

  it("keyword mode populates matchedIn from the resolved session", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 5 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "keyword" });
    expect(result.results[0]?.matchedIn).toEqual(["label"]);
  });

  it("entity filter restricts the keyword corpus", async () => {
    const store = new InMemoryStore(corpus, [], [
      { sessionId: "b", score: 5 },
      { sessionId: "c", score: 4 },
    ]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "session", mode: "keyword", entity: "NLM" });
    expect(result.results.every((r) => r.entities.includes("NLM"))).toBe(true);
    expect(result.results.map((r) => r.id)).not.toContain("c");
  });

  it("semantic mode returns ollama_unreachable when the embedder fails", async () => {
    const svc = new RecallService({
      store: new InMemoryStore(corpus),
      llm: new StubEmbedder(true),
    });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toEqual([]);
  });

  it("hybrid mode degrades to keyword scores when semantic is unavailable", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 7 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder(true) });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe("b");
  });

  it("semantic mode reports cosine similarity computed from L2 distance of unit vectors", async () => {
    const store = new InMemoryStore(corpus, [{ sessionId: "a", distance: 0 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "anything", mode: "semantic" });
    expect(result.results[0]?.matchScore).toBe(1);
  });

  it("hybrid mode blends 0.4 * kw + 0.6 * sem after per-leg normalization", async () => {
    const store = new InMemoryStore(
      corpus,
      [{ sessionId: "b", distance: 0 }],
      [{ sessionId: "b", score: 9.2 }],
    );
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const result = await svc.search({ query: "pgvector", mode: "hybrid" });
    const top = result.results[0];
    expect(top?.id).toBe("b");
    // kwNorm = 1 (only hit / its own max), semNorm = 1 (distance 0) => 0.4 + 0.6 = 1
    expect(top?.matchScore).toBeCloseTo(1, 4);
    expect(top?.keywordScore).toBe(1);
    expect(top?.semanticScore).toBe(1);
  });

  it("clamps limit to MAX_LIMIT (100) and at least 1", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "b", score: 5 }]);
    const svc = new RecallService({ store, llm: new StubEmbedder() });
    const big = await svc.search({ query: "session", mode: "keyword", limit: 9999 });
    expect(big.limit).toBe(100);
    const small = await svc.search({ query: "session", mode: "keyword", limit: 0 });
    expect(small.limit).toBe(1);
  });
});
```

- [ ] **Step 6: Update the integration test seed to populate `body`**

In `tests/integration/recall-sqlite.test.ts`, the seed sessions (lines 42-72) set `label`/`summary` but not `body`. FTS5 keyword search now drives recall, and although `label`/`summary` are indexed, add `body` to each seed session so the corpus is realistic and the keyword cases exercise body matching. Replace the `seed` array (lines 42-72) with:

```typescript
const seed: ReadonlyArray<{ session: Session; embedding: Float32Array }> = [
  {
    session: makeSession({
      id: "sess_a",
      label: "Hono router setup",
      summary: "Wired Hono onto port 3940 with sqlite session store",
      body: "Chose Hono over Express for routing. Mounted the recall API on port 3940.",
      entities: ["NLM"],
      decisions: ["chose Hono over Express for routing"],
    }),
    embedding: unit([1, 0, 0]),
  },
  {
    session: makeSession({
      id: "sess_b",
      label: "pgvector migration plan",
      summary: "Sketched eventual Postgres mirror via PostgresSessionStore port",
      body: "Planned the pgvector power tier. Open question: timing of cutover from SQLite to Postgres.",
      entities: ["NLM", "Postgres"],
      open: ["timing of cutover from SQLite to Postgres"],
    }),
    embedding: unit([0, 1, 0]),
  },
  {
    session: makeSession({
      id: "sess_c",
      label: "TX Tax county scraper",
      summary: "Unrelated work on Texas tax exemption directory",
      body: "Built the Texas tax exemption county scraper and directory pipeline.",
      entities: ["TX Tax Exemptions"],
    }),
    embedding: unit([0, 0, 1]),
  },
];
```

The existing assertions in that file (keyword finds `sess_b` for "pgvector", entity filter on "scraper" excludes non-NLM, hybrid blends) remain valid — `sess_b`'s label still contains "pgvector" and `sess_c`'s body contains "scraper".

- [ ] **Step 7: Run the full recall test set**

Run: `npm test -- tests/integration/recall-golden.test.ts tests/integration/recall-sqlite.test.ts tests/unit/core/recall-service.test.ts tests/unit/core/match-fields.test.ts && npm run typecheck`
Expected: PASS — golden gate green (proves no recall-quality regression through the FTS swap), integration green, unit green, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/recall/match-fields.ts src/core/recall/recall-service.ts src/core/recall/index.ts tests/unit/core/match-fields.test.ts tests/unit/core/recall-service.test.ts tests/integration/recall-sqlite.test.ts
git commit -m "feat: route keyword recall through FTS5 keywordSearch"
```

---

## Task 5: Delete the dead token-overlap scorer

The FTS swap is complete and green. Remove the byte-parity scorer and its test. `tokenize.ts` stays — it is still imported by `src/core/recall-facts/fact-recall-service.ts` and reused by `keywordSearch` and `match-fields.ts`.

**Files:**
- Delete: `src/core/recall/score-keyword.ts`
- Delete: `tests/unit/core/score-keyword.test.ts`

- [ ] **Step 1: Confirm `scoreKeyword` has no remaining references**

Run: `grep -rn "scoreKeyword\|score-keyword" src tests`
Expected: no output. If anything prints, fix that reference before deleting (it should already be gone after Task 4 — `recall-service.ts` and `index.ts` were the only importers).

- [ ] **Step 2: Delete the files**

```bash
git rm src/core/recall/score-keyword.ts tests/unit/core/score-keyword.test.ts
```

- [ ] **Step 3: Confirm `tokenize.ts` is still wired**

Run: `grep -rn "tokenize" src/core/recall-facts src/core/storage src/core/recall`
Expected: references in `fact-recall-service.ts`, `sqlite-session-store.ts`, `match-fields.ts`, `recall-service.ts`, `tokenize.ts` itself. `tokenize.ts` must NOT be deleted.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS — entire suite green, typecheck clean, lint clean. No reference to the deleted scorer.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove token-overlap scorer superseded by FTS5"
```

---

## Task 6: Rebuild `dist/` and update the CHANGELOG

Per the repo protocol, `dist/` is committed (the GitHub install is a pure copy — see the 2026-05-20 CHANGELOG entry) and every session ends with a CHANGELOG append.

**Files:**
- Modify: `dist/` (regenerated)
- Modify: `logs/CHANGELOG/CHANGELOG.md`

- [ ] **Step 1: Rebuild `dist/`**

Run: `npm run build`
Expected: `build:server` and `build:ui` both succeed.

- [ ] **Step 2: Append the CHANGELOG entry**

Prepend a new entry below the title line in `logs/CHANGELOG/CHANGELOG.md` (newest first), matching the existing entry style:

```markdown
## 2026-05-20 — FTS5 lexical recall: keywordSearch replaces the token-overlap scorer

The keyword leg of recall moved from an in-memory token-intersection scorer to a SQLite FTS5 BM25 query behind a new `SessionStore.keywordSearch` port method — symmetric with the existing `semanticSearch` sqlite-vec leg.

**Changes**
- `migrations/008_fts_rebuild.sql` — one-time safety rebuild of the `sessions_fts` index (table + sync triggers already existed in migration 000, just unqueried).
- `SessionStore.keywordSearch(query, limit)` — FTS5 MATCH with BM25 column weights 10/4/1 for label/summary/body; user input tokenized into a quoted OR query so FTS5 metacharacters cannot reach the parser.
- `RecallService` keyword + hybrid legs call `keywordSearch`; `matchedIn` badges computed in core via `match-fields.ts` from the resolved session (keeps decision/open attribution accurate — those live in `markers`, not FTS).
- Byte-parity test suite (pinned to the retired Python scorer) replaced by a tolerant golden-set recall regression test written before the swap and green throughout.
- Deleted `score-keyword.ts`; `tokenize.ts` retained (used by fact recall).

**Decisions**
- Reused `sessions_fts(label, summary, body)` rather than adding `decisions`/`open` FTS columns — decision/open text already lives in `body`. Tradeoff: those lines get `body` weight, not an explicit 2x; BM25 IDF compensates.
- Hybrid 0.6/0.4 split retained — `mergeHybrid` normalizes each leg by its own max, which absorbs the token-count → BM25 scale change.

**State:** v0.3.0. pgvector remains the optional power-tier swap (open task #96), untouched.
```

If the CHANGELOG now exceeds 10 `##` date headings, move the oldest entries to `logs/CHANGELOG/CHANGELOG-2026.md` per the session protocol.

- [ ] **Step 3: Commit**

```bash
git add dist logs/CHANGELOG/CHANGELOG.md
git commit -m "build: rebuild dist for FTS5 recall + CHANGELOG"
```

---

## Self-Review

**Spec coverage:**
- Consensus requirement 1 — replace byte-parity tests with golden-set recall tests → Task 1 (golden gate written first), Task 5 (delete `score-keyword.test.ts`). ✓
- Consensus requirement 2 — wire `sessions_fts` with sync triggers → triggers already existed in migration 000; Task 2 adds the safety rebuild, Task 3 wires the *query* path (`keywordSearch`). ✓
- Consensus requirement 3 — re-tune the 0.6/0.4 hybrid weights → Task 4 documents and verifies that normalize-by-max absorbs the BM25 scale change; the split is deliberately retained, covered by the hybrid unit + integration tests. ✓

**Placeholder scan:** No TBDs, no "add error handling", no "similar to Task N" — every step has complete code or an exact command. ✓

**Type consistency:** `KeywordNeighbor { sessionId, score }` defined in Task 3, consumed unchanged in Task 4 (`runKeyword`, `InMemoryStore.keywordSearch`). `keywordMatchFields` signature defined in Task 4 Step 1, called identically in `runKeyword`. `keywordSearch(query, limit)` signature identical across port, `SqliteSessionStore`, and both fakes. `MatchField` unchanged — `keywordMatchFields` returns only existing members (`label`/`decisions`/`open`/`summary`). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-20-fts5-lexical-recall.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
