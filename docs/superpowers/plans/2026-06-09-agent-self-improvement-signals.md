# Agent Self-Improvement Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture structured quality/eval signals from any harness, aggregate them, and recall "known failure modes for this repo/model" back into the agent's prompt at session start.

**Architecture:** A new store kind (`signals`) mirrors the existing FactStore seam but is simpler (append-only, idempotent, no supersedence, no embeddings). Two transports feed it (HTTP `POST /api/signal` and Pi session-embedded `nlm.signal` entries drained by the scheduler). A pure aggregator rolls signals into threshold-gated failure modes; a recall service renders a deterministic text block injected at session start in both Claude Code and Pi. UI + `nlm improve` surface findings; nothing auto-acts.

**Tech Stack:** TypeScript (Node 20+, ESM), better-sqlite3 + sqlite-vec (default), pg + pgvector (optional), Hono HTTP, Vitest. Spec: [docs/superpowers/specs/2026-06-09-agent-self-improvement-signals.md](../specs/2026-06-09-agent-self-improvement-signals.md).

---

## File Structure

**NLM core (`~/Documents/Coding Projects/nlm-memory`):**

- Create `src/ports/signal-store.ts` — `SignalStore` port + filter types.
- Create `src/core/storage/sqlite-signal-store.ts` — SQLite adapter (idempotent insert).
- Create `src/core/storage/pg-signal-store.ts` — Postgres adapter.
- Create `src/core/signals/install-scope.ts` — generate-once `~/.nlm/install-id`.
- Create `src/core/signals/ingest-signal.ts` — validate/normalize raw payload → `Signal`, deterministic id.
- Create `src/core/signals/aggregate.ts` — pure roll-up + threshold gate.
- Create `src/core/signals/failure-mode-recall.ts` — build the injected text block.
- Create `migrations/017_signals.sql` — SQLite `signals` table.
- Create `tests/contract/signal-store.contract.ts` — backend-agnostic contract.
- Create `tests/fixtures/signals.ts` — `makeSignal` fixture.
- Create `tests/integration/sqlite-signal-store.test.ts`, `tests/integration/signal-store.pg.test.ts`.
- Create `tests/unit/core/signals/*.test.ts` — ingest, aggregate, recall units.
- Create `tests/unit/http/signal-routes.test.ts` — HTTP route units.
- Modify `src/shared/types.ts` — add `SignalKind`, `SignalOutcome`, `SignalInput`, `Signal`.
- Modify `src/ports/storage.ts` — add `signals: SignalStore` to `Storage` (NOT `StorageContext`).
- Modify `src/core/storage/sqlite-storage.ts` + `pg-storage.ts` — construct/expose `signals`.
- Modify `migrations/pg/001_initial.sql` — append the `signals` table.
- Modify `src/ports/transcript-adapter.ts` — add optional `signals?: ReadonlyArray<unknown>` to `SessionChunk`.
- Modify `src/core/adapters/pi.ts` — recognize `customType === "nlm.signal"` custom entries.
- Modify `src/core/scheduler/scheduler.ts` + `scan-once.ts` carrier — drain `chunk.signals` before classify.
- Modify `src/http/app.ts` — `POST /api/signal`, `GET /api/signals/failure-modes`, `GET /api/signals/stats`.
- Modify `src/hook/session-start-hook.ts` — `fetchFailureModeBlock()` composed in `main()`.
- Modify `src/ui/pages/Recall.tsx` — failure-modes panel.
- Modify `src/cli/nlm.ts` — wire `signals` store + `installScope` into stack, app, scheduler; add `nlm improve`.

**Pi reference producer + consumer (`~/Documents/Coding Projects/pi-sandbox`):**

- Modify `extensions/quality-gate/index.ts` — emit `nlm.signal` (per-step + exhausted).
- Create `extensions/nlm-failure-modes/index.ts` + `package.json` — `before_agent_start` consumer.
- Modify `README.md` (or `docs/`) — document the integration.

**Conventions for every task:** run `npm test` (vitest) and `npm run typecheck` before each commit. No em dashes, no emojis in any user-facing string. Commit messages end with the repo trailer used in git history (plain `feat:`/`test:` prefixes; no co-author trailer required by this repo, match existing log style).

---

## Layer 1 — Signal store

### Task 1: Signal types

**Files:**
- Modify: `src/shared/types.ts` (append after the `FactHistoryChain` block, ~line 148)
- Test: `tests/unit/core/signals/types.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/types.test.ts
import { describe, expect, it } from "vitest";
import type { Signal, SignalInput, SignalKind, SignalOutcome } from "../../../../src/shared/types.js";

describe("signal types", () => {
  it("constructs a Signal with all fields", () => {
    const s: Signal = {
      id: "sig_1",
      v: 1,
      installScope: "install-abc",
      kind: "gate",
      producer: "quality-gate",
      outcome: "fail",
      model: "qwen3-coder",
      repo: "/repo/x",
      step: "types",
      detail: { files: ["a.ts"], attempt: 2 },
      sessionId: "pi_123",
      ts: "2026-06-09T18:00:00.000Z",
      createdAt: "2026-06-09T18:00:01.000Z",
    };
    expect(s.kind).toBe("gate");
  });

  it("constructs a SignalInput (producer-side, no install/id)", () => {
    const i: SignalInput = {
      kind: "gate",
      producer: "quality-gate",
      outcome: "pass",
      model: "qwen3-coder",
      repo: "/repo/x",
      step: null,
      detail: null,
      session: null,
      ts: "2026-06-09T18:00:00.000Z",
    };
    const k: SignalKind = i.kind;
    const o: SignalOutcome = i.outcome;
    expect([k, o]).toEqual(["gate", "pass"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/signals/types.test.ts`
Expected: FAIL — module has no exports `Signal`/`SignalInput`.

- [ ] **Step 3: Add the types**

Append to `src/shared/types.ts`:

```ts
// ── Signals (agent self-improvement lane) ──────────────────────────────────
//
// A distinct store kind from facts: structured quality/eval telemetry emitted
// by harnesses (the Pi quality gate is the reference producer). Append-only,
// idempotent on a deterministic id, no supersedence, no embeddings. See
// docs/superpowers/specs/2026-06-09-agent-self-improvement-signals.md.

export type SignalKind = "gate" | "eval" | "review" | "test";
export type SignalOutcome = "pass" | "fail" | "fix" | "exhausted";

/** Producer-side payload. `install_scope` and `id` are stamped server-side. */
export interface SignalInput {
  readonly v?: number;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly session: string | null;
  readonly ts: string;
}

/** Stored signal. `step` is denormalized from `detail.step` for indexing. */
export interface Signal {
  readonly id: string;
  readonly v: number;
  readonly installScope: string;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly sessionId: string | null;
  readonly ts: string;
  readonly createdAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/signals/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts tests/unit/core/signals/types.test.ts
git commit -m "feat(signals): add Signal/SignalInput types"
```

---

### Task 2: SignalStore port

**Files:**
- Create: `src/ports/signal-store.ts`
- Test: covered by the contract test (Task 5); no standalone test for the interface.

- [ ] **Step 1: Write the port**

```ts
// src/ports/signal-store.ts
/**
 * SignalStore — the only way core/ reads or writes the signal corpus.
 *
 * Sibling to FactStore but deliberately simpler: append-only, idempotent on a
 * deterministic id (ON CONFLICT DO NOTHING), no supersedence, no embeddings.
 * Signals are high-volume structured telemetry, not LLM-distilled facts.
 */

import type { Signal, SignalKind } from "@shared/types.js";

export interface SignalAggregationFilter {
  readonly installScope: string;
  readonly repo?: string;
  readonly model?: string;
  readonly kind?: SignalKind;
  /** ISO lower bound on `ts` (inclusive). Omit for all-time. */
  readonly sinceTs?: string;
  /** Safety cap on rows scanned. Defaults to 5000 in the adapter. */
  readonly limit?: number;
}

export interface SignalStore {
  /** Insert one signal. Idempotent: a duplicate id is a no-op, not an error. */
  insert(signal: Signal): Promise<void>;

  /** Insert many signals in one transaction. Duplicate ids are skipped. */
  insertMany(signals: ReadonlyArray<Signal>): Promise<void>;

  /** Rows matching the filter, newest `ts` first, for in-process aggregation. */
  listForAggregation(filter: SignalAggregationFilter): Promise<ReadonlyArray<Signal>>;

  /** Count signals for an install with `ts >= sinceTs`. */
  countSince(installScope: string, sinceTs: string): Promise<number>;

  /** Delete signals with `ts < olderThanTs`. Returns rows deleted. */
  pruneOlderThan(olderThanTs: string): Promise<number>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/ports/signal-store.ts
git commit -m "feat(signals): add SignalStore port"
```

---

### Task 3: SQLite migration

**Files:**
- Create: `migrations/017_signals.sql`
- Test: verified via Task 5 contract setup (migrations run on `SqliteStorage.create`).

- [ ] **Step 1: Write the migration**

```sql
-- Migration 017: signals — agent self-improvement telemetry lane.
--
-- Distinct from facts: append-only, idempotent on a deterministic id, no
-- supersedence pointer, no embeddings. No FK to sessions — a signal can arrive
-- before or without a session row; session_id is a soft link.

CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  v             INTEGER NOT NULL DEFAULT 1,
  install_scope TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('gate', 'eval', 'review', 'test')),
  producer      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'fix', 'exhausted')),
  model         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  step          TEXT,
  detail        TEXT,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Aggregation hot path: failure-mode roll-up scoped to an install + repo/model.
CREATE INDEX IF NOT EXISTS idx_signals_agg
  ON signals(install_scope, repo, model, kind, step);

-- Retention prune + recency window scans.
CREATE INDEX IF NOT EXISTS idx_signals_ts
  ON signals(ts);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (17, '017_signals');
```

- [ ] **Step 2: Verify it applies cleanly**

Run: `node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)');db.exec(require('fs').readFileSync('migrations/017_signals.sql','utf8'));console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"signals\"').get())"`
Expected: prints `{ name: 'signals' }`.

- [ ] **Step 3: Commit**

```bash
git add migrations/017_signals.sql
git commit -m "feat(signals): add 017_signals SQLite migration"
```

---

### Task 4: SqliteSignalStore

**Files:**
- Create: `src/core/storage/sqlite-signal-store.ts`
- Test: covered by the contract test (Task 5).

- [ ] **Step 1: Write the adapter**

```ts
// src/core/storage/sqlite-signal-store.ts
/**
 * SqliteSignalStore — canonical SignalStore over the shared better-sqlite3
 * connection (same handle as SqliteSessionStore). Insert is idempotent via
 * INSERT OR IGNORE on the deterministic primary key.
 */

import type Database from "better-sqlite3";
import type { SignalAggregationFilter, SignalStore } from "@ports/signal-store.js";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

type SignalRow = {
  id: string;
  v: number;
  install_scope: string;
  kind: SignalKind;
  producer: string;
  outcome: SignalOutcome;
  model: string;
  repo: string;
  step: string | null;
  detail: string | null;
  session_id: string | null;
  ts: string;
  created_at: string;
};

const SCAN_CAP = 5000;

export class SqliteSignalStore implements SignalStore {
  constructor(private readonly db: Database.Database) {}

  async insert(signal: Signal): Promise<void> {
    this.insertStmt().run(this.toRow(signal));
  }

  async insertMany(signals: ReadonlyArray<Signal>): Promise<void> {
    if (signals.length === 0) return;
    const stmt = this.insertStmt();
    const txn = this.db.transaction((rows: ReadonlyArray<SignalRow>) => {
      for (const row of rows) stmt.run(row);
    });
    txn(signals.map((s) => this.toRow(s)));
  }

  async listForAggregation(
    filter: SignalAggregationFilter,
  ): Promise<ReadonlyArray<Signal>> {
    const where: string[] = ["install_scope = ?"];
    const params: Array<string | number> = [filter.installScope];
    if (filter.repo !== undefined) { where.push("repo = ?"); params.push(filter.repo); }
    if (filter.model !== undefined) { where.push("model = ?"); params.push(filter.model); }
    if (filter.kind !== undefined) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.sinceTs !== undefined) { where.push("ts >= ?"); params.push(filter.sinceTs); }
    const limit = Math.max(1, Math.min(SCAN_CAP, Math.trunc(filter.limit ?? SCAN_CAP)));
    params.push(limit);
    const rows = this.db
      .prepare<Array<string | number>, SignalRow>(
        `SELECT id, v, install_scope, kind, producer, outcome, model, repo,
                step, detail, session_id, ts, created_at
         FROM signals
         WHERE ${where.join(" AND ")}
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => this.rowToSignal(r));
  }

  async countSince(installScope: string, sinceTs: string): Promise<number> {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM signals WHERE install_scope = ? AND ts >= ?",
      )
      .get(installScope, sinceTs);
    return row?.n ?? 0;
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    const info = this.db.prepare("DELETE FROM signals WHERE ts < ?").run(olderThanTs);
    return info.changes;
  }

  private insertStmt() {
    return this.db.prepare<SignalRow>(`
      INSERT OR IGNORE INTO signals (
        id, v, install_scope, kind, producer, outcome, model, repo,
        step, detail, session_id, ts, created_at
      ) VALUES (
        @id, @v, @install_scope, @kind, @producer, @outcome, @model, @repo,
        @step, @detail, @session_id, @ts, @created_at
      )
    `);
  }

  private toRow(s: Signal): SignalRow {
    return {
      id: s.id,
      v: s.v,
      install_scope: s.installScope,
      kind: s.kind,
      producer: s.producer,
      outcome: s.outcome,
      model: s.model,
      repo: s.repo,
      step: s.step,
      detail: s.detail === null ? null : JSON.stringify(s.detail),
      session_id: s.sessionId,
      ts: s.ts,
      created_at: s.createdAt,
    };
  }

  private rowToSignal(row: SignalRow): Signal {
    return {
      id: row.id,
      v: row.v,
      installScope: row.install_scope,
      kind: row.kind,
      producer: row.producer,
      outcome: row.outcome,
      model: row.model,
      repo: row.repo,
      step: row.step,
      detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>),
      sessionId: row.session_id,
      ts: row.ts,
      createdAt: row.created_at,
    };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/storage/sqlite-signal-store.ts
git commit -m "feat(signals): add SqliteSignalStore"
```

---

### Task 5: Signal store contract + SQLite integration

**Files:**
- Create: `tests/fixtures/signals.ts`
- Create: `tests/contract/signal-store.contract.ts`
- Create: `tests/integration/sqlite-signal-store.test.ts`

- [ ] **Step 1: Write the fixture**

```ts
// tests/fixtures/signals.ts
import type { Signal } from "../../src/shared/types.js";

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  const base: Signal = {
    id: "sig_test_1",
    v: 1,
    installScope: "install-test",
    kind: "gate",
    producer: "quality-gate",
    outcome: "fail",
    model: "qwen3-coder",
    repo: "/repo/x",
    step: "types",
    detail: { files: ["a.ts"], attempt: 1 },
    sessionId: "pi_test_1",
    ts: "2026-06-09T18:00:00.000Z",
    createdAt: "2026-06-09T18:00:01.000Z",
  };
  return { ...base, ...overrides };
}
```

- [ ] **Step 2: Write the contract**

```ts
// tests/contract/signal-store.contract.ts
/**
 * Backend-agnostic contract for the SignalStore port. Each adapter integration
 * test supplies a harness that builds a fresh, migrated, empty Storage.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeSignal } from "../fixtures/signals.js";

export interface SignalStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

export function runSignalStoreContract(h: SignalStoreContractHarness): void {
  describe(`SignalStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => { storage = await h.setup(); });
    afterEach(async () => { await h.teardown(storage); });

    it("inserts and lists a signal round-trip", async () => {
      const s = makeSignal({ id: "sig_a" });
      await storage.signals.insert(s);
      const rows = await storage.signals.listForAggregation({ installScope: "install-test" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(s);
    });

    it("insert is idempotent on duplicate id", async () => {
      await storage.signals.insert(makeSignal({ id: "sig_dup", outcome: "fail" }));
      await storage.signals.insert(makeSignal({ id: "sig_dup", outcome: "pass" }));
      const rows = await storage.signals.listForAggregation({ installScope: "install-test" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("fail"); // first write wins
    });

    it("insertMany skips duplicates and inserts the rest", async () => {
      await storage.signals.insert(makeSignal({ id: "sig_x" }));
      await storage.signals.insertMany([
        makeSignal({ id: "sig_x" }),
        makeSignal({ id: "sig_y" }),
      ]);
      const rows = await storage.signals.listForAggregation({ installScope: "install-test" });
      expect(rows.map((r) => r.id).sort()).toEqual(["sig_x", "sig_y"]);
    });

    it("filters by repo, model, kind, and sinceTs", async () => {
      await storage.signals.insertMany([
        makeSignal({ id: "s1", repo: "/a", model: "m1", kind: "gate", ts: "2026-06-01T00:00:00.000Z" }),
        makeSignal({ id: "s2", repo: "/b", model: "m1", kind: "gate", ts: "2026-06-09T00:00:00.000Z" }),
        makeSignal({ id: "s3", repo: "/a", model: "m2", kind: "test", ts: "2026-06-09T00:00:00.000Z" }),
      ]);
      const byRepo = await storage.signals.listForAggregation({ installScope: "install-test", repo: "/a" });
      expect(byRepo.map((r) => r.id).sort()).toEqual(["s1", "s3"]);
      const since = await storage.signals.listForAggregation({ installScope: "install-test", sinceTs: "2026-06-05T00:00:00.000Z" });
      expect(since.map((r) => r.id).sort()).toEqual(["s2", "s3"]);
      const isolated = await storage.signals.listForAggregation({ installScope: "other-install" });
      expect(isolated).toHaveLength(0);
    });

    it("countSince and pruneOlderThan operate on ts", async () => {
      await storage.signals.insertMany([
        makeSignal({ id: "old", ts: "2026-01-01T00:00:00.000Z" }),
        makeSignal({ id: "new", ts: "2026-06-09T00:00:00.000Z" }),
      ]);
      expect(await storage.signals.countSince("install-test", "2026-06-01T00:00:00.000Z")).toBe(1);
      const pruned = await storage.signals.pruneOlderThan("2026-06-01T00:00:00.000Z");
      expect(pruned).toBe(1);
      const rest = await storage.signals.listForAggregation({ installScope: "install-test" });
      expect(rest.map((r) => r.id)).toEqual(["new"]);
    });
  });
}
```

- [ ] **Step 3: Write the SQLite integration wiring**

```ts
// tests/integration/sqlite-signal-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "../../src/ports/storage.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runSignalStoreContract } from "../contract/signal-store.contract.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const tmpDirs = new WeakMap<Storage, string>();

runSignalStoreContract({
  name: "sqlite",
  async setup() {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-signals-"));
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    tmpDirs.set(storage, tmp);
    return storage;
  },
  async teardown(storage) {
    const tmp = tmpDirs.get(storage);
    await storage.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  },
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run tests/integration/sqlite-signal-store.test.ts`
Expected: FAIL — `storage.signals` is undefined (not wired yet). This is the cue for Task 6.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/signals.ts tests/contract/signal-store.contract.ts tests/integration/sqlite-signal-store.test.ts
git commit -m "test(signals): add SignalStore contract + SQLite integration"
```

---

### Task 6: Wire signals into Storage (SQLite)

**Files:**
- Modify: `src/ports/storage.ts`
- Modify: `src/core/storage/sqlite-storage.ts`

- [ ] **Step 1: Add `signals` to the `Storage` interface only**

In `src/ports/storage.ts`, add the import and the member to `Storage` (NOT to `StorageContext` — signals never participate in `withTransaction`):

```ts
import type { FactStore } from "./fact-store.js";
import type { SessionStore } from "./session-store.js";
import type { SignalStore } from "./signal-store.js";
```

Then inside `export interface Storage {` add, alongside `facts` and `sessions`:

```ts
  readonly signals: SignalStore;
```

Leave `StorageContext` unchanged.

- [ ] **Step 2: Construct it in SqliteStorage**

In `src/core/storage/sqlite-storage.ts`:

```ts
import { SqliteSignalStore } from "./sqlite-signal-store.js";
```

Change the class members + constructor + `create`:

```ts
export class SqliteStorage implements Storage {
  readonly sessions: SqliteSessionStore;
  readonly facts: SqliteFactStore;
  readonly signals: SqliteSignalStore;
  private inTxn = false;

  private constructor(
    sessions: SqliteSessionStore,
    facts: SqliteFactStore,
    signals: SqliteSignalStore,
  ) {
    this.sessions = sessions;
    this.facts = facts;
    this.signals = signals;
  }

  static create(opts: SqliteStorageOptions): SqliteStorage {
    const sessions = new SqliteSessionStore(opts);
    const facts = new SqliteFactStore(sessions.rawDb());
    const signals = new SqliteSignalStore(sessions.rawDb());
    return new SqliteStorage(sessions, facts, signals);
  }
```

- [ ] **Step 3: Run the contract to verify it passes**

Run: `npx vitest run tests/integration/sqlite-signal-store.test.ts`
Expected: PASS (all contract assertions).

- [ ] **Step 4: Typecheck (PgStorage will now error — expected, fixed in Task 8)**

Run: `npm run typecheck`
Expected: FAIL — `PgStorage` does not implement `signals`. That is the cue for Tasks 7-8. (Do not commit a broken typecheck; proceed straight to Task 7-8, then commit all three together at the end of Task 8.)

---

### Task 7: PgSignalStore + pg migration

**Files:**
- Create: `src/core/storage/pg-signal-store.ts`
- Modify: `migrations/pg/001_initial.sql` (append)

- [ ] **Step 1: Write the Postgres adapter**

```ts
// src/core/storage/pg-signal-store.ts
/**
 * PgSignalStore — SignalStore over pg.Pool. Receives its Pool from PgStorage.
 * Insert is idempotent via ON CONFLICT (id) DO NOTHING.
 */

import type { Pool } from "pg";
import type { SignalAggregationFilter, SignalStore } from "@ports/signal-store.js";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

type SignalRow = {
  id: string;
  v: number;
  install_scope: string;
  kind: SignalKind;
  producer: string;
  outcome: SignalOutcome;
  model: string;
  repo: string;
  step: string | null;
  detail: string | null;
  session_id: string | null;
  ts: string;
  created_at: string;
};

const SCAN_CAP = 5000;
const INSERT_SQL = `
  INSERT INTO signals (
    id, v, install_scope, kind, producer, outcome, model, repo,
    step, detail, session_id, ts, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (id) DO NOTHING`;

function insertParams(s: Signal): unknown[] {
  return [
    s.id, s.v, s.installScope, s.kind, s.producer, s.outcome, s.model, s.repo,
    s.step, s.detail === null ? null : JSON.stringify(s.detail), s.sessionId, s.ts, s.createdAt,
  ];
}

export class PgSignalStore implements SignalStore {
  constructor(private readonly pool: Pool) {}

  async insert(signal: Signal): Promise<void> {
    await this.pool.query(INSERT_SQL, insertParams(signal));
  }

  async insertMany(signals: ReadonlyArray<Signal>): Promise<void> {
    if (signals.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const s of signals) await client.query(INSERT_SQL, insertParams(s));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listForAggregation(filter: SignalAggregationFilter): Promise<ReadonlyArray<Signal>> {
    const where: string[] = ["install_scope = $1"];
    const params: unknown[] = [filter.installScope];
    let idx = 2;
    if (filter.repo !== undefined) { where.push(`repo = $${idx++}`); params.push(filter.repo); }
    if (filter.model !== undefined) { where.push(`model = $${idx++}`); params.push(filter.model); }
    if (filter.kind !== undefined) { where.push(`kind = $${idx++}`); params.push(filter.kind); }
    if (filter.sinceTs !== undefined) { where.push(`ts >= $${idx++}`); params.push(filter.sinceTs); }
    const limit = Math.max(1, Math.min(SCAN_CAP, Math.trunc(filter.limit ?? SCAN_CAP)));
    params.push(limit);
    const result = await this.pool.query<SignalRow>(
      `SELECT id, v, install_scope, kind, producer, outcome, model, repo,
              step, detail, session_id, ts, created_at
       FROM signals
       WHERE ${where.join(" AND ")}
       ORDER BY ts DESC
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(rowToSignal);
  }

  async countSince(installScope: string, sinceTs: string): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM signals WHERE install_scope = $1 AND ts >= $2",
      [installScope, sinceTs],
    );
    return Number.parseInt(result.rows[0]?.n ?? "0", 10);
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM signals WHERE ts < $1", [olderThanTs]);
    return result.rowCount ?? 0;
  }
}

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    v: row.v,
    installScope: row.install_scope,
    kind: row.kind,
    producer: row.producer,
    outcome: row.outcome,
    model: row.model,
    repo: row.repo,
    step: row.step,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>),
    sessionId: row.session_id,
    ts: row.ts,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 2: Append the table to the pg migration**

Append to the end of `migrations/pg/001_initial.sql`:

```sql
-- Signals — agent self-improvement telemetry lane (mirror of SQLite 017).
CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  v             INTEGER NOT NULL DEFAULT 1,
  install_scope TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('gate', 'eval', 'review', 'test')),
  producer      TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'fix', 'exhausted')),
  model         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  step          TEXT,
  detail        TEXT,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (now()::text)
);
CREATE INDEX IF NOT EXISTS idx_signals_agg ON signals(install_scope, repo, model, kind, step);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
```

- [ ] **Step 3: Commit (still part of the Task 6-8 group; commit after Task 8 typecheck passes)**

(No commit yet — proceed to Task 8.)

---

### Task 8: Wire signals into PgStorage + run pg contract

**Files:**
- Modify: `src/core/storage/pg-storage.ts`
- Create: `tests/integration/signal-store.pg.test.ts`

- [ ] **Step 1: Construct signals in PgStorage**

In `src/core/storage/pg-storage.ts`:

```ts
import { PgSignalStore } from "./pg-signal-store.js";
```

Add the member and construct it:

```ts
export class PgStorage implements Storage {
  readonly facts: PgFactStore;
  readonly sessions: PgSessionStore;
  readonly signals: PgSignalStore;
  // ...existing fields...

  private constructor(pool: Pool, migrationsDir: string) {
    this._pool = pool;
    this._migrationsDir = migrationsDir;
    this.facts = new PgFactStore(pool);
    this.sessions = new PgSessionStore(pool);
    this.signals = new PgSignalStore(pool);
  }
```

- [ ] **Step 2: Write the pg integration wiring (skips when no PG)**

```ts
// tests/integration/signal-store.pg.test.ts
import { describe, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { runSignalStoreContract } from "../contract/signal-store.contract.js";
import { resolve } from "node:path";

const PG_URL = process.env["NLM_TEST_PG_URL"];
const PG_MIGRATIONS_DIR = resolve(__dirname, "../../migrations/pg");

if (!PG_URL) {
  describe.skip("SignalStore contract: pg (NLM_TEST_PG_URL unset)", () => {
    it("skipped", () => {});
  });
} else {
  runSignalStoreContract({
    name: "pg",
    async setup() {
      const storage = PgStorage.create({ connectionString: PG_URL, migrationsDir: PG_MIGRATIONS_DIR });
      await storage.init();
      await (storage as PgStorage).pgPool().query("TRUNCATE signals");
      return storage;
    },
    async teardown(storage) {
      await (storage as PgStorage).pgPool().query("TRUNCATE signals");
      await storage.close();
    },
  });
}
```

- [ ] **Step 3: Typecheck + run SQLite suite (pg auto-skips locally)**

Run: `npm run typecheck && npx vitest run tests/integration/sqlite-signal-store.test.ts tests/integration/signal-store.pg.test.ts`
Expected: typecheck PASS; sqlite contract PASS; pg contract SKIPPED.

- [ ] **Step 4: Commit Tasks 6-8 together**

```bash
git add src/ports/storage.ts src/core/storage/sqlite-storage.ts src/core/storage/pg-storage.ts src/core/storage/pg-signal-store.ts migrations/pg/001_initial.sql tests/integration/signal-store.pg.test.ts
git commit -m "feat(signals): wire SignalStore through Storage (sqlite + pg)"
```

---

## Layer 2 — Ingest

### Task 9: install-scope helper

**Files:**
- Create: `src/core/signals/install-scope.ts`
- Test: `tests/unit/core/signals/install-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/install-scope.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installScope } from "../../../../src/core/signals/install-scope.js";

describe("installScope", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nlm-install-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("generates a stable id and persists it", () => {
    const path = join(dir, "install-id");
    const a = installScope(path);
    const b = installScope(path);
    expect(a).toBe(b);
    expect(readFileSync(path, "utf8").trim()).toBe(a);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/signals/install-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/signals/install-scope.ts
/**
 * Per-install scope id. Generated once, persisted at ~/.nlm/install-id, and
 * stamped on every signal so recall can isolate signals to the local install
 * even when an instance is shared over Tailscale. Memoized per process.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let cached: string | null = null;

export function installScope(path = join(homedir(), ".nlm", "install-id")): string {
  if (cached) return cached;
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (existing) { cached = existing; return existing; }
    }
  } catch {
    // unreadable — fall through and try to (re)generate
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
  } catch {
    // best-effort persist; the in-process cache still keeps it stable this run
  }
  cached = id;
  return id;
}

/** Test-only: drop the process memo so a fresh path is read. */
export function resetInstallScopeCache(): void {
  cached = null;
}
```

Update the test to reset the cache between cases (the memo is process-global):

```ts
import { installScope, resetInstallScopeCache } from "../../../../src/core/signals/install-scope.js";
// in beforeEach, after mkdtemp:
resetInstallScopeCache();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/signals/install-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/signals/install-scope.ts tests/unit/core/signals/install-scope.test.ts
git commit -m "feat(signals): add per-install scope id helper"
```

---

### Task 10: normalizeSignal + deterministic id

**Files:**
- Create: `src/core/signals/ingest-signal.ts`
- Test: `tests/unit/core/signals/ingest-signal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/ingest-signal.test.ts
import { describe, expect, it } from "vitest";
import { normalizeSignal, signalId } from "../../../../src/core/signals/ingest-signal.js";

const NOW = () => "2026-06-09T12:00:00.000Z";

describe("normalizeSignal", () => {
  it("normalizes a full payload and derives step from detail", () => {
    const s = normalizeSignal(
      {
        v: 1, kind: "gate", producer: "quality-gate", outcome: "fail",
        model: "qwen3-coder", repo: "/repo/x",
        detail: { step: "types", files: ["a.ts"], attempt: 2 },
        session: "pi_9", ts: "2026-06-09T18:00:00.000Z",
      },
      "install-1", NOW,
    );
    expect(s.step).toBe("types");
    expect(s.installScope).toBe("install-1");
    expect(s.sessionId).toBe("pi_9");
    expect(s.createdAt).toBe("2026-06-09T12:00:00.000Z");
  });

  it("is deterministic: same (session, producer, ts, step, outcome) -> same id", () => {
    const base = { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "lint" }, session: "s1", ts: "2026-06-09T18:00:00.000Z" };
    expect(normalizeSignal(base, "i", NOW).id).toBe(normalizeSignal(base, "i", NOW).id);
  });

  it("soft-defaults missing model/repo/producer to 'unknown' and ts to now()", () => {
    const s = normalizeSignal({ kind: "test", outcome: "pass", step: null, detail: null, session: null }, "i", NOW);
    expect([s.model, s.repo, s.producer, s.ts]).toEqual(["unknown", "unknown", "unknown", "2026-06-09T12:00:00.000Z"]);
  });

  it("throws on invalid kind (lane definer)", () => {
    expect(() => normalizeSignal({ kind: "bogus", outcome: "pass" }, "i", NOW)).toThrow(/kind/);
  });

  it("throws on invalid outcome (lane definer)", () => {
    expect(() => normalizeSignal({ kind: "gate", outcome: "boom" }, "i", NOW)).toThrow(/outcome/);
  });

  it("throws on non-object payload", () => {
    expect(() => normalizeSignal("nope", "i", NOW)).toThrow();
  });

  it("signalId is stable", () => {
    const a = signalId({ sessionId: "s", producer: "p", ts: "t", step: "x", outcome: "fail" });
    const b = signalId({ sessionId: "s", producer: "p", ts: "t", step: "x", outcome: "fail" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sig_[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/signals/ingest-signal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/signals/ingest-signal.ts
/**
 * Boundary validation + normalization for inbound signals (HTTP and
 * session-embedded share this). kind/outcome are the lane definers — invalid
 * values throw (fail loud at the boundary). producer/model/repo/ts soft-default
 * so a sloppy-but-valid producer still records data rather than being dropped.
 *
 * The id is deterministic over (session, producer, ts, step, outcome) so a
 * session file re-parsed after it grows re-emits the same ids and the store's
 * ON CONFLICT DO NOTHING makes re-ingest a no-op.
 */

import { createHash } from "node:crypto";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

const KINDS: ReadonlySet<string> = new Set(["gate", "eval", "review", "test"]);
const OUTCOMES: ReadonlySet<string> = new Set(["pass", "fail", "fix", "exhausted"]);

export function signalId(parts: {
  sessionId: string | null;
  producer: string;
  ts: string;
  step: string | null;
  outcome: string;
}): string {
  const hash = createHash("sha256")
    .update([parts.sessionId ?? "", parts.producer, parts.ts, parts.step ?? "", parts.outcome].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `sig_${hash}`;
}

export function normalizeSignal(
  raw: unknown,
  installScope: string,
  now: () => string = () => new Date().toISOString(),
): Signal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("signal payload must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const kind = o["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new Error(`signal.kind must be one of gate|eval|review|test (got ${String(kind)})`);
  }
  const outcome = o["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    throw new Error(`signal.outcome must be one of pass|fail|fix|exhausted (got ${String(outcome)})`);
  }

  const str = (key: string, fallback: string): string =>
    typeof o[key] === "string" && (o[key] as string).length > 0 ? (o[key] as string) : fallback;

  const detail =
    o["detail"] && typeof o["detail"] === "object" && !Array.isArray(o["detail"])
      ? (o["detail"] as Record<string, unknown>)
      : null;
  const step =
    detail && typeof detail["step"] === "string"
      ? (detail["step"] as string)
      : typeof o["step"] === "string"
        ? (o["step"] as string)
        : null;
  const sessionId = typeof o["session"] === "string" && (o["session"] as string).length > 0 ? (o["session"] as string) : null;
  const ts = typeof o["ts"] === "string" && (o["ts"] as string).length > 0 ? (o["ts"] as string) : now();
  const v = typeof o["v"] === "number" ? o["v"] : 1;
  const producer = str("producer", "unknown");

  return {
    id: signalId({ sessionId, producer, ts, step, outcome }),
    v,
    installScope,
    kind: kind as SignalKind,
    producer,
    outcome: outcome as SignalOutcome,
    model: str("model", "unknown"),
    repo: str("repo", "unknown"),
    step,
    detail,
    sessionId,
    ts,
    createdAt: now(),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/signals/ingest-signal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/signals/ingest-signal.ts tests/unit/core/signals/ingest-signal.test.ts
git commit -m "feat(signals): add normalizeSignal + deterministic id"
```

---

### Task 11: POST /api/signal route

**Files:**
- Modify: `src/http/app.ts`
- Test: `tests/unit/http/signal-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/http/signal-routes.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { SignalStore, SignalAggregationFilter } from "../../../src/ports/signal-store.js";
import type { Signal } from "../../../src/shared/types.js";

function fakeStore(): SignalStore & { rows: Signal[] } {
  const rows: Signal[] = [];
  return {
    rows,
    async insert(s) { if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async insertMany(ss) { for (const s of ss) if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async listForAggregation(_f: SignalAggregationFilter) { return rows; },
    async countSince() { return rows.length; },
    async pruneOlderThan() { return 0; },
  };
}

// Minimal deps: the route only needs signalStore + installScope. Other deps
// are typed optional on HttpDeps; cast through a partial for the unit.
function appWith(store: SignalStore) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {} as never,
    signalStore: store,
    installScope: "install-test",
  } as never);
}

describe("POST /api/signal", () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => { store = fakeStore(); });

  it("accepts a valid signal and stores it", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "types" }, session: "s1", ts: "2026-06-09T18:00:00.000Z" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string };
    expect(body.id).toMatch(/^sig_/);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.installScope).toBe("install-test");
  });

  it("rejects an invalid kind with 400", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ kind: "bogus", outcome: "pass" }),
    });
    expect(res.status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects non-JSON with 400", async () => {
    const app = appWith(store);
    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
```

(Note: the local-only middleware is bypassed under `VITEST`, per `installLocalOnlyMiddleware`, so no auth headers beyond `host` are needed.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/http/signal-routes.test.ts`
Expected: FAIL — `signalStore` not on `HttpDeps`; route absent.

- [ ] **Step 3: Add deps + route**

In `src/http/app.ts`, add imports near the other core imports:

```ts
import type { SignalStore } from "@ports/signal-store.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import { buildFailureModeBlock } from "@core/signals/failure-mode-recall.js";
import { aggregateFailureModes } from "@core/signals/aggregate.js";
```

Add to the `HttpDeps` interface:

```ts
  /** Signal store — wire to enable POST /api/signal + GET /api/signals/*. */
  readonly signalStore?: SignalStore;
  /** Per-install scope stamped on every ingested signal. */
  readonly installScope?: string;
```

Register the route group in `createApp` (add the call alongside the other `registerXxx` calls):

```ts
  registerSignalRoutes(app, deps);
```

Add the function (the failure-modes and stats routes here are completed in Tasks 16 + 17; include all three now so the file has one signal-route group):

```ts
function registerSignalRoutes(app: Hono, deps: HttpDeps): void {
  app.post("/api/signal", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    if (process.env["NLM_SIGNALS_ENABLED"] === "0") {
      return c.json({ error: "signals disabled" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    let signal;
    try {
      signal = normalizeSignal(body, deps.installScope);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "invalid signal" }, 400);
    }
    try {
      await deps.signalStore.insert(signal);
    } catch {
      return c.json({ error: "signal insert failed" }, 500);
    }
    return c.json({ id: signal.id, status: "accepted" }, 202);
  });

  app.get("/api/signals/failure-modes", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    const repo = c.req.query("repo");
    if (!repo) return c.json({ error: "repo is required" }, 400);
    const model = c.req.query("model");
    const block = await buildFailureModeBlock(
      deps.signalStore,
      { installScope: deps.installScope, repo, ...(model ? { model } : {}) },
    );
    return c.json({ repo, model: model ?? null, block });
  });

  app.get("/api/signals/stats", async (c) => {
    if (!deps.signalStore || deps.installScope === undefined) {
      return c.json({ error: "signal store not wired in this deployment" }, 503);
    }
    const daysStr = c.req.query("days") ?? "14";
    const days = Number.parseInt(daysStr, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: "days must be 1..365" }, 400);
    }
    const sinceTs = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await deps.signalStore.listForAggregation({ installScope: deps.installScope, sinceTs });
    const modes = aggregateFailureModes(rows);
    return c.json({ days, total: rows.length, modes });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/http/signal-routes.test.ts`
Expected: PASS. (`buildFailureModeBlock`/`aggregateFailureModes` imports resolve once Tasks 12 + 16 land; if executing strictly in order, this task imports them ahead of definition. To keep each task green, implement Tasks 12 + 16 BEFORE running this step, or stub the two GET routes out and add them in Tasks 16/17. Recommended: reorder so Task 12 + 16 are done first. See note below.)

> **Execution note:** Layer 2's HTTP route imports the aggregator (Layer 3) and recall builder (Layer 4). To keep commits green, build **Task 12 (aggregate) and Task 15 (recall builder) before wiring the GET routes**. The `POST /api/signal` handler has no such dependency and can land first. If you prefer strict file-at-a-time, split this task: commit `POST /api/signal` now, add the two GET routes in Tasks 16/17.

- [ ] **Step 5: Commit**

```bash
git add src/http/app.ts tests/unit/http/signal-routes.test.ts
git commit -m "feat(signals): add POST /api/signal ingest route"
```

---

### Task 12: SessionChunk.signals + Pi adapter recognition

**Files:**
- Modify: `src/ports/transcript-adapter.ts`
- Modify: `src/core/adapters/pi.ts`
- Test: `tests/unit/core/adapters/pi-signals.test.ts`

- [ ] **Step 1: Add the optional field to the port**

In `src/ports/transcript-adapter.ts`, add to `SessionChunk` (after `label`):

```ts
  /**
   * Raw `nlm.signal` payloads found in the transcript (Pi custom_message
   * entries). Normalized + persisted by the scheduler, decoupled from session
   * classification. Undefined for adapters that do not emit signals.
   */
  readonly signals?: ReadonlyArray<unknown>;
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/core/adapters/pi-signals.test.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiAdapter } from "../../../../src/core/adapters/pi.js";

describe("PiAdapter nlm.signal recognition", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-sig-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("collects nlm.signal custom entries into chunk.signals and ignores other custom types", async () => {
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "pi_abc", cwd: "/repo/x" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "do work", timestamp: "2026-06-09T18:00:00Z" } }),
      JSON.stringify({ type: "custom_message", customType: "nlm.signal", details: { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/repo/x", detail: { step: "types" }, ts: "2026-06-09T18:01:00Z" } }),
      JSON.stringify({ type: "custom_message", customType: "whtnxt-tasks", content: "ignored" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "done", timestamp: "2026-06-09T18:02:00Z" } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const chunk = await new PiAdapter({ sessionsPath: dir }).parseSession(file);
    expect(chunk).not.toBeNull();
    expect(chunk!.signals).toHaveLength(1);
    expect((chunk!.signals![0] as { details?: unknown; kind?: string }).kind).toBe("gate");
  });

  it("leaves signals undefined when there are none", async () => {
    const file = join(dir, "plain.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session", id: "pi_x", cwd: "/r" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: "2026-06-09T18:00:00Z" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "yo", timestamp: "2026-06-09T18:00:05Z" } }),
    ].join("\n"));
    const chunk = await new PiAdapter({ sessionsPath: dir }).parseSession(file);
    expect(chunk!.signals).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/core/adapters/pi-signals.test.ts`
Expected: FAIL — `chunk.signals` is undefined for the first case.

- [ ] **Step 4: Implement in the Pi adapter**

In `src/core/adapters/pi.ts` `parseSession`, add a collector before the loop:

```ts
    const signals: unknown[] = [];
```

Replace the existing custom-entry skip block:

```ts
      if (
        evtType === "model_change" ||
        evtType === "thinking_level_change" ||
        evtType === "custom_message"
      ) {
        continue;
      }
```

with:

```ts
      if (evtType === "custom_message") {
        if (evt["customType"] === "nlm.signal") {
          const payload = evt["details"] ?? evt["content"];
          if (payload && typeof payload === "object") signals.push(payload);
        }
        continue;
      }
      if (evtType === "model_change" || evtType === "thinking_level_change") {
        continue;
      }
```

In the returned chunk object, add the field (only when non-empty so other adapters and signal-free sessions stay `undefined`):

```ts
      label,
      ...(signals.length > 0 ? { signals } : {}),
    };
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/core/adapters/pi-signals.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/transcript-adapter.ts src/core/adapters/pi.ts tests/unit/core/adapters/pi-signals.test.ts
git commit -m "feat(signals): recognize nlm.signal Pi custom entries"
```

---

### Task 13: Scheduler drains signals before classify

**Files:**
- Modify: `src/core/scheduler/scheduler.ts`
- Test: `tests/unit/core/scheduler/signal-drain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/scheduler/signal-drain.test.ts
import { describe, expect, it } from "vitest";
import { ScanScheduler } from "../../../../src/core/scheduler/scheduler.js";
import type { SignalStore } from "../../../../src/ports/signal-store.js";
import type { Signal } from "../../../../src/shared/types.js";
import type { TranscriptAdapter, SessionChunk } from "../../../../src/ports/transcript-adapter.js";

function chunkWithSignals(signals: unknown[]): SessionChunk {
  return {
    id: "pi_1", runtime: "pi/1.0", runtimeSessionId: "pi_1", sourcePath: "/tmp/x.jsonl",
    startedAt: "2026-06-09T18:00:00Z", endedAt: "2026-06-09T18:05:00Z", durationMin: 5,
    turnCount: 2, byteRange: [0, 100], projectDir: "/repo/x", gitBranch: "", text: "[user] hi",
    label: "hi", signals,
  };
}

// A scheduler whose only adapter returns one chunk carrying signals, and a
// classifier that always throws — proving signals are drained even when the
// session is never inserted (correction B).
function makeDeps(signals: unknown[], signalStore: SignalStore) {
  const adapter: TranscriptAdapter = {
    name: "pi", runtimeVersion: "pi/1.0", transcriptKind: "pi-jsonl",
    detect: () => ({ adapterName: "pi", enabled: true, path: null, hint: null }),
    discover: async () => ["/tmp/x.jsonl"],
    parseSession: async () => chunkWithSignals(signals),
  };
  return { adapter, signalStore };
}

describe("ScanScheduler signal drain", () => {
  it("drains chunk.signals to the store even when classification fails", async () => {
    const stored: Signal[] = [];
    const signalStore: SignalStore = {
      async insert(s) { stored.push(s); },
      async insertMany(ss) { stored.push(...ss); },
      async listForAggregation() { return []; },
      async countSince() { return 0; },
      async pruneOlderThan() { return 0; },
    };
    const { adapter } = makeDeps(
      [{ kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/repo/x", detail: { step: "types" }, ts: "2026-06-09T18:01:00Z" }],
      signalStore,
    );
    // scanOnce uses rawDb()/adapter_state. Provide a real in-memory SQLite store
    // via the test helper used elsewhere in scheduler tests. Here we assert the
    // drain path through a thrown classifier; see scheduler.test.ts for the
    // store harness this mirrors.
    const scheduler = new ScanScheduler({
      store: makeMemStore(),
      adapters: [adapter],
      classifier: { embed: async () => { throw new Error("no"); }, classify: async () => { throw new Error("classify fail"); } },
      embedder: null,
      signalStore,
      installScope: "install-test",
      idleMinutes: 0,
      logger: () => {},
    });
    await scheduler.tick();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.step).toBe("types");
    expect(stored[0]!.installScope).toBe("install-test");
  });
});

// Reuse the SQLite session store harness pattern from the existing
// scheduler.test.ts. Import it rather than redefining if that file exports one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteSessionStore } from "../../../../src/core/storage/sqlite-session-store.js";
function makeMemStore(): SqliteSessionStore {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-sched-"));
  return new SqliteSessionStore({ dbPath: join(tmp, "c.sqlite"), migrationsDir: resolve(__dirname, "../../../../migrations") });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/scheduler/signal-drain.test.ts`
Expected: FAIL — `SchedulerOptions` has no `signalStore`/`installScope`; signals never drained.

- [ ] **Step 3: Implement in the scheduler**

In `src/core/scheduler/scheduler.ts`:

Add imports:

```ts
import type { SignalStore } from "@ports/signal-store.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import type { Signal } from "@shared/types.js";
```

Add to `SchedulerOptions`:

```ts
  /** SignalStore for the self-improvement lane. When set, the tick drains
   *  each chunk's embedded nlm.signal payloads, decoupled from classification. */
  readonly signalStore?: SignalStore | null;
  /** Per-install scope stamped on drained signals. Required when signalStore is set. */
  readonly installScope?: string;
```

Add to the `Required<...>` opts shape and constructor defaults:

```ts
  private readonly opts: Required<Omit<SchedulerOptions, "embedder" | "factStore" | "signalStore" | "installScope">> & {
    readonly embedder: LLMClient | null;
    readonly factStore: SqliteFactStore | null;
    readonly signalStore: SignalStore | null;
    readonly installScope: string;
  };
```

In the constructor:

```ts
      signalStore: opts.signalStore ?? null,
      installScope: opts.installScope ?? "default",
```

In `tick()`, immediately after `chunksSeen += 1;`:

```ts
        await this.drainSignals(chunk);
```

Add the private method:

```ts
  private async drainSignals(chunk: { id: string; signals?: ReadonlyArray<unknown> }): Promise<void> {
    if (!this.opts.signalStore || !chunk.signals?.length) return;
    try {
      const normalized: Signal[] = [];
      for (const raw of chunk.signals) {
        try {
          normalized.push(normalizeSignal(raw, this.opts.installScope));
        } catch {
          // skip a malformed embedded signal; one bad entry must not lose the rest
        }
      }
      if (normalized.length > 0) await this.opts.signalStore.insertMany(normalized);
    } catch (e) {
      this.opts.logger(
        `[scheduler] signal drain failed for ${chunk.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/scheduler/signal-drain.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full scheduler suite for regressions**

Run: `npx vitest run tests/unit/core/scheduler/ tests/integration/`
Expected: PASS (existing scheduler tests unaffected; `signalStore` defaults to null).

- [ ] **Step 6: Commit**

```bash
git add src/core/scheduler/scheduler.ts tests/unit/core/scheduler/signal-drain.test.ts
git commit -m "feat(signals): drain embedded signals in scheduler before classify"
```

---

## Layer 3 — Aggregation

### Task 14: aggregateFailureModes

**Files:**
- Create: `src/core/signals/aggregate.ts`
- Test: `tests/unit/core/signals/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/aggregate.test.ts
import { describe, expect, it } from "vitest";
import { aggregateFailureModes } from "../../../../src/core/signals/aggregate.js";
import { makeSignal } from "../../../fixtures/signals.js";

describe("aggregateFailureModes", () => {
  it("buckets by (repo, model, kind, step) and computes fail rate", () => {
    const signals = [
      ...Array.from({ length: 8 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail", step: "types" })),
      ...Array.from({ length: 2 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass", step: "types" })),
    ];
    const modes = aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 });
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ step: "types", total: 10, failures: 8, failRate: 0.8 });
  });

  it("counts both fail and exhausted as failures", () => {
    const signals = [
      ...Array.from({ length: 5 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" })),
      ...Array.from({ length: 5 }, (_, i) => makeSignal({ id: `e${i}`, outcome: "exhausted" })),
    ];
    const modes = aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 });
    expect(modes[0]!.failures).toBe(10);
  });

  it("gates out buckets below the sample-size floor", () => {
    const signals = Array.from({ length: 5 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" }));
    expect(aggregateFailureModes(signals, { minSamples: 10 })).toHaveLength(0);
  });

  it("gates out buckets below the fail-rate floor", () => {
    const signals = [
      ...Array.from({ length: 1 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail" })),
      ...Array.from({ length: 19 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass" })),
    ];
    expect(aggregateFailureModes(signals, { minFailRate: 0.2, minSamples: 10 })).toHaveLength(0);
  });

  it("sorts by fail rate descending", () => {
    const a = Array.from({ length: 10 }, (_, i) => makeSignal({ id: `a${i}`, step: "lint", outcome: i < 3 ? "fail" : "pass" }));
    const b = Array.from({ length: 10 }, (_, i) => makeSignal({ id: `b${i}`, step: "types", outcome: i < 9 ? "fail" : "pass" }));
    const modes = aggregateFailureModes([...a, ...b], { minFailRate: 0.2, minSamples: 10 });
    expect(modes.map((m) => m.step)).toEqual(["types", "lint"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/signals/aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/signals/aggregate.ts
/**
 * Pure roll-up of signals into threshold-gated failure modes. No I/O, no LLM
 * (LLM polish lives in the UI / `nlm improve` layer only — correction C). The
 * caller passes a pre-filtered, pre-windowed slice from the SignalStore.
 */

import type { Signal } from "@shared/types.js";

export interface FailureMode {
  readonly repo: string;
  readonly model: string;
  readonly kind: string;
  readonly step: string | null;
  readonly total: number;
  readonly failures: number;
  readonly failRate: number;
  readonly lastTs: string;
}

export interface AggregateOptions {
  readonly minFailRate?: number;
  readonly minSamples?: number;
}

const FAILING: ReadonlySet<string> = new Set(["fail", "exhausted"]);

export function aggregateFailureModes(
  signals: ReadonlyArray<Signal>,
  opts: AggregateOptions = {},
): ReadonlyArray<FailureMode> {
  const minFailRate = opts.minFailRate ?? 0.2;
  const minSamples = opts.minSamples ?? 10;

  type Bucket = { repo: string; model: string; kind: string; step: string | null; total: number; failures: number; lastTs: string };
  const buckets = new Map<string, Bucket>();

  for (const s of signals) {
    const key = [s.repo, s.model, s.kind, s.step ?? ""].join(" ");
    let b = buckets.get(key);
    if (!b) {
      b = { repo: s.repo, model: s.model, kind: s.kind, step: s.step, total: 0, failures: 0, lastTs: s.ts };
      buckets.set(key, b);
    }
    b.total += 1;
    if (FAILING.has(s.outcome)) b.failures += 1;
    if (s.ts > b.lastTs) b.lastTs = s.ts;
  }

  const modes: FailureMode[] = [];
  for (const b of buckets.values()) {
    const failRate = b.total === 0 ? 0 : b.failures / b.total;
    if (b.total >= minSamples && failRate >= minFailRate) {
      modes.push({ repo: b.repo, model: b.model, kind: b.kind, step: b.step, total: b.total, failures: b.failures, failRate, lastTs: b.lastTs });
    }
  }
  modes.sort((a, b) => b.failRate - a.failRate || b.total - a.total);
  return modes;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/signals/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/signals/aggregate.ts tests/unit/core/signals/aggregate.test.ts
git commit -m "feat(signals): add pure failure-mode aggregator"
```

---

## Layer 4 — Recall (close the loop)

### Task 15: buildFailureModeBlock

**Files:**
- Create: `src/core/signals/failure-mode-recall.ts`
- Test: `tests/unit/core/signals/failure-mode-recall.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/failure-mode-recall.test.ts
import { describe, expect, it } from "vitest";
import { buildFailureModeBlock, renderFailureMode } from "../../../../src/core/signals/failure-mode-recall.js";
import type { SignalStore } from "../../../../src/ports/signal-store.js";
import { makeSignal } from "../../../fixtures/signals.js";

function storeOf(signals = makeSignals()): SignalStore {
  return {
    async insert() {}, async insertMany() {}, async countSince() { return 0; }, async pruneOlderThan() { return 0; },
    async listForAggregation() { return signals; },
  };
}
function makeSignals() {
  return [
    ...Array.from({ length: 8 }, (_, i) => makeSignal({ id: `f${i}`, outcome: "fail", step: "types", model: "qwen3-coder", repo: "/repo/x" })),
    ...Array.from({ length: 2 }, (_, i) => makeSignal({ id: `p${i}`, outcome: "pass", step: "types", model: "qwen3-coder", repo: "/repo/x" })),
  ];
}
const NOW = () => new Date("2026-06-09T12:00:00.000Z");

describe("buildFailureModeBlock", () => {
  it("renders a block when a mode crosses threshold", async () => {
    const block = await buildFailureModeBlock(storeOf(), { installScope: "i", repo: "/repo/x", now: NOW });
    expect(block).toContain("Known failure modes");
    expect(block).toContain("types");
    expect(block).toContain("80%");
    expect(block).toContain("n=10");
  });

  it("returns empty string when nothing crosses threshold", async () => {
    const block = await buildFailureModeBlock(storeOf([]), { installScope: "i", repo: "/repo/x", now: NOW });
    expect(block).toBe("");
  });

  it("caps the number of modes", async () => {
    const many = [];
    for (const step of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 10; i++) many.push(makeSignal({ id: `${step}${i}`, outcome: "fail", step }));
    }
    const block = await buildFailureModeBlock(storeOf(many), { installScope: "i", repo: "/repo/x", now: NOW }, { maxModes: 2 });
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("renderFailureMode produces a single deterministic line", () => {
    const line = renderFailureMode({ repo: "/r", model: "m", kind: "gate", step: "types", total: 120, failures: 46, failRate: 0.38, lastTs: "x" }, 14);
    expect(line).toBe("- m failed `types` on 38% of gate checks in this repo (n=120, 14d).");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/signals/failure-mode-recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/signals/failure-mode-recall.ts
/**
 * Build the deterministic "Known failure modes" block injected at session
 * start. No LLM on this path — it runs inside the SessionStart hook's ~2s
 * budget (correction C). Threshold-gated via the aggregator.
 */

import type { SignalStore } from "@ports/signal-store.js";
import { aggregateFailureModes, type AggregateOptions, type FailureMode } from "./aggregate.js";

export interface FailureModeRecallOptions extends AggregateOptions {
  readonly windowDays?: number;
  readonly maxModes?: number;
}

export function renderFailureMode(mode: FailureMode, windowDays: number): string {
  const pct = Math.round(mode.failRate * 100);
  const where = mode.step ? `\`${mode.step}\`` : mode.kind;
  return `- ${mode.model} failed ${where} on ${pct}% of ${mode.kind} checks in this repo (n=${mode.total}, ${windowDays}d).`;
}

export async function buildFailureModeBlock(
  store: SignalStore,
  args: { installScope: string; repo: string; model?: string; now?: () => Date },
  opts: FailureModeRecallOptions = {},
): Promise<string> {
  const windowDays = opts.windowDays ?? 14;
  const maxModes = opts.maxModes ?? 3;
  const now = (args.now ?? (() => new Date()))();
  const sinceTs = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const signals = await store.listForAggregation({
    installScope: args.installScope,
    repo: args.repo,
    ...(args.model ? { model: args.model } : {}),
    sinceTs,
  });

  const modes = aggregateFailureModes(signals, opts).slice(0, maxModes);
  if (modes.length === 0) return "";

  return ["## Known failure modes for this repo", ...modes.map((m) => renderFailureMode(m, windowDays))].join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/signals/failure-mode-recall.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the deferred HTTP route test (now that imports resolve)**

Run: `npx vitest run tests/unit/http/signal-routes.test.ts`
Expected: PASS (the `GET` routes' imports now resolve).

- [ ] **Step 6: Commit**

```bash
git add src/core/signals/failure-mode-recall.ts tests/unit/core/signals/failure-mode-recall.test.ts
git commit -m "feat(signals): add deterministic failure-mode recall block"
```

---

### Task 16: SessionStart hook injects the block

**Files:**
- Modify: `src/hook/session-start-hook.ts`
- Test: `tests/unit/hook/session-start-failure-modes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/hook/session-start-failure-modes.test.ts
import { describe, expect, it } from "vitest";
import { composeSessionStartOutput } from "../../../src/hook/session-start-hook.js";

describe("composeSessionStartOutput", () => {
  it("prepends the failure-mode block above the recall block", () => {
    const out = composeSessionStartOutput("## Known failure modes for this repo\n- m failed `types`...", "<recall pointer block>");
    expect(out.indexOf("Known failure modes")).toBeLessThan(out.indexOf("<recall pointer block>"));
  });

  it("returns just the recall block when no failure modes", () => {
    expect(composeSessionStartOutput("", "<recall>")).toBe("<recall>");
  });

  it("returns just the failure-mode block when no recall hits", () => {
    expect(composeSessionStartOutput("## Known failure modes\n- x", "")).toBe("## Known failure modes\n- x");
  });

  it("returns empty when both empty", () => {
    expect(composeSessionStartOutput("", "")).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/hook/session-start-failure-modes.test.ts`
Expected: FAIL — `composeSessionStartOutput` not exported.

- [ ] **Step 3: Implement composition + fetch in the hook**

In `src/hook/session-start-hook.ts`, add the pure composer (export it):

```ts
/** Join the failure-mode block (if any) above the session-recall block. */
export function composeSessionStartOutput(failureModeBlock: string, recallBlock: string): string {
  return [failureModeBlock, recallBlock].filter((s) => s.length > 0).join("\n\n");
}
```

Add a fail-open fetch helper near `recallOverHttp`:

```ts
async function fetchFailureModeBlock(repo: string): Promise<string> {
  if (!repo) return "";
  const portValue = process.env["NLM_PORT"] ?? "3940";
  const url = `http://localhost:${portValue}/api/signals/failure-modes?repo=${encodeURIComponent(repo)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: hookAuthHeaders({ "x-recall-source": "session-start-hook" }), signal: controller.signal });
    if (!res.ok) return "";
    const body = (await res.json()) as { block?: string };
    return typeof body.block === "string" ? body.block : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
```

In `main()`, after computing `out` from `runHook`, replace the final emit with:

```ts
    const out = await runHook({ conversationId, query }, { mode, recall: recallOverHttp });
    const failureModes = mode === "live" ? await fetchFailureModeBlock(workingDirectory) : "";
    const combined = composeSessionStartOutput(failureModes, out);
    if (combined) process.stdout.write(combined);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/hook/session-start-failure-modes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hook/session-start-hook.ts tests/unit/hook/session-start-failure-modes.test.ts
git commit -m "feat(signals): inject failure-mode block at Claude Code session start"
```

---

### Task 17: Wire signals into the composition root + retention prune

**Files:**
- Modify: `src/cli/nlm.ts`

- [ ] **Step 1: Import + build the store in `buildStack`**

In `src/cli/nlm.ts`, add imports:

```ts
import { installScope } from "../core/signals/install-scope.js";
```

In `buildStack()` (the function returning `{ storage, store, facts, ... }`), after `const facts = storage.facts;` add:

```ts
  const signals = storage.signals;
  const scope = installScope();
```

Add `signals` and `scope` to the returned object:

```ts
  return { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier };
```

- [ ] **Step 2: Pass them to `createApp` in the `start` action**

Destructure them: `const { storage, store, facts, signals, scope, sources, providers, recall, factRecall, embedder, classifier } = await buildStack();`

Add to the `createApp({ ... })` deps object:

```ts
      signalStore: signals,
      installScope: scope,
```

- [ ] **Step 3: Pass them to the `ScanScheduler`**

In the `new ScanScheduler({ ... })` construction, add:

```ts
          signalStore: signals,
          installScope: scope,
```

- [ ] **Step 4: Add the retention prune to the scheduler boot**

The spec calls for a 90-day prune on the existing scheduler cadence. Add, near the WAL `checkpointTimer` block in the `start` action, a prune timer:

```ts
    const SIGNAL_RETENTION_DAYS = Number.parseInt(process.env["NLM_SIGNAL_RETENTION_DAYS"] ?? "90", 10);
    const SIGNAL_PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // every 6h
    const signalPruneTimer = setInterval(() => {
      const cutoff = new Date(Date.now() - SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
      void signals.pruneOlderThan(cutoff).catch(() => { /* prune is best-effort */ });
    }, SIGNAL_PRUNE_INTERVAL_MS);
    signalPruneTimer.unref();
```

- [ ] **Step 5: Typecheck + build + full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS across the suite.

- [ ] **Step 6: Manual smoke (optional but recommended)**

```bash
npm run build:server
node dist/cli/nlm.js start --no-scheduler &
sleep 2
curl -s -X POST localhost:3940/api/signal -H 'content-type: application/json' \
  -d '{"kind":"gate","producer":"qg","outcome":"fail","model":"m","repo":"/repo/x","detail":{"step":"types"},"ts":"2026-06-09T18:00:00.000Z"}'
# expect: {"id":"sig_...","status":"accepted"}
curl -s 'localhost:3940/api/signals/stats?days=30'
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/nlm.ts
git commit -m "feat(signals): wire signal store, recall, and retention prune into daemon"
```

---

## Layer 5 — UI + report

### Task 18: nlm improve CLI report

**Files:**
- Modify: `src/cli/nlm.ts`
- Test: `tests/unit/core/signals/recommend.test.ts`
- Create: `src/core/signals/recommend.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/signals/recommend.test.ts
import { describe, expect, it } from "vitest";
import { recommendActions } from "../../../../src/core/signals/recommend.js";
import type { FailureMode } from "../../../../src/core/signals/aggregate.js";

const mode = (o: Partial<FailureMode>): FailureMode => ({ repo: "/r", model: "m", kind: "gate", step: "types", total: 100, failures: 60, failRate: 0.6, lastTs: "x", ...o });

describe("recommendActions", () => {
  it("recommends a model swap when fail rate exceeds the swap threshold", () => {
    const recs = recommendActions([mode({ failRate: 0.6 })], { swapThreshold: 0.5 });
    expect(recs.some((r) => r.kind === "model-swap")).toBe(true);
  });

  it("recommends an AGENTS.md rule for the most common step", () => {
    const recs = recommendActions([mode({ step: "types", failRate: 0.3 })], { swapThreshold: 0.5 });
    expect(recs.some((r) => r.kind === "agents-rule" && r.text.includes("types"))).toBe(true);
  });

  it("returns nothing for an empty input", () => {
    expect(recommendActions([], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/core/signals/recommend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the recommender**

```ts
// src/core/signals/recommend.ts
/**
 * Turn failure modes into human-actionable recommendations. Surface + recommend
 * only — nothing here mutates config or swaps models (v1 scope guardrail).
 */

import type { FailureMode } from "./aggregate.js";

export interface Recommendation {
  readonly kind: "model-swap" | "agents-rule";
  readonly text: string;
}

export interface RecommendOptions {
  readonly swapThreshold?: number;
}

export function recommendActions(modes: ReadonlyArray<FailureMode>, opts: RecommendOptions = {}): ReadonlyArray<Recommendation> {
  const swapThreshold = opts.swapThreshold ?? 0.5;
  const recs: Recommendation[] = [];
  for (const m of modes) {
    if (m.failRate >= swapThreshold) {
      recs.push({
        kind: "model-swap",
        text: `Consider a different default model for ${m.repo}: ${m.model} fails ${Math.round(m.failRate * 100)}% of ${m.kind} checks (n=${m.total}).`,
      });
    }
    if (m.step) {
      recs.push({
        kind: "agents-rule",
        text: `Propose an AGENTS.md rule in ${m.repo} addressing the "${m.step}" step (${m.model} fails it ${Math.round(m.failRate * 100)}% of the time).`,
      });
    }
  }
  return recs;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/core/signals/recommend.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `nlm improve` command**

In `src/cli/nlm.ts`, add a command (near the other `program.command(...)` definitions):

```ts
program
  .command("improve")
  .description("Report known failure modes + recommended actions from captured signals")
  .option("--days <n>", "trailing window in days (default 14)", (v) => Number.parseInt(v, 10), 14)
  .action(async (opts) => {
    const storage = await buildStorage(dbPath());
    const scope = installScope();
    const sinceTs = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    const rows = await storage.signals.listForAggregation({ installScope: scope, sinceTs });
    const { aggregateFailureModes } = await import("../core/signals/aggregate.js");
    const { recommendActions } = await import("../core/signals/recommend.js");
    const modes = aggregateFailureModes(rows);
    if (modes.length === 0) {
      console.error(`nlm improve: no failure modes above threshold in the last ${opts.days}d (${rows.length} signals).`);
      await storage.close();
      return;
    }
    console.error(`Failure modes (last ${opts.days}d, ${rows.length} signals):`);
    for (const m of modes) {
      console.error(`  ${m.model} ${m.repo} ${m.kind}/${m.step ?? "-"}: ${Math.round(m.failRate * 100)}% of ${m.total}`);
    }
    console.error("\nRecommendations:");
    for (const r of recommendActions(modes)) console.error(`  [${r.kind}] ${r.text}`);
    await storage.close();
  });
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/core/signals/recommend.ts src/cli/nlm.ts tests/unit/core/signals/recommend.test.ts
git commit -m "feat(signals): add nlm improve report"
```

---

### Task 19: Recall.tsx failure-modes panel

**Files:**
- Modify: `src/ui/pages/Recall.tsx`
- Reference (read first): `src/ui/components/README.md`, `src/ui/lib/api.ts`, current `src/ui/pages/Recall.tsx`

- [ ] **Step 1: Read the design system + api helper**

Read `src/ui/components/README.md` (canonical components, table styling, status indicators), `src/ui/lib/api.ts` (the fetch wrapper + auth), and the existing `Recall.tsx` structure. The panel must follow the existing fetch hook pattern and table/card classes already in use; do not introduce new component primitives (rule-of-three).

- [ ] **Step 2: Add a typed fetch for the stats endpoint**

The endpoint `GET /api/signals/stats?days=14` returns `{ days, total, modes: FailureMode[] }`. Using the existing api helper in `src/ui/lib/api.ts`, add a function mirroring the file's established style, e.g.:

```ts
export interface UiFailureMode {
  repo: string; model: string; kind: string; step: string | null;
  total: number; failures: number; failRate: number; lastTs: string;
}
export async function fetchFailureModeStats(days = 14): Promise<{ days: number; total: number; modes: UiFailureMode[] }> {
  return apiGet(`/api/signals/stats?days=${days}`); // use the file's existing apiGet/request helper name
}
```

(Match the real helper name in `api.ts`. If it exports `request`/`getJson` instead of `apiGet`, use that.)

- [ ] **Step 3: Add the panel to Recall.tsx**

Add a "Failure modes" section using the existing table styling from the design system. It renders one row per mode: `model`, `repo`, `kind/step`, a fail-rate badge (use the existing status-indicator class — red when `failRate >= 0.5`, amber otherwise), `n=total`, and `lastTs` formatted with the existing `format.ts` date helper. Empty state uses the existing empty-state pattern with copy: "No failure modes captured yet." No emojis; no em dashes.

Concrete structure (adapt class names to those in `components/README.md`):

```tsx
function FailureModesPanel() {
  const [data, setData] = useState<{ modes: UiFailureMode[]; total: number } | null>(null);
  useEffect(() => { fetchFailureModeStats(14).then(setData).catch(() => setData({ modes: [], total: 0 })); }, []);
  if (!data) return null;
  if (data.modes.length === 0) {
    return <div className="empty-state">No failure modes captured yet.</div>; // match real empty-state class
  }
  return (
    <section>
      <h2>Failure modes (14d)</h2>
      <table className="data-table">{/* match real table class */}
        <thead><tr><th>Model</th><th>Repo</th><th>Check</th><th>Fail rate</th><th>n</th><th>Last seen</th></tr></thead>
        <tbody>
          {data.modes.map((m, i) => (
            <tr key={i}>
              <td>{m.model}</td>
              <td>{m.repo}</td>
              <td>{m.kind}{m.step ? ` / ${m.step}` : ""}</td>
              <td><span className={m.failRate >= 0.5 ? "status-error" : "status-warn"}>{Math.round(m.failRate * 100)}%</span></td>
              <td>{m.total}</td>
              <td>{formatDate(m.lastTs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

Mount `<FailureModesPanel />` within the existing `Recall` page component layout.

- [ ] **Step 4: Build the UI to verify it compiles**

Run: `npm run build:ui`
Expected: Vite build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/Recall.tsx src/ui/lib/api.ts
git commit -m "feat(signals): add failure-modes panel to Recall UI"
```

---

## Layer 6 — Reference producer + consumer (pi-sandbox)

> These tasks are in the **pi-sandbox** repo (`~/Documents/Coding Projects/pi-sandbox`), not nlm-memory. Commit there separately.

### Task 20: quality-gate emits nlm.signal

**Files:**
- Modify: `extensions/quality-gate/index.ts`

- [ ] **Step 1: Add the emit helper**

In `extensions/quality-gate/index.ts`, add near the top-level helpers:

```ts
const NLM_URL = process.env.NLM_URL ?? 'http://localhost:3940';

function repoName(cwd: string): string {
  try { return git(cwd, 'rev-parse --show-toplevel').trim() || cwd; } catch { return cwd; }
}

// Fail-open: a dead daemon must never break the gate.
function emitSignal(pi: any, payload: Record<string, unknown>): void {
  try { pi.appendCustomEntry?.('nlm.signal', payload); } catch { /* ignore */ }
  void fetch(`${NLM_URL}/api/signal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.NLM_MCP_TOKEN ? { authorization: `Bearer ${process.env.NLM_MCP_TOKEN}` } : {}) },
    body: JSON.stringify(payload),
  }).catch(() => { /* ignore */ });
}
```

- [ ] **Step 2: Emit per-step inside runPipelines**

`runPipelines` is a free function without the `pi` handle. Thread an optional emitter in. Change its signature and the per-step `debug(...)` site:

```ts
export function runPipelines(
  cwd: string, cfg: Config, changed: string[], strict: boolean,
  emit?: (step: string, ok: boolean, files: string[]) => void,
): string | null {
  // ...inside the step loop, after the existing debug(...) line:
      debug(`step="${step.name}" ok=${ok} files=${files.length}`);
      emit?.(step.name, ok, files);
      if (!ok) {
        return `Step "${step.name}" on ${files.join(', ')}:\n${cap(output, maxChars)}`;
      }
```

- [ ] **Step 3: Wire the emitter + exhausted path in `agent_end`**

In the `pi.on('agent_end', ...)` handler, build the emitter and pass it; emit the exhausted signal on the retry-cap branch:

```ts
    const model = ctx?.model?.id ?? 'unknown';
    const repo = repoName(cwd);
    const sessionId = ctx?.sessionId ?? ctx?.session?.id ?? null;
    const stepEmit = (step: string, ok: boolean, files: string[]) =>
      emitSignal(pi, {
        v: 1, kind: 'gate', producer: 'quality-gate',
        outcome: ok ? 'pass' : 'fail', model, repo,
        detail: { step, files, attempt: (retries.get(cwd) ?? 0) + 1 },
        session: sessionId, ts: new Date().toISOString(),
      });

    const failure = runPipelines(cwd, cfg, changed, isStrict(ctx?.model), stepEmit) ?? checkTestPresence(changed, cfg);
    if (!failure) { retries.set(cwd, 0); return; }

    const n = (retries.get(cwd) ?? 0) + 1;
    retries.set(cwd, n);

    if (n > MAX_RETRIES) {
      retries.set(cwd, 0);
      emitSignal(pi, {
        v: 1, kind: 'gate', producer: 'quality-gate', outcome: 'exhausted',
        model, repo, detail: { failure: failure.slice(0, 200) }, session: sessionId, ts: new Date().toISOString(),
      });
      ctx.ui?.notify?.(`Quality gate still failing after ${MAX_RETRIES} fix attempts - left for human review. ${failure}`, 'error');
      return;
    }
```

(Note: the existing `notify` string used an em dash; replace it with a hyphen per voice rules while you are in this line.)

- [ ] **Step 4: Run the extension's own test**

Run: `cd ~/Documents/Coding\ Projects/pi-sandbox && node extensions/quality-gate/test.mjs`
Expected: existing tests pass (the new `emit` param is optional, so `runPipelines` call sites in the test that omit it still work).

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Coding\ Projects/pi-sandbox
git add extensions/quality-gate/index.ts
git commit -m "feat(quality-gate): emit nlm.signal per step and on exhaustion"
```

---

### Task 21: Pi failure-mode consumer extension

**Files:**
- Create: `extensions/nlm-failure-modes/index.ts`
- Create: `extensions/nlm-failure-modes/package.json`

- [ ] **Step 1: Write the package.json**

```json
{
  "name": "pi-nlm-failure-modes",
  "version": "1.0.0",
  "description": "Inject NLM known-failure-modes for this repo+model at session start",
  "main": "index.ts"
}
```

- [ ] **Step 2: Write the consumer (mirrors whtnxt-tasks injection)**

```ts
// extensions/nlm-failure-modes/index.ts
/**
 * Fetches NLM's known failure modes for the current repo + model and injects
 * them as session context at agent start. Fail-open: a dead daemon yields no
 * context and never blocks the agent.
 */
import { execSync } from 'child_process';

const NLM_URL = process.env.NLM_URL ?? 'http://localhost:3940';

function repoName(cwd: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch { return cwd; }
}

export default function nlmFailureModes(pi: any) {
  let injected = false;
  pi.on('before_agent_start', async (_event: any, ctx: any) => {
    if (injected) return;
    injected = true;
    const cwd: string = ctx?.cwd ?? process.cwd();
    const repo = repoName(cwd);
    const model = ctx?.model?.id ?? '';
    const url = `${NLM_URL}/api/signals/failure-modes?repo=${encodeURIComponent(repo)}${model ? `&model=${encodeURIComponent(model)}` : ''}`;
    let block = '';
    try {
      const res = await fetch(url, { headers: process.env.NLM_MCP_TOKEN ? { authorization: `Bearer ${process.env.NLM_MCP_TOKEN}` } : {} });
      if (res.ok) { const body = await res.json() as { block?: string }; block = typeof body.block === 'string' ? body.block : ''; }
    } catch { return; }
    if (!block) return;
    return { message: { customType: 'nlm-failure-modes', content: block, display: false } };
  });
}
```

- [ ] **Step 3: Manual smoke**

With the daemon running and at least 10 fail signals for a repo/model in the last 14 days, launch Pi in that repo and confirm the injected context appears (or check the session jsonl for a `custom_message` with `customType: "nlm-failure-modes"`).

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Coding\ Projects/pi-sandbox
git add extensions/nlm-failure-modes/
git commit -m "feat(nlm-failure-modes): inject NLM failure modes at Pi session start"
```

---

### Task 22: Document the integration

**Files:**
- Modify: `~/Documents/Coding Projects/nlm-memory/README.md` (add a "Self-improvement signals" section)

- [ ] **Step 1: Add the README section**

Document: the `nlm.signal` contract (payload schema, `v:1`), both transports (HTTP `POST /api/signal` + Pi `appendCustomEntry`), the two reference extensions as the example producer/consumer, `NLM_SIGNALS_ENABLED` / `NLM_SIGNAL_RETENTION_DAYS` env vars, that signals are local-only and stamped per-install, and the `nlm improve` command. Show the ~10-line producer snippet from Task 20 as the integration example.

- [ ] **Step 2: Commit**

```bash
cd ~/Documents/Coding\ Projects/nlm-memory
git add README.md
git commit -m "docs(signals): document the nlm.signal contract + integration"
```

---

## Final verification

- [ ] **Step 1: Full suite + typecheck + build (nlm-memory)**

Run: `cd ~/Documents/Coding\ Projects/nlm-memory && npm run typecheck && npm test && npm run build`
Expected: all green; dist builds.

- [ ] **Step 2: Session-protocol close-out (nlm-memory)**

Append a `logs/CHANGELOG/CHANGELOG.md` entry (Changes / Decisions / State counts / Next priorities) per the repo's session protocol; trim to 10 entries if needed. Update `.claude/properties/nlm-memory.yaml` if surface counts changed. Then commit:

```bash
git add logs/CHANGELOG/CHANGELOG.md
git commit -m "chore: changelog for agent self-improvement signals"
```

- [ ] **Step 3: Wiki ingest (if a reusable lesson emerged)**

If the build surfaced a tool/framework lesson (e.g. a Pi `appendCustomEntry` quirk), add it to `Whtnxt Agent Vault/Operations/Tool Lessons/` per the learning-layer protocol. Skip if routine.

---

## Self-Review

**Spec coverage:**
- Signal contract + `v:1` + two transports → Tasks 10, 11, 12.
- Distinct append-only store, pg+sqlite parity, no FK → Tasks 1-8.
- Server-stamped per-install scope → Tasks 9, 10, 17.
- Idempotent re-ingest (correction A) → deterministic id Task 10 + `INSERT OR IGNORE`/`ON CONFLICT` Tasks 4, 7 + dedupe test Task 5.
- Drain-before-classify, fail-open (correction B) → Task 13.
- Aggregate-on-read + threshold gate → Task 14.
- LLM off the hot path (correction C); deterministic block → Tasks 15, 16; LLM-free recommend in Task 18.
- HTTP auth parity (correction D) → Task 11 (rides `/api/*` gate), producer bearer Task 20.
- Compose at `main()` (correction E) → Task 16.
- Both harnesses → Task 16 (Claude Code) + Task 21 (Pi).
- Per-step producer emit (correction F) → Task 20.
- Retention 90d prune → Task 17.
- UI panel + `nlm improve` → Tasks 18, 19.
- `NLM_SIGNALS_ENABLED` → Task 11; documented Task 22.
- Out of scope (no auto-act) honored: `recommend` only emits text.

**Type consistency:** `Signal`/`SignalInput` (Task 1) used identically in store (4,7), ingest (10), aggregate (14), recall (15). `FailureMode` defined in Task 14, consumed unchanged in 15, 18, 19. `SignalStore` methods (`insert`/`insertMany`/`listForAggregation`/`countSince`/`pruneOlderThan`) defined in Task 2 and implemented with the same signatures in 4 and 7. `buildFailureModeBlock`/`aggregateFailureModes` imported in `app.ts` (Task 11) are defined in 15/14 — execution note flags the ordering.

**Placeholder scan:** No TBD/TODO. The only adapt-to-reality step is Task 19 (UI class names follow `components/README.md`); the data contract is fully specified and the JSX is concrete. Acceptable because the canonical design-system doc owns the visual tokens.
