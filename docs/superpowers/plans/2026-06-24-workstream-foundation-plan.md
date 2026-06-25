# Workstream Foundation (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the keystone of the workstream abstraction — a `workstreams` table, a per-session primary binding written at end-of-session inside the classify sweep, a deterministic match-or-create matcher, merge-chain resolution, session-binding rollup, and a locked gold set to tune the matcher's thresholds.

**Architecture:** A workstream is its own identity/lifecycle object; its *knowledge* is reached by session binding (`fact.source_session_id -> session.workstream_id`), not a duplicated store. A new pure-core module `core/workstream/` holds types, the merge-chain resolver, the matcher, and the rollup queries; one I/O module `bind.ts` orchestrates them and is invoked by the scheduler sweep after classification. Storage gains a `WorkstreamStore` (sqlite + pg parity) plus three session columns. The live binding is gated behind an env flag (default **off**) so production does not create workstreams before Plan D seeds the taxonomy and tunes thresholds.

**Tech Stack:** TypeScript (ESM, `@core`/`@ports` path aliases), better-sqlite3 + sqlite-vec (canonical runtime), Postgres + pgvector (optional power tier, parity-only), vitest, hexagonal ports/adapters.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md`. This plan implements Plan A (FOUNDATION); B/C/D are separate plans.
- **TDD always:** failing test → run-it-fails → minimal impl → green → commit. `npm run test` + `npm run typecheck` must pass before every commit.
- **SQLite + Postgres parity:** every storage method ships in both adapters. SQLite is the verified runtime (`~/.nlm/canonical.sqlite`); Postgres is parity-only (no version-gated runner — see Task 1).
- **Pure core stays pure:** `core/workstream/model.ts`, `resolve.ts`, `match.ts`, `rollup.ts` import no adapter and do no I/O. `bind.ts` is the only I/O module.
- **No new columns on `facts` or `code_exemplars`.** Rollup is a query over existing `source_session_id` / `session_id`. (Spec §4, §8.)
- **Fail open on the hot path:** binding runs in the background sweep, never the prompt path. Any binding error is logged and swallowed — a session that fails to bind stays `workstream_id = NULL` and is retried on resume. Dropping a binding is cheaper than blocking ingest.
- **Public repo hygiene:** never commit home paths, host IPs, or client/infra/venture names. The seed map (`~/.nlm/work-topics.json`) and gold set (`~/.nlm/eval/`) are operator-local and out of the repo.
- **Live binding default off:** the scheduler wiring (Task 9) is gated by env var `NLM_WORKSTREAM_BIND` (default `false`). Plan D flips it after seed + tune + backfill + verify.
- **Daemon code change:** Task 9 edits the scheduler (daemon code). After it, `npm run build:server` + `launchctl kickstart -k gui/$(id -u)/<daemon-label>` and confirm the startup banner. (Behavior is unchanged with the flag off.)
- **Provisional thresholds:** the matcher takes `HIGH`/`LOW` as parameters. Until Plan D's gold-set run sets them from the score distribution, use the documented provisional defaults in Task 5. They are never hard-coded inside `match.ts`.

---

## File Structure

**New — pure core (`src/core/workstream/`):**
- `model.ts` — pure types: `Workstream`, `WorkstreamStatus`, `BindingSource`, `WorkstreamCandidate`, `MatchInputs`, `MatchDecision`, `MatchThresholds`, `MatchWeights`, `WorkstreamRollup`. Plus `normalizeLabel()` and `makeWorkstreamId()`.
- `resolve.ts` — pure `resolveWorkstreamId(id, byId)`: walk `merged_into` to the live survivor, cycle-guarded.
- `match.ts` — pure `matchWorkstream(inputs)`: blend semantic + entity signals, three-band decision.
- `rollup.ts` — `rollupWorkstream(deps, workstreamId)`: resolve → sessions → current facts + exemplars. Queries via injected store handles (no direct I/O of its own).
- `bind.ts` — `bindSessionToWorkstream(deps, input)`: the I/O orchestrator the scheduler calls.

**New — storage:**
- `src/ports/workstream-store.ts` — `WorkstreamStore` port.
- `src/core/storage/sqlite-workstream-store.ts` — SQLite adapter.
- `src/core/storage/pg-workstream-store.ts` — Postgres adapter.
- `migrations/025_workstreams.sql` — SQLite schema (version-gated).
- `migrations/pg/025_workstreams.sql` — Postgres delta (manual-apply).

**New — eval:**
- `scripts/eval/tune-matcher.ts` — gold-set runner + threshold sweep.
- `scripts/eval/lib/matcher-gold.ts` — gold-set loader + metric computation (pure, unit-tested).
- `tests/fixtures/matcher-gold-sample.jsonl` — synthetic gold fixture for harness tests.

**Modified:**
- `migrations/pg/001_initial.sql` — add workstream tables + session columns for fresh PG installs.
- `src/ports/storage.ts` — add `readonly workstreams: WorkstreamStore`.
- `src/core/storage/sqlite-storage.ts` — build + expose `SqliteWorkstreamStore`.
- `src/core/storage/pg-storage.ts` — build + expose `PgWorkstreamStore`.
- `src/ports/session-store.ts` — add `setWorkstreamBinding`, `listSessionIdsByWorkstreams`, `getEntities`.
- `src/core/storage/sqlite-session-store.ts` + `pg-session-store.ts` — implement the three new session methods.
- `src/ports/fact-store.ts` + sqlite/pg impls — add `listBySessions`.
- `src/ports/code-exemplar-store.ts` + sqlite/pg impls — add `listBySessions`.
- `src/core/scheduler/scheduler.ts` — wire the flag-gated bind call after `recordClassified`.

---

## Canonical Type Contracts (defined once; every task uses these names)

```typescript
// src/core/workstream/model.ts
export type WorkstreamStatus = "active" | "merged" | "retired";

export interface Workstream {
  readonly id: string;             // "ws_<uuid>"
  readonly label: string;
  readonly status: WorkstreamStatus;
  readonly mergedInto: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSessionAt: string | null;
}

// v2 adds "provisional-recall"; v1 writes only these two.
export type BindingSource = "classifier" | "operator";

// A workstream paired with its derived entity set (from workstream_entities).
export interface WorkstreamCandidate {
  readonly workstreamId: string;
  readonly entities: ReadonlyArray<string>;
}

export interface MatchThresholds {
  readonly high: number;  // >= high -> auto-bind
  readonly low: number;   // < low   -> create
}

export interface MatchWeights {
  readonly semantic: number; // weight on semantic-neighbor signal
  readonly entity: number;   // weight on entity-overlap signal (semantic + entity sum to 1)
}

export interface MatchInputs {
  readonly sessionEntities: ReadonlyArray<string>;
  // semantic-neighbor signal: each candidate workstream's best neighbor similarity in [0,1].
  readonly neighborScores: ReadonlyMap<string, number>;
  // entity-overlap signal: candidate workstreams with their entity sets.
  readonly candidates: ReadonlyArray<WorkstreamCandidate>;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
}

export type MatchDecision =
  | { readonly kind: "bind"; readonly workstreamId: string; readonly confidence: number }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<{ readonly workstreamId: string; readonly score: number }> }
  | { readonly kind: "create"; readonly confidence: number };

export interface WorkstreamRollup {
  readonly workstream: Workstream;
  readonly sessionIds: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<import("../../shared/types.js").Fact>;
  readonly exemplars: ReadonlyArray<import("../../shared/types.js").CodeExemplar>;
}
```

```typescript
// src/ports/workstream-store.ts
import type { Workstream } from "@core/workstream/model.js";

export interface WorkstreamStore {
  create(input: { id: string; label: string }): Promise<Workstream>;
  getById(id: string): Promise<Workstream | null>;
  findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null>;
  listAll(): Promise<ReadonlyArray<Workstream>>;
  touchLastSession(id: string, atIso: string): Promise<void>;
  /** Upsert (workstream, entity) edges, incrementing session_count by 1 each. */
  upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void>;
  /** entity sets for the given workstreams, keyed by workstream id. */
  entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>>;
  /** workstreams sharing >=1 entity with `entities` (for the entity-overlap shortlist). */
  candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>>;
}
```

```typescript
// added to src/ports/session-store.ts (SessionStore interface)
setWorkstreamBinding(sessionId: string, workstreamId: string | null, source: BindingSource | null, confidence: number | null): Promise<void>;
listSessionIdsByWorkstreams(workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
getEntities(sessionId: string): Promise<ReadonlyArray<string>>;

// added to src/ports/fact-store.ts (FactStore interface)
listBySessions(sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>>;

// added to src/ports/code-exemplar-store.ts (CodeExemplarStore interface)
listBySessions(sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>>;
```

---

## Task 1: Schema migration (workstreams + session columns + workstream_entities)

**Files:**
- Create: `migrations/025_workstreams.sql`
- Create: `migrations/pg/025_workstreams.sql`
- Modify: `migrations/pg/001_initial.sql` (append new tables + columns for fresh PG installs)
- Test: `tests/integration/workstream-migration.test.ts`

**Interfaces:**
- Produces: tables `workstreams`, `workstream_entities`; columns `sessions.workstream_id`, `sessions.binding_source`, `sessions.binding_confidence`.

**Background (verified):** SQLite migrations are version-gated by `src/core/storage/migrate.ts` — it applies any `migrations/NNN_*.sql` whose integer prefix is not yet in `schema_migrations`, each file ending with its own `INSERT OR IGNORE INTO schema_migrations`. Latest is `024`. Postgres has **no** version-gated runner: `PgStorage.init` runs only `migrations/pg/001_initial.sql`. PG parity deltas (e.g. `migrations/pg/019_split_replaces.sql`) are applied manually by an operator. So new tables must be (a) added to `pg/001_initial.sql` for fresh installs and (b) shipped as a `pg/025_workstreams.sql` delta for existing installs.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/workstream-migration.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("migration 025 — workstreams", () => {
  it("creates workstream tables and session binding columns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-ws-mig-"));
    const storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    const db = storage.sessions.rawDb();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain("workstreams");
    expect(tables).toContain("workstream_entities");

    const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((r: any) => r.name);
    expect(sessionCols).toContain("workstream_id");
    expect(sessionCols).toContain("binding_source");
    expect(sessionCols).toContain("binding_confidence");

    // idempotent: a second init applies nothing new
    await storage.init();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-migration.test.ts`
Expected: FAIL — `expect(tables).toContain("workstreams")` fails (table absent).

- [ ] **Step 3: Write the SQLite migration**

```sql
-- migrations/025_workstreams.sql
-- Workstream abstraction (#367) Plan A: a persistent container a session binds
-- to at end-of-session. See docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md.

CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY,           -- ws_<uuid>
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','retired')),
  merged_into     TEXT REFERENCES workstreams(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_session_at TEXT
);

CREATE TABLE IF NOT EXISTS workstream_entities (
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical),
  session_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, entity_canonical)
);

CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity ON workstream_entities(entity_canonical);

ALTER TABLE sessions ADD COLUMN workstream_id TEXT REFERENCES workstreams(id);
ALTER TABLE sessions ADD COLUMN binding_source TEXT;
ALTER TABLE sessions ADD COLUMN binding_confidence REAL;

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (25, 'workstreams');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/workstream-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the Postgres parity (delta + fresh-install)**

```sql
-- migrations/pg/025_workstreams.sql
-- PG parity for SQLite migration 025 (workstreams). One-shot, applied manually
-- against a PG canonical store (PgStorage.init only runs 001_initial.sql; there
-- is no version-gated runner on the PG side). Mirrors migrations/025_workstreams.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
  merged_into     TEXT REFERENCES workstreams(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_session_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workstream_entities (
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical),
  session_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workstream_id, entity_canonical)
);

CREATE INDEX IF NOT EXISTS idx_workstream_entities_entity ON workstream_entities(entity_canonical);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workstream_id TEXT REFERENCES workstreams(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS binding_source TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS binding_confidence DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_sessions_workstream ON sessions(workstream_id);

COMMIT;
```

Then append the same `CREATE TABLE workstreams` / `workstream_entities` / index statements and the three `sessions` columns to `migrations/pg/001_initial.sql` so fresh PG installs get them (add the columns to the `CREATE TABLE sessions (...)` body; add the two new tables after it). Use `TIMESTAMPTZ` / `DOUBLE PRECISION` as above.

- [ ] **Step 6: Run full suite + typecheck, then commit**

Run: `npm run test && npm run typecheck`
Expected: PASS (no regressions).

```bash
git add migrations/025_workstreams.sql migrations/pg/025_workstreams.sql migrations/pg/001_initial.sql tests/integration/workstream-migration.test.ts
git commit -m "feat(workstream): schema — workstreams, workstream_entities, session binding columns (#367)"
```

---

## Task 2: Workstream model types + merge-chain resolver (`resolve.ts`)

**Files:**
- Create: `src/core/workstream/model.ts`
- Create: `src/core/workstream/resolve.ts`
- Test: `tests/unit/core/workstream/resolve.test.ts`

**Interfaces:**
- Produces: all types in **Canonical Type Contracts** above; `normalizeLabel(label: string): string`; `makeWorkstreamId(): string`; `resolveWorkstreamId(id: string, byId: ReadonlyMap<string, { id: string; mergedInto: string | null }>): string`.
- Consumes: nothing.

**Background (verified):** mirrors the replaces-chain walk in `src/ui/lib/thread-groups.ts:56-67` (`liveHead`), adapted from `replaced_by`/`status==='replaced'` to `merged_into`. Existing id style is `fact_<randomUUID()>`; we use `ws_<randomUUID()>` to match house style (the spec says "ulid", but there is no ulid dependency and `created_at` already provides ordering — a UUID is the consistent, dependency-free choice).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/workstream/resolve.test.ts
import { describe, expect, it } from "vitest";
import { resolveWorkstreamId } from "../../../../src/core/workstream/resolve.js";
import { makeWorkstreamId, normalizeLabel } from "../../../../src/core/workstream/model.js";

const node = (id: string, mergedInto: string | null) => [id, { id, mergedInto }] as const;

describe("resolveWorkstreamId", () => {
  it("returns the id unchanged when it is the live survivor", () => {
    const map = new Map([node("ws_a", null)]);
    expect(resolveWorkstreamId("ws_a", map)).toBe("ws_a");
  });

  it("walks a merge chain to the live survivor", () => {
    const map = new Map([node("ws_a", "ws_b"), node("ws_b", "ws_c"), node("ws_c", null)]);
    expect(resolveWorkstreamId("ws_a", map)).toBe("ws_c");
  });

  it("returns the id unchanged when not present in the map (fail-open)", () => {
    expect(resolveWorkstreamId("ws_missing", new Map())).toBe("ws_missing");
  });

  it("does not loop forever on a cycle", () => {
    const map = new Map([node("ws_a", "ws_b"), node("ws_b", "ws_a")]);
    const out = resolveWorkstreamId("ws_a", map);
    expect(["ws_a", "ws_b"]).toContain(out);
  });
});

describe("model helpers", () => {
  it("makeWorkstreamId is prefixed and unique", () => {
    const a = makeWorkstreamId(), b = makeWorkstreamId();
    expect(a.startsWith("ws_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("normalizeLabel lowercases and collapses whitespace", () => {
    expect(normalizeLabel("  NLM   Memory ")).toBe("nlm memory");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `model.ts`**

```typescript
// src/core/workstream/model.ts
import { randomUUID } from "node:crypto";
import type { Fact, CodeExemplar } from "../../shared/types.js";

export type WorkstreamStatus = "active" | "merged" | "retired";

export interface Workstream {
  readonly id: string;
  readonly label: string;
  readonly status: WorkstreamStatus;
  readonly mergedInto: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSessionAt: string | null;
}

export type BindingSource = "classifier" | "operator";

export interface WorkstreamCandidate {
  readonly workstreamId: string;
  readonly entities: ReadonlyArray<string>;
}

export interface MatchThresholds { readonly high: number; readonly low: number; }
export interface MatchWeights { readonly semantic: number; readonly entity: number; }

export interface MatchInputs {
  readonly sessionEntities: ReadonlyArray<string>;
  readonly neighborScores: ReadonlyMap<string, number>;
  readonly candidates: ReadonlyArray<WorkstreamCandidate>;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
}

export type MatchDecision =
  | { readonly kind: "bind"; readonly workstreamId: string; readonly confidence: number }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<{ readonly workstreamId: string; readonly score: number }> }
  | { readonly kind: "create"; readonly confidence: number };

export interface WorkstreamRollup {
  readonly workstream: Workstream;
  readonly sessionIds: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<Fact>;
  readonly exemplars: ReadonlyArray<CodeExemplar>;
}

export function makeWorkstreamId(): string {
  return `ws_${randomUUID()}`;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}
```

- [ ] **Step 4: Write `resolve.ts`**

```typescript
// src/core/workstream/resolve.ts

/**
 * Walk the merged_into chain to the live survivor. Mirrors the replaces-chain
 * resolution in ui/lib/thread-groups.ts. Iterative + visited-set guarded so a
 * (data-corrupt) cycle terminates instead of looping. Fail-open: an id absent
 * from the map resolves to itself.
 */
export function resolveWorkstreamId(
  id: string,
  byId: ReadonlyMap<string, { id: string; mergedInto: string | null }>,
): string {
  const seen = new Set<string>();
  let cur = id;
  while (true) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node || node.mergedInto === null) return cur;
    cur = node.mergedInto;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/workstream/resolve.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/core/workstream/model.ts src/core/workstream/resolve.ts tests/unit/core/workstream/resolve.test.ts
git commit -m "feat(workstream): pure model types + merge-chain resolver (#367)"
```

---

## Task 3: WorkstreamStore port + sqlite + pg adapters

**Files:**
- Create: `src/ports/workstream-store.ts`
- Create: `src/core/storage/sqlite-workstream-store.ts`
- Create: `src/core/storage/pg-workstream-store.ts`
- Modify: `src/ports/storage.ts` (add `readonly workstreams: WorkstreamStore`)
- Modify: `src/core/storage/sqlite-storage.ts` (build + expose)
- Modify: `src/core/storage/pg-storage.ts` (build + expose)
- Test: `tests/integration/sqlite-workstream-store.test.ts`

**Interfaces:**
- Consumes: `Workstream`, `makeWorkstreamId`, `normalizeLabel` (Task 2).
- Produces: the `WorkstreamStore` port (signatures in **Canonical Type Contracts**).

**Background (verified):** all SQLite stores share one `better-sqlite3` handle via `sessions.rawDb()` (see `SqliteStorage.create`). `Storage` aggregates `.facts/.sessions/.signals/.exemplars/.sources/.providers`; add `.workstreams` the same way. PG adapter is `PgStorage` (mirror its existing store wiring). Label dedup uses `normalizeLabel` against a stored `label` (no separate normalized column — compute in the query/loop; the set is small).

- [ ] **Step 1: Write the failing contract test**

```typescript
// tests/integration/sqlite-workstream-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wsstore-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

// Workstream_entities references entities(canonical); seed the entities first.
function seedEntities(...names: string[]) {
  const db = storage.sessions.rawDb();
  for (const n of names) {
    db.prepare("INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')").run(n);
  }
}

describe("SqliteWorkstreamStore", () => {
  it("creates and reads back a workstream", async () => {
    const ws = await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    expect(ws).toMatchObject({ id: "ws_1", label: "NLM", status: "active", mergedInto: null });
    expect(await storage.workstreams.getById("ws_1")).toMatchObject({ id: "ws_1" });
    expect(await storage.workstreams.getById("nope")).toBeNull();
  });

  it("finds by normalized label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM  Memory" });
    expect(await storage.workstreams.findByNormalizedLabel("nlm memory")).toMatchObject({ id: "ws_1" });
    expect(await storage.workstreams.findByNormalizedLabel("other")).toBeNull();
  });

  it("upserts entities with session_count and reads them back", async () => {
    seedEntities("NLM", "Daemon");
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.upsertEntities("ws_1", ["NLM", "Daemon"]);
    await storage.workstreams.upsertEntities("ws_1", ["NLM"]);
    const map = await storage.workstreams.entitiesFor(["ws_1"]);
    expect(new Set(map.get("ws_1"))).toEqual(new Set(["NLM", "Daemon"]));
    const counts = storage.sessions.rawDb()
      .prepare("SELECT session_count FROM workstream_entities WHERE workstream_id='ws_1' AND entity_canonical='NLM'")
      .get() as { session_count: number };
    expect(counts.session_count).toBe(2);
  });

  it("returns entity-overlap candidates", async () => {
    seedEntities("NLM", "Daemon", "Beacon");
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.create({ id: "ws_2", label: "Beacon" });
    await storage.workstreams.upsertEntities("ws_1", ["NLM", "Daemon"]);
    await storage.workstreams.upsertEntities("ws_2", ["Beacon"]);
    const cands = await storage.workstreams.candidatesByEntityOverlap(["NLM"], 10);
    expect(cands.map((c) => c.workstreamId)).toEqual(["ws_1"]);
    expect(new Set(cands[0]!.entities)).toEqual(new Set(["NLM", "Daemon"]));
  });

  it("touchLastSession updates the timestamp", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.workstreams.touchLastSession("ws_1", "2026-06-24T00:00:00Z");
    expect((await storage.workstreams.getById("ws_1"))!.lastSessionAt).toBe("2026-06-24T00:00:00Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/sqlite-workstream-store.test.ts`
Expected: FAIL — `storage.workstreams` undefined.

- [ ] **Step 3: Write the port**

```typescript
// src/ports/workstream-store.ts
import type { Workstream } from "@core/workstream/model.js";

export interface WorkstreamStore {
  create(input: { id: string; label: string }): Promise<Workstream>;
  getById(id: string): Promise<Workstream | null>;
  findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null>;
  listAll(): Promise<ReadonlyArray<Workstream>>;
  touchLastSession(id: string, atIso: string): Promise<void>;
  upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void>;
  entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>>;
  candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>>;
}
```

- [ ] **Step 4: Write the SQLite adapter**

```typescript
// src/core/storage/sqlite-workstream-store.ts
import type Database from "better-sqlite3";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
};

function rowToWorkstream(r: WsRow): Workstream {
  return {
    id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
    createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
  };
}

export class SqliteWorkstreamStore implements WorkstreamStore {
  constructor(private readonly db: Database.Database) {}

  async create(input: { id: string; label: string }): Promise<Workstream> {
    this.db.prepare("INSERT INTO workstreams (id, label) VALUES (?, ?)").run(input.id, input.label);
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<Workstream | null> {
    const r = this.db.prepare<[string], WsRow>("SELECT * FROM workstreams WHERE id = ?").get(id);
    return r ? rowToWorkstream(r) : null;
  }

  async findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null> {
    // Small set; normalize in JS to match normalizeLabel semantics exactly.
    const rows = this.db.prepare<[], WsRow>("SELECT * FROM workstreams").all();
    const hit = rows.find((r) => normalizeLabel(r.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }

  async listAll(): Promise<ReadonlyArray<Workstream>> {
    return this.db.prepare<[], WsRow>("SELECT * FROM workstreams").all().map(rowToWorkstream);
  }

  async touchLastSession(id: string, atIso: string): Promise<void> {
    this.db.prepare("UPDATE workstreams SET last_session_at = ?, updated_at = datetime('now') WHERE id = ?").run(atIso, id);
  }

  async upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
      VALUES (?, ?, 1)
      ON CONFLICT(workstream_id, entity_canonical)
      DO UPDATE SET session_count = session_count + 1
    `);
    const tx = this.db.transaction((names: ReadonlyArray<string>) => {
      for (const n of names) { const e = n.trim(); if (e) stmt.run(workstreamId, e); }
    });
    tx(entities);
  }

  async entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map(() => "?").join(",");
    const rows = this.db.prepare<string[], { workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph})`,
    ).all(...workstreamIds);
    for (const r of rows) {
      const list = out.get(r.workstream_id);
      if (list) list.push(r.entity_canonical); else out.set(r.workstream_id, [r.entity_canonical]);
    }
    return out;
  }

  async candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map(() => "?").join(",");
    const ids = this.db.prepare<string[], { workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph})
       GROUP BY workstream_id ORDER BY overlap DESC LIMIT ?`,
    ).all(...names, limit).map((r) => r.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
```

- [ ] **Step 5: Write the Postgres adapter**

```typescript
// src/core/storage/pg-workstream-store.ts
import type { Pool } from "pg";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
};
const rowToWorkstream = (r: WsRow): Workstream => ({
  id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
  createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
});

export class PgWorkstreamStore implements WorkstreamStore {
  constructor(private readonly pool: Pool) {}

  async create(input: { id: string; label: string }): Promise<Workstream> {
    await this.pool.query("INSERT INTO workstreams (id, label) VALUES ($1, $2)", [input.id, input.label]);
    return (await this.getById(input.id))!;
  }
  async getById(id: string): Promise<Workstream | null> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams WHERE id = $1", [id]);
    return r.rows[0] ? rowToWorkstream(r.rows[0]) : null;
  }
  async findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams");
    const hit = r.rows.find((row) => normalizeLabel(row.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }
  async listAll(): Promise<ReadonlyArray<Workstream>> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams");
    return r.rows.map(rowToWorkstream);
  }
  async touchLastSession(id: string, atIso: string): Promise<void> {
    await this.pool.query("UPDATE workstreams SET last_session_at = $1, updated_at = NOW() WHERE id = $2", [atIso, id]);
  }
  async upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    for (const raw of entities) {
      const e = raw.trim(); if (!e) continue;
      await this.pool.query(
        `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count) VALUES ($1, $2, 1)
         ON CONFLICT (workstream_id, entity_canonical) DO UPDATE SET session_count = workstream_entities.session_count + 1`,
        [workstreamId, e],
      );
    }
  }
  async entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pool.query<{ workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph})`, [...workstreamIds],
    );
    for (const row of r.rows) {
      const list = out.get(row.workstream_id);
      if (list) list.push(row.entity_canonical); else out.set(row.workstream_id, [row.entity_canonical]);
    }
    return out;
  }
  async candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pool.query<{ workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph}) GROUP BY workstream_id ORDER BY overlap DESC LIMIT $${names.length + 1}`,
      [...names, limit],
    );
    const ids = r.rows.map((row) => row.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
```

- [ ] **Step 6: Wire into Storage**

In `src/ports/storage.ts`, add to the `Storage` interface (after `exemplars`):
```typescript
  readonly workstreams: WorkstreamStore;
```
and the import:
```typescript
import type { WorkstreamStore } from "./workstream-store.js";
```

In `src/core/storage/sqlite-storage.ts`: import `SqliteWorkstreamStore`, add a `readonly workstreams: SqliteWorkstreamStore;` field, construct it in `create()` as `new SqliteWorkstreamStore(sessions.rawDb())`, thread it through the private constructor, and assign `this.workstreams = workstreams`.

In `src/core/storage/pg-storage.ts`: import `PgWorkstreamStore`, add `readonly workstreams: PgWorkstreamStore;`, construct it with the pool the other PG stores use, assign it. (Match the file's existing store-wiring shape.)

- [ ] **Step 7: Run test + typecheck**

Run: `npx vitest run tests/integration/sqlite-workstream-store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ports/workstream-store.ts src/ports/storage.ts src/core/storage/sqlite-workstream-store.ts src/core/storage/pg-workstream-store.ts src/core/storage/sqlite-storage.ts src/core/storage/pg-storage.ts tests/integration/sqlite-workstream-store.test.ts
git commit -m "feat(workstream): WorkstreamStore port + sqlite/pg adapters (#367)"
```

---

## Task 4: SessionStore binding methods

**Files:**
- Modify: `src/ports/session-store.ts`
- Modify: `src/core/storage/sqlite-session-store.ts`
- Modify: `src/core/storage/pg-session-store.ts`
- Test: `tests/integration/session-workstream-binding.test.ts`

**Interfaces:**
- Consumes: `BindingSource` (Task 2).
- Produces: `setWorkstreamBinding`, `listSessionIdsByWorkstreams`, `getEntities` (signatures in **Canonical Type Contracts**).

**Background (verified):** `sessions` table owns `workstream_id`. SQLite `loadEntities` (private, `sqlite-session-store.ts:928`) reads `session_entities`; `getEntities` is a thin public wrapper returning one session's entities. PG mirror at `pg-session-store.ts:632`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/session-workstream-binding.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-sb-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("session workstream binding", () => {
  it("sets and reads a session's workstream binding via list", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["NLM", "Daemon"] }));
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.sessions.setWorkstreamBinding("s1", "ws_1", "classifier", 0.82);
    const ids = await storage.sessions.listSessionIdsByWorkstreams(["ws_1"]);
    expect(ids).toEqual(["s1"]);
  });

  it("getEntities returns the session's entities", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["NLM", "Daemon"] }));
    expect(new Set(await storage.sessions.getEntities("s1"))).toEqual(new Set(["NLM", "Daemon"]));
  });

  it("listSessionIdsByWorkstreams unions multiple workstreams", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", entities: ["A"] }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2", entities: ["B"] }));
    await storage.workstreams.create({ id: "ws_1", label: "One" });
    await storage.workstreams.create({ id: "ws_2", label: "Two" });
    await storage.sessions.setWorkstreamBinding("s1", "ws_1", "classifier", 0.9);
    await storage.sessions.setWorkstreamBinding("s2", "ws_2", "classifier", 0.9);
    expect(new Set(await storage.sessions.listSessionIdsByWorkstreams(["ws_1", "ws_2"]))).toEqual(new Set(["s1", "s2"]));
  });
});
```

(If `insertSessionForTest` does not set entities, extend it minimally to write `session_entities` rows, mirroring the ingest path; verify against the existing helper before adding code.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/session-workstream-binding.test.ts`
Expected: FAIL — `setWorkstreamBinding` not a function.

- [ ] **Step 3: Add to the port**

In `src/ports/session-store.ts`, import `BindingSource` and add to the interface:
```typescript
setWorkstreamBinding(sessionId: string, workstreamId: string | null, source: BindingSource | null, confidence: number | null): Promise<void>;
listSessionIdsByWorkstreams(workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
getEntities(sessionId: string): Promise<ReadonlyArray<string>>;
```

- [ ] **Step 4: Implement in SQLite store**

```typescript
// src/core/storage/sqlite-session-store.ts — add methods to SqliteSessionStore
async setWorkstreamBinding(sessionId: string, workstreamId: string | null, source: import("@core/workstream/model.js").BindingSource | null, confidence: number | null): Promise<void> {
  this.db.prepare(
    "UPDATE sessions SET workstream_id = ?, binding_source = ?, binding_confidence = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(workstreamId, source, confidence, sessionId);
}

async listSessionIdsByWorkstreams(workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  if (workstreamIds.length === 0) return [];
  const ph = workstreamIds.map(() => "?").join(",");
  return this.db.prepare<string[], { id: string }>(
    `SELECT id FROM sessions WHERE workstream_id IN (${ph}) ORDER BY started_at ASC`,
  ).all(...workstreamIds).map((r) => r.id);
}

async getEntities(sessionId: string): Promise<ReadonlyArray<string>> {
  return this.loadEntities([sessionId]).get(sessionId) ?? [];
}
```

- [ ] **Step 5: Implement in Postgres store**

```typescript
// src/core/storage/pg-session-store.ts — add methods to PgSessionStore
async setWorkstreamBinding(sessionId: string, workstreamId: string | null, source: import("@core/workstream/model.js").BindingSource | null, confidence: number | null): Promise<void> {
  await this.pool.query(
    "UPDATE sessions SET workstream_id = $1, binding_source = $2, binding_confidence = $3, updated_at = NOW() WHERE id = $4",
    [workstreamId, source, confidence, sessionId],
  );
}
async listSessionIdsByWorkstreams(workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  if (workstreamIds.length === 0) return [];
  const ph = workstreamIds.map((_, i) => `$${i + 1}`).join(",");
  const r = await this.pool.query<{ id: string }>(
    `SELECT id FROM sessions WHERE workstream_id IN (${ph}) ORDER BY started_at ASC`, [...workstreamIds],
  );
  return r.rows.map((row) => row.id);
}
async getEntities(sessionId: string): Promise<ReadonlyArray<string>> {
  return (await this.loadEntities([sessionId])).get(sessionId) ?? [];
}
```

- [ ] **Step 6: Run test + typecheck + commit**

Run: `npx vitest run tests/integration/session-workstream-binding.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/ports/session-store.ts src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts tests/integration/session-workstream-binding.test.ts
git commit -m "feat(workstream): session binding read/write methods (#367)"
```

---

## Task 5: Matcher (`match.ts`) — pure scoring + three-band decision

**Files:**
- Create: `src/core/workstream/match.ts`
- Create: `src/core/workstream/thresholds.ts` (provisional defaults)
- Test: `tests/unit/core/workstream/match.test.ts`

**Interfaces:**
- Consumes: `MatchInputs`, `MatchDecision`, `WorkstreamCandidate` (Task 2).
- Produces: `matchWorkstream(inputs: MatchInputs): MatchDecision`; `jaccard(a, b): number`; `DEFAULT_THRESHOLDS: MatchThresholds`; `DEFAULT_WEIGHTS: MatchWeights`.

**Scoring (spec §6):** for each candidate workstream, `score = weights.semantic * semantic + weights.entity * entityOverlap`, where `semantic = neighborScores.get(id) ?? 0` (already in [0,1]) and `entityOverlap = jaccard(sessionEntities, candidate.entities)` in [0,1]. Take the top candidate. `top.score >= high` → `bind`. `low <= top.score < high` → `ambiguous` (top 3–5 by score). `top.score < low` (or no candidates) → `create` with `confidence = top?.score ?? 0`. `confidence` on a bind is the top score.

> **v1 simplification (noted, not silent):** the entity signal is plain Jaccard (intersection/union), not IDF-weighted. The spec (§6) says "weighted Jaccard" and (§17) leaves the exact weighting open "resolve empirically against the gold set." Plain Jaccard is the v1 substrate; per-entity IDF down-weighting of ubiquitous tools (the documented failure mode) is the first tuning lever Plan D's gold-set run evaluates. The cross-signal weights (`semantic`/`entity`) are already parameterized here.

> **Thresholds are provisional** until Plan D sets `high`/`low` from the gold-set score distribution. `DEFAULT_THRESHOLDS` below is a conservative placeholder, never consulted inside `match.ts` (always passed via `inputs.thresholds`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/workstream/match.test.ts
import { describe, expect, it } from "vitest";
import { matchWorkstream, jaccard } from "../../../../src/core/workstream/match.js";
import type { MatchInputs } from "../../../../src/core/workstream/model.js";

const base = (over: Partial<MatchInputs>): MatchInputs => ({
  sessionEntities: ["NLM", "Daemon"],
  neighborScores: new Map(),
  candidates: [],
  thresholds: { high: 0.55, low: 0.3 },
  weights: { semantic: 0.5, entity: 0.5 },
  ...over,
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });
  it("is intersection over union", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });
});

describe("matchWorkstream", () => {
  it("binds when top score >= high", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["NLM", "Daemon"] }],
      neighborScores: new Map([["ws_1", 0.8]]),
    }));
    expect(d).toEqual({ kind: "bind", workstreamId: "ws_1", confidence: expect.any(Number) });
    if (d.kind === "bind") expect(d.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("is ambiguous when top score is between low and high", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["NLM"] }, { workstreamId: "ws_2", entities: ["Daemon"] }],
      neighborScores: new Map([["ws_1", 0.4], ["ws_2", 0.3]]),
    }));
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.candidates.length).toBeGreaterThanOrEqual(1);
      expect(d.candidates.length).toBeLessThanOrEqual(5);
      expect(d.candidates[0]!.workstreamId).toBe("ws_1"); // sorted by score desc
    }
  });

  it("creates when there are no candidates", () => {
    expect(matchWorkstream(base({})).kind).toBe("create");
  });

  it("creates when top score is below low", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["Other"] }],
      neighborScores: new Map([["ws_1", 0.1]]),
    }));
    expect(d.kind).toBe("create");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `thresholds.ts`**

```typescript
// src/core/workstream/thresholds.ts
import type { MatchThresholds, MatchWeights } from "./model.js";

/** Provisional — replaced by the gold-set score distribution in Plan D (#367 §13). */
export const DEFAULT_THRESHOLDS: MatchThresholds = { high: 0.55, low: 0.3 };
export const DEFAULT_WEIGHTS: MatchWeights = { semantic: 0.5, entity: 0.5 };
```

- [ ] **Step 4: Write `match.ts`**

```typescript
// src/core/workstream/match.ts
import type { MatchDecision, MatchInputs } from "./model.js";

export function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a), setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchWorkstream(inputs: MatchInputs): MatchDecision {
  const { sessionEntities, neighborScores, candidates, thresholds, weights } = inputs;

  const scored = candidates
    .map((c) => {
      const semantic = neighborScores.get(c.workstreamId) ?? 0;
      const entity = jaccard(sessionEntities, c.entities);
      return { workstreamId: c.workstreamId, score: weights.semantic * semantic + weights.entity * entity };
    })
    .sort((x, y) => y.score - x.score);

  const top = scored[0];
  if (!top || top.score < thresholds.low) {
    return { kind: "create", confidence: top?.score ?? 0 };
  }
  if (top.score >= thresholds.high) {
    return { kind: "bind", workstreamId: top.workstreamId, confidence: top.score };
  }
  return { kind: "ambiguous", candidates: scored.slice(0, 5) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/workstream/match.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/core/workstream/match.ts src/core/workstream/thresholds.ts tests/unit/core/workstream/match.test.ts
git commit -m "feat(workstream): pure matcher — semantic+entity blend, three-band decision (#367)"
```

---

## Task 6: Batched rollup queries — `FactStore.listBySessions` + `CodeExemplarStore.listBySessions`

**Files:**
- Modify: `src/ports/fact-store.ts`, `src/core/storage/sqlite-fact-store.ts`, `src/core/storage/pg-fact-store.ts`
- Modify: `src/ports/code-exemplar-store.ts`, `src/core/storage/sqlite-code-exemplar-store.ts`, `src/core/storage/pg-code-exemplar-store.ts`
- Test: `tests/integration/rollup-queries.test.ts`

**Interfaces:**
- Produces: `FactStore.listBySessions(sessionIds, opts?)` (current facts only by default — `superseded_by IS NULL AND retired_at IS NULL`); `CodeExemplarStore.listBySessions(sessionIds)` (non-retired — `retired_at IS NULL`).

**Background (verified):** mirrors existing `listBySession(sessionId)` in both fact stores (`sqlite-fact-store.ts:142`, `pg-fact-store.ts:127`) and the current-facts filter from `list()`. Exemplar retired filter is `retired_at IS NULL` (`sqlite-code-exemplar-store.ts:135`). `rowToFact` / `rowToExemplar` already exist — reuse them.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/rollup-queries.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import type { Fact } from "../../src/shared/types.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-rollup-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

const fact = (id: string, sid: string, over: Partial<Fact> = {}): Fact => ({
  id, kind: "decision", subject: "x", predicate: "is", value: "y",
  sourceSessionId: sid, sourceQuote: null, createdAt: "2026-06-24T00:00:00Z",
  supersededBy: null, confidence: 1, retiredAt: null, ...over,
});

describe("listBySessions", () => {
  it("returns current facts across multiple sessions, excluding superseded/retired", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2" }));
    await storage.facts.insertMany([
      fact("f1", "s1"),
      fact("f2", "s2"),
      fact("f3", "s1", { supersededBy: "f1" }),
      fact("f4", "s2", { retiredAt: "2026-06-24T01:00:00Z" }),
    ]);
    const ids = (await storage.facts.listBySessions(["s1", "s2"])).map((f) => f.id);
    expect(new Set(ids)).toEqual(new Set(["f1", "f2"]));
  });

  it("returns [] for empty input", async () => {
    expect(await storage.facts.listBySessions([])).toEqual([]);
    expect(await storage.exemplars.listBySessions([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/rollup-queries.test.ts`
Expected: FAIL — `listBySessions` not a function.

- [ ] **Step 3: Implement `FactStore.listBySessions` (port + sqlite + pg)**

Port (`src/ports/fact-store.ts`), add to interface:
```typescript
listBySessions(sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>>;
```
SQLite (`src/core/storage/sqlite-fact-store.ts`):
```typescript
async listBySessions(sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>> {
  if (sessionIds.length === 0) return [];
  const ph = sessionIds.map(() => "?").join(",");
  const filter = opts?.includeSuperseded === true ? "" : " AND superseded_by IS NULL AND retired_at IS NULL";
  const rows = this.db.prepare<string[], FactRow>(
    `SELECT id, kind, subject, predicate, value, source_session_id, source_quote, created_at, superseded_by, confidence, retired_at
     FROM facts WHERE source_session_id IN (${ph})${filter} ORDER BY created_at ASC`,
  ).all(...sessionIds);
  return rows.map((r) => this.rowToFact(r));
}
```
PG (`src/core/storage/pg-fact-store.ts`):
```typescript
async listBySessions(sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>> {
  if (sessionIds.length === 0) return [];
  const ph = sessionIds.map((_, i) => `$${i + 1}`).join(",");
  const filter = opts?.includeSuperseded === true ? "" : " AND superseded_by IS NULL AND retired_at IS NULL";
  const r = await this.pool.query<FactRow>(
    `SELECT id, kind, subject, predicate, value, source_session_id, source_quote, created_at, superseded_by, confidence, retired_at
     FROM facts WHERE source_session_id IN (${ph})${filter} ORDER BY created_at ASC`, [...sessionIds],
  );
  return r.rows.map(rowToFact);
}
```
(Confirm `retired_at` is in the column list of the existing `listBySession` SELECT; the verified `listBySession` omits it — add `retired_at` here since the filter needs it and `rowToFact` reads it.)

- [ ] **Step 4: Implement `CodeExemplarStore.listBySessions` (port + sqlite + pg)**

Port (`src/ports/code-exemplar-store.ts`):
```typescript
listBySessions(sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>>;
```
SQLite (`src/core/storage/sqlite-code-exemplar-store.ts`):
```typescript
async listBySessions(sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>> {
  if (sessionIds.length === 0) return [];
  const ph = sessionIds.map(() => "?").join(",");
  const rows = this.db.prepare<string[], ExemplarRow>(
    `SELECT id, install_scope, signal_id, session_id, repo, model, lang, task_context, code, code_hash, outcome, git_sha, survived, ts, created_at, retired_at, label_source
     FROM code_exemplars WHERE session_id IN (${ph}) AND retired_at IS NULL ORDER BY ts ASC`,
  ).all(...sessionIds) as ExemplarRow[];
  return rows.map((r) => this.rowToExemplar(r));
}
```
PG (`src/core/storage/pg-code-exemplar-store.ts`): mirror with `$n` placeholders + `rowToExemplar`.

- [ ] **Step 5: Run test + typecheck + commit**

Run: `npx vitest run tests/integration/rollup-queries.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/ports/fact-store.ts src/ports/code-exemplar-store.ts src/core/storage/sqlite-fact-store.ts src/core/storage/pg-fact-store.ts src/core/storage/sqlite-code-exemplar-store.ts src/core/storage/pg-code-exemplar-store.ts tests/integration/rollup-queries.test.ts
git commit -m "feat(workstream): batched listBySessions on fact + exemplar stores (#367)"
```

---

## Task 7: Rollup (`rollup.ts`) — workstream → current facts + exemplars

**Files:**
- Create: `src/core/workstream/rollup.ts`
- Test: `tests/unit/core/workstream/rollup.test.ts`

**Interfaces:**
- Consumes: `WorkstreamStore.listAll`, `WorkstreamStore.getById`, `SessionStore.listSessionIdsByWorkstreams`, `FactStore.listBySessions`, `CodeExemplarStore.listBySessions`, `resolveWorkstreamId` (Task 2).
- Produces:
```typescript
export interface RollupDeps {
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "getById">;
  readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
  readonly facts: Pick<FactStore, "listBySessions">;
  readonly exemplars: Pick<CodeExemplarStore, "listBySessions">;
}
export function rollupWorkstream(deps: RollupDeps, workstreamId: string): Promise<WorkstreamRollup | null>;
```

**Logic (spec §8):** resolve `workstreamId` to its live survivor; if the workstream does not exist, return `null`. Collect **all** workstreams whose `resolveWorkstreamId` equals the survivor (so merged ancestors' sessions roll up without rewriting `session.workstream_id`); list their session ids; fetch current facts + non-retired exemplars for that session set.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/workstream/rollup.test.ts
import { describe, expect, it } from "vitest";
import { rollupWorkstream, type RollupDeps } from "../../../../src/core/workstream/rollup.js";
import type { Workstream } from "../../../../src/core/workstream/model.js";

const ws = (id: string, mergedInto: string | null): Workstream => ({
  id, label: id, status: mergedInto ? "merged" : "active", mergedInto,
  createdAt: "t", updatedAt: "t", lastSessionAt: null,
});

function deps(all: Workstream[], sessionsByWs: Record<string, string[]>): RollupDeps {
  return {
    workstreams: { listAll: async () => all, getById: async (id) => all.find((w) => w.id === id) ?? null },
    sessions: { listSessionIdsByWorkstreams: async (ids) => ids.flatMap((i) => sessionsByWs[i] ?? []) },
    facts: { listBySessions: async (sids) => sids.map((s) => ({ id: `f_${s}` })) as any },
    exemplars: { listBySessions: async (sids) => sids.map((s) => ({ id: `e_${s}` })) as any },
  };
}

describe("rollupWorkstream", () => {
  it("returns null for an unknown workstream", async () => {
    expect(await rollupWorkstream(deps([], {}), "ws_x")).toBeNull();
  });

  it("rolls up a merged ancestor's sessions under the live survivor", async () => {
    const all = [ws("ws_old", "ws_new"), ws("ws_new", null)];
    const d = deps(all, { ws_old: ["s1"], ws_new: ["s2"] });
    const r = await rollupWorkstream(d, "ws_new");
    expect(r!.workstream.id).toBe("ws_new");
    expect(new Set(r!.sessionIds)).toEqual(new Set(["s1", "s2"]));
    expect(new Set(r!.facts.map((f) => f.id))).toEqual(new Set(["f_s1", "f_s2"]));
  });

  it("resolves a query for the merged id to the survivor", async () => {
    const all = [ws("ws_old", "ws_new"), ws("ws_new", null)];
    const r = await rollupWorkstream(deps(all, { ws_old: ["s1"], ws_new: ["s2"] }), "ws_old");
    expect(r!.workstream.id).toBe("ws_new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/rollup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `rollup.ts`**

```typescript
// src/core/workstream/rollup.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { FactStore } from "@ports/fact-store.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { WorkstreamRollup } from "./model.js";
import { resolveWorkstreamId } from "./resolve.js";

export interface RollupDeps {
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "getById">;
  readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
  readonly facts: Pick<FactStore, "listBySessions">;
  readonly exemplars: Pick<CodeExemplarStore, "listBySessions">;
}

export async function rollupWorkstream(deps: RollupDeps, workstreamId: string): Promise<WorkstreamRollup | null> {
  const all = await deps.workstreams.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const survivorId = resolveWorkstreamId(workstreamId, byId);
  const workstream = await deps.workstreams.getById(survivorId);
  if (!workstream) return null;

  const memberIds = all.filter((w) => resolveWorkstreamId(w.id, byId) === survivorId).map((w) => w.id);
  const sessionIds = await deps.sessions.listSessionIdsByWorkstreams(memberIds);
  const [facts, exemplars] = await Promise.all([
    deps.facts.listBySessions(sessionIds),
    deps.exemplars.listBySessions(sessionIds),
  ]);
  return { workstream, sessionIds, facts, exemplars };
}
```

- [ ] **Step 4: Run test + typecheck + commit**

Run: `npx vitest run tests/unit/core/workstream/rollup.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/core/workstream/rollup.ts tests/unit/core/workstream/rollup.test.ts
git commit -m "feat(workstream): session-binding rollup with merge-chain resolution (#367)"
```

---

## Task 8: Bind orchestrator (`bind.ts`)

**Files:**
- Create: `src/core/workstream/bind.ts`
- Test: `tests/unit/core/workstream/bind.test.ts`

**Interfaces:**
- Consumes: `WorkstreamStore`, `SessionStore.setWorkstreamBinding`, `LLMClient.embed`, `SessionStore.semanticSearch` (via store), `matchWorkstream`, `resolveWorkstreamId`, `makeWorkstreamId`, `normalizeLabel`.
- Produces:
```typescript
export interface BindDeps {
  readonly workstreams: WorkstreamStore;
  readonly sessions: Pick<SessionStore, "setWorkstreamBinding" | "semanticSearch">;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
  // Resolve an AMBIGUOUS band to a chosen workstreamId or null (=create). Injected so the
  // scheduler can wire the already-running classifier LLM; tests pass a fake.
  readonly pickAmbiguous: (input: { sessionLabel: string; sessionSummary: string; candidates: ReadonlyArray<{ workstreamId: string; label: string; entities: ReadonlyArray<string> }> }) => Promise<string | null>;
  readonly log?: (msg: string) => void;
}
export interface BindInput {
  readonly sessionId: string;
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly startedAt: string;
}
export interface BindResult { readonly workstreamId: string; readonly created: boolean; readonly confidence: number | null; }
export function bindSessionToWorkstream(deps: BindDeps, input: BindInput): Promise<BindResult | null>;
```

**Logic (spec §5, §6):**
1. Embed `label + "\n" + summary` as a `"query"` vector; `semanticSearch(vector, K=10)` (K constant). **Exclude the session itself** from neighbors (it was already embedded by `insertSession`). Convert each neighbor distance to similarity `sim = clamp(1 - distance²/2, 0, 1)` (L2 over normalized vectors → cosine).
2. Load all workstreams once → `byId` map. For each neighbor session, look up its `workstream_id` (skip nulls), resolve via `resolveWorkstreamId`, and keep the **max** similarity per workstream → `neighborScores`.
3. `entityCandidates = workstreams.candidatesByEntityOverlap(entities, K)`. Union the neighbor-workstream ids and the entity-candidate ids; build `candidates: WorkstreamCandidate[]` (entities from `workstreams.entitiesFor`).
4. `decision = matchWorkstream({ sessionEntities, neighborScores, candidates, thresholds, weights })`.
5. `bind` → use `decision.workstreamId`, `confidence = decision.confidence`. `ambiguous` → call `pickAmbiguous` with the top candidates (label + entities); if it returns an id, bind it (`confidence = that candidate's score`); else create. `create` → `normalizeLabel(label)`, dedup via `findByNormalizedLabel`; if found, bind it (`confidence = null`); else `create({ id: makeWorkstreamId(), label })`, `confidence = null`.
6. Persist: `sessions.setWorkstreamBinding(sessionId, wsId, "classifier", confidence)`; `workstreams.upsertEntities(wsId, entities)`; `workstreams.touchLastSession(wsId, startedAt)`.
7. Any thrown error → `log` + return `null` (fail open).

> **Self-exclusion is load-bearing:** without it the session's own chunk is its nearest neighbor (distance ≈ 0), and a session whose own (still-NULL) workstream is skipped would otherwise inflate scoring. The neighbor loop skips `n.sessionId === input.sessionId` and skips neighbors whose `workstream_id` is NULL.

**Note on neighbor workstream lookup:** `semanticSearch` returns `{ sessionId, distance }` only. To get each neighbor's `workstream_id`, add a small read to `SessionStore`: `getWorkstreamIds(sessionIds): Promise<Map<string,string|null>>`. Add this method (port + sqlite + pg) as the first step of this task (TDD it in the same test file), mirroring `getEntities`/`loadEntities` shape:
```typescript
// SessionStore
getWorkstreamIds(sessionIds: ReadonlyArray<string>): Promise<Map<string, string | null>>;
// sqlite
async getWorkstreamIds(sessionIds: ReadonlyArray<string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (sessionIds.length === 0) return out;
  const ph = sessionIds.map(() => "?").join(",");
  for (const r of this.db.prepare<string[], { id: string; workstream_id: string | null }>(
    `SELECT id, workstream_id FROM sessions WHERE id IN (${ph})`).all(...sessionIds)) out.set(r.id, r.workstream_id);
  return out;
}
```

- [ ] **Step 1: Write the failing test** (fakes for store/embedder/pickAmbiguous)

```typescript
// tests/unit/core/workstream/bind.test.ts
import { describe, expect, it, vi } from "vitest";
import { bindSessionToWorkstream, type BindDeps, type BindInput } from "../../../../src/core/workstream/bind.js";

const input: BindInput = { sessionId: "s_new", label: "NLM workstream work", summary: "built the matcher", entities: ["NLM", "Daemon"], startedAt: "2026-06-24T00:00:00Z" };

function fakeDeps(over: Partial<BindDeps> & { existing?: Array<{ id: string; label: string; entities: string[] }>; neighbors?: Array<{ sessionId: string; distance: number; ws: string | null }> } = {}): { deps: BindDeps; setBinding: ReturnType<typeof vi.fn>; created: string[] } {
  const existing = over.existing ?? [];
  const neighbors = over.neighbors ?? [];
  const created: string[] = [];
  const setBinding = vi.fn(async () => {});
  const wsById = new Map(existing.map((w) => [w.id, { id: w.id, label: w.label, status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }]));
  const entById = new Map(existing.map((w) => [w.id, w.entities]));
  const deps: BindDeps = {
    workstreams: {
      create: async ({ id, label }) => { created.push(id); const w = { id, label, status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }; wsById.set(id, w); return w; },
      getById: async (id) => (wsById.get(id) as any) ?? null,
      findByNormalizedLabel: async (n) => { for (const w of wsById.values()) if (w.label.trim().toLowerCase().replace(/\s+/g, " ") === n) return w as any; return null; },
      listAll: async () => [...wsById.values()] as any,
      touchLastSession: async () => {},
      upsertEntities: async () => {},
      entitiesFor: async (ids) => new Map(ids.map((i) => [i, entById.get(i) ?? []])),
      candidatesByEntityOverlap: async (ents) => existing.filter((w) => w.entities.some((e) => ents.includes(e))).map((w) => ({ workstreamId: w.id, entities: w.entities })),
    },
    sessions: {
      setWorkstreamBinding: setBinding,
      semanticSearch: async () => neighbors.map((n) => ({ sessionId: n.sessionId, distance: n.distance })),
      // @ts-expect-error fake adds getWorkstreamIds used by bind
      getWorkstreamIds: async (ids: string[]) => new Map(ids.map((i) => [i, neighbors.find((n) => n.sessionId === i)?.ws ?? null])),
    } as any,
    embedder: { embed: async () => ({ vector: new Float32Array([1, 0, 0]), model: "fake" }) },
    thresholds: { high: 0.55, low: 0.3 },
    weights: { semantic: 0.5, entity: 0.5 },
    pickAmbiguous: over.pickAmbiguous ?? (async () => null),
    log: () => {},
  };
  return { deps, setBinding, created };
}

describe("bindSessionToWorkstream", () => {
  it("binds to a strong semantic+entity match without creating", async () => {
    const { deps, setBinding, created } = fakeDeps({
      existing: [{ id: "ws_nlm", label: "NLM", entities: ["NLM", "Daemon"] }],
      neighbors: [{ sessionId: "s_old", distance: 0.1, ws: "ws_nlm" }],
    });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r).toMatchObject({ workstreamId: "ws_nlm", created: false });
    expect(created).toEqual([]);
    expect(setBinding).toHaveBeenCalledWith("s_new", "ws_nlm", "classifier", expect.any(Number));
  });

  it("creates a fresh workstream when nothing matches", async () => {
    const { deps, created } = fakeDeps({ existing: [], neighbors: [] });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r!.created).toBe(true);
    expect(created.length).toBe(1);
  });

  it("excludes the session itself from neighbors", async () => {
    const { deps, created } = fakeDeps({
      existing: [{ id: "ws_nlm", label: "NLM", entities: ["X"] }],
      neighbors: [{ sessionId: "s_new", distance: 0.0, ws: "ws_nlm" }], // self
    });
    const r = await bindSessionToWorkstream(deps, input);
    // self excluded => no semantic signal => entity overlap (NLM/Daemon vs X) ~0 => create
    expect(r!.created).toBe(true);
    expect(created.length).toBe(1);
  });

  it("dedups on create via normalized label", async () => {
    const { deps, created } = fakeDeps({ existing: [{ id: "ws_nlm", label: "N L M", entities: ["Z"] }] });
    const r = await bindSessionToWorkstream({ ...deps }, { ...input, label: "n l m", entities: ["Q"] });
    expect(r!.workstreamId).toBe("ws_nlm");
    expect(r!.created).toBe(false);
    expect(created).toEqual([]);
  });

  it("ambiguous band asks pickAmbiguous and binds its choice", async () => {
    const { deps, setBinding } = fakeDeps({
      existing: [{ id: "ws_a", label: "A", entities: ["NLM"] }, { id: "ws_b", label: "B", entities: ["Daemon"] }],
      neighbors: [{ sessionId: "s_old", distance: 0.9, ws: "ws_a" }],
      pickAmbiguous: async () => "ws_b",
    });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r!.workstreamId).toBe("ws_b");
    expect(setBinding).toHaveBeenCalledWith("s_new", "ws_b", "classifier", expect.any(Number));
  });

  it("returns null and does not throw on embedder failure (fail open)", async () => {
    const { deps, setBinding } = fakeDeps({});
    (deps.embedder as any).embed = async () => { throw new Error("embedder down"); };
    expect(await bindSessionToWorkstream(deps, input)).toBeNull();
    expect(setBinding).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/bind.test.ts`
Expected: FAIL — module not found. (Also add the `getWorkstreamIds` port+impl in this step before bind.ts; TDD it via a quick sqlite assertion if you prefer, or rely on the bind test's fake + a typecheck of the real impl.)

- [ ] **Step 3: Add `getWorkstreamIds` to SessionStore** (port + sqlite + pg), per the signature above.

- [ ] **Step 4: Write `bind.ts`**

```typescript
// src/core/workstream/bind.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { MatchThresholds, MatchWeights, WorkstreamCandidate } from "./model.js";
import { makeWorkstreamId, normalizeLabel } from "./model.js";
import { matchWorkstream } from "./match.js";
import { resolveWorkstreamId } from "./resolve.js";

const NEIGHBOR_K = 10;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface BindDeps {
  readonly workstreams: WorkstreamStore;
  readonly sessions: Pick<SessionStore, "setWorkstreamBinding" | "semanticSearch" | "getWorkstreamIds">;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
  readonly pickAmbiguous: (input: { sessionLabel: string; sessionSummary: string; candidates: ReadonlyArray<{ workstreamId: string; label: string; entities: ReadonlyArray<string> }> }) => Promise<string | null>;
  readonly log?: (msg: string) => void;
}
export interface BindInput { readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>; readonly startedAt: string; }
export interface BindResult { readonly workstreamId: string; readonly created: boolean; readonly confidence: number | null; }

export async function bindSessionToWorkstream(deps: BindDeps, input: BindInput): Promise<BindResult | null> {
  try {
    const { vector } = await deps.embedder.embed(`${input.label}\n${input.summary}`, "query");
    const neighbors = (await deps.sessions.semanticSearch(vector, NEIGHBOR_K)).filter((n) => n.sessionId !== input.sessionId);

    const all = await deps.workstreams.listAll();
    const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
    const wsOfNeighbor = await deps.sessions.getWorkstreamIds(neighbors.map((n) => n.sessionId));

    const neighborScores = new Map<string, number>();
    for (const n of neighbors) {
      const wsRaw = wsOfNeighbor.get(n.sessionId);
      if (!wsRaw) continue;
      const wsId = resolveWorkstreamId(wsRaw, byId);
      const sim = clamp01(1 - (n.distance * n.distance) / 2);
      neighborScores.set(wsId, Math.max(neighborScores.get(wsId) ?? 0, sim));
    }

    const entityCands = await deps.workstreams.candidatesByEntityOverlap(input.entities, NEIGHBOR_K);
    const candIds = new Set<string>([...neighborScores.keys(), ...entityCands.map((c) => c.workstreamId)]);
    const entMap = await deps.workstreams.entitiesFor([...candIds]);
    const candidates: WorkstreamCandidate[] = [...candIds].map((id) => ({ workstreamId: id, entities: entMap.get(id) ?? [] }));

    const decision = matchWorkstream({ sessionEntities: input.entities, neighborScores, candidates, thresholds: deps.thresholds, weights: deps.weights });

    let workstreamId: string;
    let created = false;
    let confidence: number | null = null;

    if (decision.kind === "bind") {
      workstreamId = decision.workstreamId; confidence = decision.confidence;
    } else if (decision.kind === "ambiguous") {
      const enriched = await Promise.all(decision.candidates.map(async (c) => {
        const w = await deps.workstreams.getById(c.workstreamId);
        return { workstreamId: c.workstreamId, label: w?.label ?? c.workstreamId, entities: entMap.get(c.workstreamId) ?? [], score: c.score };
      }));
      const chosen = await deps.pickAmbiguous({ sessionLabel: input.label, sessionSummary: input.summary, candidates: enriched });
      if (chosen) { workstreamId = chosen; confidence = enriched.find((e) => e.workstreamId === chosen)?.score ?? null; }
      else { ({ workstreamId, created } = await createOrDedup(deps, input.label)); }
    } else {
      ({ workstreamId, created } = await createOrDedup(deps, input.label));
    }

    await deps.sessions.setWorkstreamBinding(input.sessionId, workstreamId, "classifier", confidence);
    await deps.workstreams.upsertEntities(workstreamId, input.entities);
    await deps.workstreams.touchLastSession(workstreamId, input.startedAt);
    return { workstreamId, created, confidence };
  } catch (e) {
    deps.log?.(`[workstream] bind failed for ${input.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function createOrDedup(deps: BindDeps, label: string): Promise<{ workstreamId: string; created: boolean }> {
  const existing = await deps.workstreams.findByNormalizedLabel(normalizeLabel(label));
  if (existing) return { workstreamId: existing.id, created: false };
  const ws = await deps.workstreams.create({ id: makeWorkstreamId(), label: label.trim() || "untitled" });
  return { workstreamId: ws.id, created: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/workstream/bind.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`

```bash
git add src/core/workstream/bind.ts src/ports/session-store.ts src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts tests/unit/core/workstream/bind.test.ts
git commit -m "feat(workstream): bind orchestrator — embed→neighbors→match→create/dedup, fail-open (#367)"
```

---

## Task 9: Scheduler wiring (flag-gated, default off)

**Files:**
- Modify: `src/core/scheduler/scheduler.ts`
- Test: `tests/integration/scheduler-workstream-bind.test.ts`

**Interfaces:**
- Consumes: `bindSessionToWorkstream` (Task 8), `SchedulerOptions` (existing).

**Background (verified):** the insertion point is `scheduler.ts` immediately after `recordClassified(...)` (~line 301), before the exemplar drain. Available: `chunk.id`, `classification` (`{ label, summary, entities, decisions, open, ... }`), `chunk.startedAt`, `this.opts.store`, `this.opts.classifier`, `this.opts.embedder`, `this.opts.logger`. The classifier (`this.opts.classifier: LLMClient`) is reused to resolve the AMBIGUOUS band via `pickAmbiguous`.

**Wiring details:**
- Read `process.env.NLM_WORKSTREAM_BIND === "true"` once (module-level const or an opts field). Default off.
- Build `pickAmbiguous` from `this.opts.classifier`: a small prompt that lists candidate labels + entities and asks the LLM to return a chosen `workstreamId` or `"none"`. Parse defensively; any failure → return `null` (→ create). Keep this helper in `scheduler.ts` or a sibling `bind-wiring.ts`.
- `this.opts.store` is `SqliteSessionStore | PgSessionStore`; it exposes `semanticSearch` + `getWorkstreamIds`. `this.opts.embedder` is the `LLMClient`. The `WorkstreamStore` is reached via the `Storage` handle — thread `storage.workstreams` into `SchedulerOptions` (add `readonly workstreams?: WorkstreamStore` to the options interface and pass it where the scheduler is constructed in `src/cli/nlm.ts`).
- Use `DEFAULT_THRESHOLDS` / `DEFAULT_WEIGHTS` from `thresholds.ts` (provisional until Plan D).

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/scheduler-workstream-bind.test.ts
// Spins the scheduler over a fixture transcript with NLM_WORKSTREAM_BIND=true and a
// fake embedder/classifier, asserts the flushed session gets a workstream_id; and with
// the flag unset, asserts workstream_id stays NULL. Mirror the existing scheduler
// integration test setup in tests/integration/ for adapter + store construction.
```

Model this on the nearest existing scheduler integration test (find it under `tests/integration/` or `tests/unit/core/scheduler/`) for how the sweep is driven and how a fake `LLMClient` is supplied. Assert:
1. With `NLM_WORKSTREAM_BIND=true`: after a sweep, `SELECT workstream_id FROM sessions WHERE id = ?` is non-null and a `workstreams` row exists.
2. With the flag unset: `workstream_id` is NULL and `workstreams` is empty.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/scheduler-workstream-bind.test.ts`
Expected: FAIL — no binding happens (flag path not wired).

- [ ] **Step 3: Wire the bind call into `scheduler.ts`**

Immediately after `recordClassified(...)` (and the pg equivalent), before the exemplar drain:
```typescript
if (BIND_WORKSTREAMS && this.opts.workstreams && this.opts.embedder) {
  await bindSessionToWorkstream(
    {
      workstreams: this.opts.workstreams,
      sessions: this.opts.store,
      embedder: this.opts.embedder,
      thresholds: DEFAULT_THRESHOLDS,
      weights: DEFAULT_WEIGHTS,
      pickAmbiguous: makeClassifierPicker(this.opts.classifier),
      log: this.opts.logger,
    },
    { sessionId: chunk.id, label: classification.label, summary: classification.summary, entities: classification.entities, startedAt: chunk.startedAt },
  );
}
```
with `const BIND_WORKSTREAMS = process.env.NLM_WORKSTREAM_BIND === "true";` at module scope, the imports, and `makeClassifierPicker(classifier: LLMClient)` returning a `pickAmbiguous` function. Add `readonly workstreams?: WorkstreamStore;` to `SchedulerOptions` and pass `storage.workstreams` at the construction site in `src/cli/nlm.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/scheduler-workstream-bind.test.ts`
Expected: PASS (both flag-on and flag-off cases).

- [ ] **Step 5: Build the daemon + verify boot (flag off)**

Run: `npm run build:server`
Then restart and confirm the banner (flag stays off in production):
```bash
launchctl kickstart -k gui/$(id -u)/$(launchctl list | grep -i nlm | awk '{print $3}' | head -1)
sleep 2 && tail -n 20 ~/.nlm/logs/daemon.log   # confirm clean startup banner; verify exact log path first
```
Expected: daemon boots cleanly; no workstream binding occurs (flag off). If the log path differs, find it via the LaunchAgent plist before tailing.

- [ ] **Step 6: Full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`

```bash
git add src/core/scheduler/scheduler.ts src/cli/nlm.ts tests/integration/scheduler-workstream-bind.test.ts
git commit -m "feat(workstream): flag-gated end-side binding in the classify sweep (#367)"
```

---

## Task 10: Locked matcher gold set + eval harness

**Files:**
- Create: `scripts/eval/lib/matcher-gold.ts` (pure loader + metrics + threshold sweep)
- Create: `scripts/eval/tune-matcher.ts` (CLI runner)
- Create: `scripts/eval/dump-matcher-candidates.ts` (session dumper for hand-labeling)
- Create: `tests/fixtures/matcher-gold-sample.jsonl` (synthetic fixture for the harness test)
- Create: `tests/unit/core/eval/matcher-gold.test.ts`
- Modify: `package.json` (add `eval:matcher` script)

**Interfaces:**
- Produces: `loadGold(path): GoldMatch[]`; `scoreGold(predictions): MatcherMetrics`; `sweepThresholds(scored, minRecall): { high: number; low: number; recall: number; precision: number }`.

**Background (verified):** mirrors `scripts/eval/tune-usefulness-judge.ts` (gold lives outside the repo at `~/.nlm/eval/*.jsonl`, loaded by explicit path, JSONL one-object-per-line) and `scripts/eval/floor-calibration.ts` (`calibrateFloor` sweeps thresholds, picks the most aggressive cut that keeps ≥ `minGoldKept` recall). Evals run via `npx tsx scripts/eval/<name>.ts`. Session transcripts for labeling come via `scripts/eval/lib/transcript.ts` (`openSessionContext`).

**Gold-set schema** (`~/.nlm/eval/gold-matcher.jsonl`, one object/line):
```json
{ "key": "a1b2c3d4e5", "sessionId": "cc_...", "label": "...", "summary": "...", "goldWorkstream": "NLM" }
```
`goldWorkstream` is the hand-assigned correct workstream label, assigned **from the transcript independently of `~/.nlm/work-topics.json`** (spec §13 — grading against the seed map would inflate precision). ~50 sessions, stratified across known projects + a few genuine one-offs.

> **Operator-gated step (not fabricated):** the real ~50-label gold set is produced by running the dumper, then a human (Edward) assigning `goldWorkstream`. This task ships the dumper, the harness, the metric math, and a *synthetic* fixture proving the harness; it does **not** invent labels. The threshold-derivation **run** happens in Plan D after seed exists (the matcher needs candidate workstreams). Plan A delivers the locked machinery + protocol.

- [ ] **Step 1: Write the failing test for the pure metrics**

```typescript
// tests/unit/core/eval/matcher-gold.test.ts
import { describe, expect, it } from "vitest";
import { scoreGold, sweepThresholds } from "../../../../scripts/eval/lib/matcher-gold.js";

describe("scoreGold", () => {
  it("computes precision/recall from predicted vs gold workstream", () => {
    const m = scoreGold([
      { goldWorkstream: "NLM", predicted: "NLM", score: 0.9 },     // TP
      { goldWorkstream: "NLM", predicted: "Beacon", score: 0.8 }, // wrong bind (FP for Beacon, miss for NLM)
      { goldWorkstream: "NLM", predicted: null, score: 0.1 },      // create/no-bind (miss)
    ]);
    expect(m.total).toBe(3);
    expect(m.correct).toBe(1);
    expect(m.precision).toBeCloseTo(1 / 2); // 1 correct of 2 binds
    expect(m.recall).toBeCloseTo(1 / 3);    // 1 correct of 3 golds
  });
});

describe("sweepThresholds", () => {
  it("picks the highest cut that retains >= minRecall correct binds", () => {
    const scored = [
      { goldWorkstream: "A", predicted: "A", score: 0.9 },
      { goldWorkstream: "A", predicted: "A", score: 0.6 },
      { goldWorkstream: "B", predicted: "A", score: 0.5 }, // wrong, lower score
    ];
    const r = sweepThresholds(scored, 0.5);
    expect(r.high).toBeGreaterThan(0.5);
    expect(r.high).toBeLessThanOrEqual(0.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/eval/matcher-gold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `matcher-gold.ts` (pure)**

```typescript
// scripts/eval/lib/matcher-gold.ts
import { readFileSync } from "node:fs";

export interface GoldMatch { key: string; sessionId: string; label: string; summary: string; goldWorkstream: string; }
export interface Prediction { goldWorkstream: string; predicted: string | null; score: number; }
export interface MatcherMetrics { total: number; binds: number; correct: number; precision: number; recall: number; }

export function loadGold(path: string): GoldMatch[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as GoldMatch);
}

export function scoreGold(preds: ReadonlyArray<Prediction>): MatcherMetrics {
  const total = preds.length;
  const binds = preds.filter((p) => p.predicted !== null).length;
  const correct = preds.filter((p) => p.predicted !== null && p.predicted === p.goldWorkstream).length;
  return { total, binds, correct, precision: binds === 0 ? 0 : correct / binds, recall: total === 0 ? 0 : correct / total };
}

/** Sweep candidate HIGH cuts over the observed score grid; pick the highest cut whose
 *  retained correct-bind recall stays >= minRecall. LOW is set a band below HIGH. */
export function sweepThresholds(scored: ReadonlyArray<Prediction>, minRecall: number): { high: number; low: number; recall: number; precision: number } {
  const grid = [...new Set(scored.map((p) => p.score))].sort((a, b) => a - b);
  const totalGold = scored.length || 1;
  let best = { high: 0, low: 0, recall: 0, precision: 0 };
  for (const t of grid) {
    const kept = scored.filter((p) => p.score >= t);
    const correct = kept.filter((p) => p.predicted === p.goldWorkstream).length;
    const recall = correct / totalGold;
    const precision = kept.length === 0 ? 0 : correct / kept.length;
    if (recall >= minRecall && t >= best.high) best = { high: t, low: Math.max(0, t - 0.2), recall, precision };
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/eval/matcher-gold.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the dumper + runner (no test gate; they are operator tools)**

`scripts/eval/dump-matcher-candidates.ts`: read sessions from `~/.nlm/canonical.sqlite` (`openSessionContext` pattern from `scripts/eval/lib/transcript.ts`), stratified-sample ~50 across distinct alias-map values (for coverage, **not** as the gold label — coverage only), emit `{ key, sessionId, label, summary, goldWorkstream: "" }` to `~/.nlm/eval/gold-matcher.candidates.jsonl` for hand-labeling. `key = sha1(sessionId).slice(0,10)`.

`scripts/eval/tune-matcher.ts`: load `~/.nlm/eval/gold-matcher.jsonl`, build candidate workstreams from the live store (Plan D: seeded set), run the real `matchWorkstream` per gold session (embedding + entity overlap against the seeded workstreams), collect `Prediction[]`, print `scoreGold` + `sweepThresholds(preds, 0.9)` recommending `HIGH`/`LOW`. Mirror `tune-usefulness-judge.ts` output formatting.

Add to `package.json` scripts: `"eval:matcher": "tsx scripts/eval/tune-matcher.ts"`.

- [ ] **Step 6: Write the synthetic fixture + a harness smoke test**

`tests/fixtures/matcher-gold-sample.jsonl` (3–4 lines of synthetic gold). Extend `tests/unit/core/eval/matcher-gold.test.ts` with a `loadGold(fixturePath)` assertion that it parses N rows. (Keeps the loader covered without touching `~/.nlm/`.)

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck && npm run test`

```bash
git add scripts/eval/lib/matcher-gold.ts scripts/eval/tune-matcher.ts scripts/eval/dump-matcher-candidates.ts tests/fixtures/matcher-gold-sample.jsonl tests/unit/core/eval/matcher-gold.test.ts package.json
git commit -m "feat(workstream): locked matcher gold-set harness + threshold sweep (#367)"
```

---

## Self-Review

**1. Spec coverage (Plan A scope):**
- workstreams schema + session.workstream_id + workstream_entities → Task 1 ✓
- end-side binding in the classify sweep → Tasks 8 (orchestrator) + 9 (wiring) ✓
- match-or-create (semantic-neighbor + entity overlap, 3-band) → Tasks 5 (pure) + 8 (I/O gather) ✓
- resolve.ts merge-chain → Task 2 ✓
- session-binding rollup → Tasks 6 (batched queries) + 7 (rollup) ✓
- locked matcher gold set → Task 10 ✓
- Module layout (spec §15: model/match/resolve/rollup/bind) → Tasks 2,5,7,8 ✓; storage parity → Tasks 1,3,4,6 ✓
- Deferred correctly (NOT Plan A): recall_workstream + work-digest swap + telemetry (Plan B); lifecycle MCP tools + merge-suggestion (Plan C); seed + backfill + verify + flip (Plan D). v2 start-side binding deferred per spec §14. ✓

**2. Placeholder scan:** every code step contains complete code; commands have expected output. Task 9's integration test is described against the existing scheduler-test pattern rather than fully transcribed because the harness setup must be copied from the repo's nearest scheduler test (flagged explicitly, not a hidden TODO). Task 10's real gold labels are an operator step by design (honest accounting, not fabrication).

**3. Type consistency:** `Workstream`, `BindingSource`, `MatchInputs/MatchDecision/MatchThresholds/MatchWeights`, `WorkstreamCandidate`, `WorkstreamRollup` defined once in `model.ts` and referenced unchanged. `matchWorkstream`, `resolveWorkstreamId`, `rollupWorkstream`, `bindSessionToWorkstream`, `normalizeLabel`, `makeWorkstreamId` names are stable across tasks. Store methods (`setWorkstreamBinding`, `listSessionIdsByWorkstreams`, `getEntities`, `getWorkstreamIds`, `listBySessions`, `candidatesByEntityOverlap`, `entitiesFor`, `upsertEntities`, `touchLastSession`, `findByNormalizedLabel`) are consistent between port declarations and adapter implementations.

**Cross-plan dependencies (flagged):**
- `HIGH`/`LOW` are provisional (`DEFAULT_THRESHOLDS`) until Plan D's gold-set run; `match.ts` never hard-codes them.
- Live binding stays flag-off (`NLM_WORKSTREAM_BIND`) through Plans A–C; Plan D flips it after seed+tune+backfill+verify. This prevents the pre-seed "workstream swamp."
- Plan A's `tune-matcher.ts` becomes runnable end-to-end only once Plan D seeds candidate workstreams; Plan A verifies the harness math against a synthetic fixture.
