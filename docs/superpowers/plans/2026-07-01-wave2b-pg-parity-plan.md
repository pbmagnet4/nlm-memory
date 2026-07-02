# Wave 2b: PG Parity Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining sqlite/pg behavior gaps so a Postgres deployment is production-equivalent: action overlay applied on pg reads, migrations applied automatically, the workstream store contract-tested on both backends, keyword search semantics unified, and the I7 ghost-embedding detector running on the scheduled watchdog cadence.

**Architecture:** Same single-source pattern as Wave 2a: extract the pure overlay reducer so both adapters share one projection; port the sqlite version-gated migration runner shape to pg; contract-ify workstream store tests the way fact-store already is.

**Tech Stack:** TypeScript ESM, pg Pool/PoolClient, better-sqlite3, Vitest.

## Global Constraints

- pg tests are env-gated on `NLM_PG_TEST_URL` via `describe.skipIf`; they run ONLY via the serial pass `npm run test:pg` (never a parallel multi-file vitest invocation against pg).
- Local pg: `docker run --rm -d --name nlm-pg-test -e POSTGRES_USER=nlm_test -e POSTGRES_PASSWORD=nlm_test -e POSTGRES_DB=nlm_test -p 5432:5432 pgvector/pgvector:pg16`; `export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"`.
- Full gate after every task: `npm run typecheck` clean + `npm test` green (tolerated: the pre-existing cli-work-digest subprocess flake) + `npm run test:pg` zero failures.
- No new dependencies. No em dashes in ANY text including test names, comments, and commit messages. No comments narrating changes; comments only for non-obvious invariants. Never write a literal NUL byte in source; use the escape sequence.
- Test seeding goes through production write paths (insertSession with factSink, real store methods), never insertSessionForTest, unless seeding a corrupt state production cannot produce (integrity tests).
- Commit style: `fix(pg): ...` / `feat(pg): ...` / `test(pg): ...`, one commit per task.

---

### Task 1: PG reads apply the action overlay (C-6)

PG HTTP endpoints accept action writes (`writeActionsBatchPg` in `src/core/actions/actions-log.ts:137`, wired at `src/http/app.ts:1195-1213`), but `PgSessionStore` reads never load or apply the overlay, so a resolved or promoted open question resurfaces forever. SQLite applies the overlay at read time via `loadActionOverlay` (`src/core/actions/overlay.ts:63`) inside its read methods.

**Files:**
- Modify: `src/core/actions/overlay.ts` (extract pure reducer)
- Modify: `src/core/storage/pg-session-store.ts` (load + apply overlay in read paths)
- Test: `tests/integration/pg-action-overlay.pg.test.ts` (new)
- Reference (read, do not modify): how `sqlite-session-store.ts` applies the overlay in its read methods (search for `loadActionOverlay` call sites and the projection logic around lines 556, 585, 611, 631, 1043-1063)

**Interfaces:**
- Produces: `export function reduceActionRows(rows: ReadonlyArray<ActionRow>): ActionOverlay` in overlay.ts (the existing `ActionRow` interface moves to exported); `loadActionOverlay(db)` becomes query + delegate to the reducer, byte-identical behavior. New `export async function loadActionOverlayPg(pool: Pool): Promise<ActionOverlay>` running the same SELECT (`SELECT kind, subject_type, subject_id, payload FROM actions WHERE reverted_by IS NULL ORDER BY id`) through pg and delegating to the same reducer. PG has no `sqlite_master` probe; the actions table always exists on pg (created by 001_initial.sql), so the pg loader skips the existence check.

- [ ] **Step 1: Write the failing test**

`tests/integration/pg-action-overlay.pg.test.ts`, copying the harness shape (env-gate, MIGRATIONS_DIR, TRUNCATE, setup/teardown) from `tests/integration/fact-store.pg.test.ts`. Core scenario:

```typescript
it("resolve_open action hides the open question from pg session reads", async () => {
  // Seed a session through production insertSession with one open question.
  // Compute its stable id via openQuestionId(sessionId, text) from @core/actions/overlay.js.
  // Write a resolve_open action via writeActionsBatchPg.
  // Read the session back via storage.sessions.getByIds([id]) and assert the
  // open question is ABSENT from session.open (mirroring sqlite behavior).
});

it("retire_entity action hides the entity from pg session reads", async () => {
  // Same shape: seed session with entity, write retire_entity action,
  // assert the entity is absent from the read-back session's entities.
});

it("sessions read identically with an empty actions table", async () => {
  // No actions: read-back equals seeded content (overlay no-op guard).
});
```

Before writing assertions, READ how sqlite's read path projects each overlay field onto the Session object (resolvedOpens filter on `open`, retiredEntities filter on `entities`, etc.) and assert the SAME projection. If sqlite applies a projection this test does not cover (renames, promoted opens as decisions), add one assertion for promoted opens as well.

- [ ] **Step 2: Run to verify it fails**

Run: `NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test" npx vitest run tests/integration/pg-action-overlay.pg.test.ts --no-file-parallelism`
Expected: FAIL (open question still present after resolve_open).

- [ ] **Step 3: Extract the reducer and add the pg loader**

In `overlay.ts`: export the `ActionRow` interface; move the entire row-reduction loop (currently overlay.ts:95-139 plus the overlay literal construction) into `export function reduceActionRows(rows: ReadonlyArray<ActionRow>): ActionOverlay`; `loadActionOverlay(db)` keeps the sqlite_master probe and the SELECT, then returns `reduceActionRows(rows)`. Add:

```typescript
export async function loadActionOverlayPg(pool: Pool): Promise<ActionOverlay> {
  const result = await pool.query<ActionRow>(
    `SELECT kind, subject_type, subject_id, payload
     FROM actions
     WHERE reverted_by IS NULL
     ORDER BY id`,
  );
  return reduceActionRows(result.rows);
}
```

with `import type { Pool } from "pg";` (type-only import keeps the module loadable without pg installed at runtime for sqlite-only users; verify the existing build treats pg as a regular dependency before worrying further).

- [ ] **Step 4: Apply the overlay in PgSessionStore reads**

Mirror sqlite exactly: every read method that returns Session objects (`list` if it still exists, `getById`, `getByIds`, `listByDateRange`) loads the overlay once per call (`await loadActionOverlayPg(this.pool)`) and applies the same projection sqlite's rowToSession path applies. Factor the projection into a small shared pure function IF sqlite's version is extractable without touching its transaction internals; otherwise implement the pg projection to match sqlite's semantics field-for-field and note the duplication for the overlay-cache follow-up (O-1 covers caching later).

- [ ] **Step 5: Verify green, full gate, commit**

Run the new test file, then the three-part gate.

```bash
git add src/core/actions/overlay.ts src/core/storage/pg-session-store.ts tests/integration/pg-action-overlay.pg.test.ts
git commit -m "fix(pg): apply action overlay on pg session reads (accepted writes now project)"
```

---

### Task 2: Version-gated pg migration runner (I-7)

`PgStorage.init` (`src/core/storage/pg-storage.ts:61-64`) applies only `001_initial.sql`; `migrations/pg/019_split_replaces.sql` and `migrations/pg/025_workstreams.sql` self-describe as manual-operator steps. A pg user upgrading normally hard-fails on the first replaces edge or workstream bind.

**Files:**
- Create: `src/core/storage/pg-migrate.ts`
- Modify: `src/core/storage/pg-storage.ts` (init calls the runner)
- Modify: `migrations/pg/019_split_replaces.sql`, `migrations/pg/025_workstreams.sql` (idempotency guards only, no shape changes)
- Test: `tests/integration/pg-migrate.pg.test.ts` (new)
- Reference: `src/core/storage/migrate.ts` (the sqlite runner this ports)

**Interfaces:**
- Produces: `export async function runMigrationsPg(pool: Pool, migrationsDir: string): Promise<ReadonlyArray<AppliedMigration>>` with the same `AppliedMigration {version, name}` shape and the same `FILE_PATTERN` version-prefix convention as the sqlite runner.

- [ ] **Step 1: Read the two manual migrations and make them idempotent**

Read `019_split_replaces.sql` and `025_workstreams.sql`. Add `IF NOT EXISTS` guards to every CREATE TABLE / CREATE INDEX / ADD COLUMN (pg supports `ADD COLUMN IF NOT EXISTS`), and DO-block guards (the 001 pattern from Wave 2a) around any statement with no IF NOT EXISTS form (ADD CONSTRAINT, CHECK-constraint rebuilds, type changes). The files must be safely re-appliable on a database that already has their shape, because existing manual-operator deployments have no schema_migrations rows.

- [ ] **Step 2: Write the failing tests**

`tests/integration/pg-migrate.pg.test.ts` (env-gated, own harness; this test DROPS and recreates the schema so it must truncate/drop aggressively in beforeEach):

```typescript
it("fresh database: init applies all migrations in order and stamps schema_migrations", async () => {
  // DROP SCHEMA public CASCADE; CREATE SCHEMA public; then PgStorage.create + init().
  // Assert schema_migrations has rows for every migrations/pg/*.sql version (1, 19, 25).
  // Assert a workstream insert works (sessions.workstream_id FK live).
});

it("re-running init is a no-op", async () => {
  // init() twice; second returns zero newly-applied; row count unchanged.
});

it("existing manual-operator database: init stamps without breaking", async () => {
  // Simulate: fresh schema, apply all three files manually via pool.query,
  // leave schema_migrations absent. Then init(). Assert no throw and all
  // versions stamped (idempotent re-apply is the mechanism).
});
```

- [ ] **Step 3: Implement the runner**

Port `migrate.ts`'s shape: create `schema_migrations` if absent, read applied versions, apply pending files in version order inside a transaction per file, upsert the version row. pg differences: async pool/client instead of better-sqlite3; skip the `-- nlm:no-wrap` convention unless a pg file declares it (none do today; keep the check for parity, matching the sqlite reader). `PgStorage.init` becomes `await runMigrationsPg(this._pool, this._migrationsDir)`.

- [ ] **Step 4: Green, gate (note: other pg test harnesses apply 001 directly; verify they still pass), commit**

```bash
git add src/core/storage/pg-migrate.ts src/core/storage/pg-storage.ts migrations/pg/019_split_replaces.sql migrations/pg/025_workstreams.sql tests/integration/pg-migrate.pg.test.ts
git commit -m "feat(pg): version-gated migration runner; 019/025 idempotent and auto-applied"
```

---

### Task 3: Workstream store contract tests + transactional pg merge (I-19)

`PgWorkstreamStore` (108 lines) has zero tests; the bind flip's pg persistence has never been executed by a test. Its `merge` is also non-transactional (a retry double-counts session_count via the ON CONFLICT sum).

**Files:**
- Create: `tests/contract/workstream-store.contract.ts`
- Create: `tests/integration/workstream-store.pg.test.ts` (harness consumer)
- Modify: `tests/integration/sqlite-workstream-store.test.ts` (consume the contract; keep any sqlite-only cases inline)
- Modify: `src/core/storage/pg-workstream-store.ts` (merge gets BEGIN/COMMIT on one client)
- Test: `tests/integration/scheduler-workstream-bind.pg.test.ts` (new, pg variant)

**Interfaces:**
- Produces: `runWorkstreamStoreContract(harness)` following exactly the `fact-store.contract.ts` harness pattern (name, setup() returning Storage, teardown()).

- [ ] **Step 1: Extract the contract from the sqlite test**

Read `tests/integration/sqlite-workstream-store.test.ts` and move every backend-agnostic behavior into the contract: create/getById round-trip, findByNormalizedLabel, listAll, touchLastSession, setLabel, setStatus, merge (pointer + entity union + source cleared), upsertEntities counting, entitiesFor batching, candidatesByEntityOverlap ordering. Keep raw-SQL sqlite assertions inline in the sqlite file.

- [ ] **Step 2: Add the pg consumer and observe it fail or pass honestly**

`workstream-store.pg.test.ts` consuming the contract via the pg harness (copy from `fact-store.pg.test.ts`; TRUNCATE list must include `workstream_entities, workstreams`). Run it BEFORE the merge fix: if the merge contract case fails on pg, that is the RED for Step 3; if all green, proceed (the merge fix is still required for retry idempotency).

- [ ] **Step 3: Make pg merge transactional**

Wrap the three statements in `PgWorkstreamStore.merge` in one client BEGIN/COMMIT/ROLLBACK/release (the shape used everywhere else in the pg adapters). Remove the now-false comment about per-query style; keep the ordering comment if still accurate.

- [ ] **Step 4: PG scheduler bind variant**

`scheduler-workstream-bind.pg.test.ts`: port the flag-ON and flag-OFF cases from `tests/integration/scheduler-workstream-bind.test.ts` to the pg harness with the same stub classifier and the same exact assertions (`workstream_id === "ws_nlm_test"`, workstream count === 1). Seeding and scheduler wiring mirror the sqlite file; storage handles come from PgStorage.

- [ ] **Step 5: Green, gate, commit**

```bash
git add tests/contract/workstream-store.contract.ts tests/integration/workstream-store.pg.test.ts tests/integration/sqlite-workstream-store.test.ts tests/integration/scheduler-workstream-bind.pg.test.ts src/core/storage/pg-workstream-store.ts
git commit -m "test(pg): workstream store contract on both backends; transactional pg merge; pg bind variant"
```

---

### Task 4: keywordSearch semantics parity (I-9)

sqlite tokenizes and OR-joins quoted terms into FTS5 MATCH (`sqlite-session-store.ts` toMatchExpression: `terms.map(quote).join(" OR ")` over `tokenize(query)`); pg uses `websearch_to_tsquery('english', $1)` which is implicit AND over the raw string. A multi-term query that partially matches returns hits on sqlite and zero rows on pg, so hybrid recall quality silently differs per backend.

**Files:**
- Modify: `src/core/storage/pg-session-store.ts` (keywordSearch)
- Test: `tests/integration/keyword-search-parity.pg.test.ts` (new)

**Interfaces:**
- Consumes: `tokenize` from `@core/recall/tokenize.js` (the same tokenizer sqlite uses).

- [ ] **Step 1: Write the failing test**

```typescript
it("partial-match multi-term query returns the session (OR semantics, matching sqlite)", async () => {
  // Seed one session (production insertSession) whose body contains "pgvector"
  // but NOT "kubernetes". Query: "pgvector kubernetes deployment".
  // websearch AND semantics returns zero rows; OR semantics returns the session.
  // Assert keywordSearch returns the session id with score > 0.
});

it("no indexable tokens returns empty", async () => {
  // Query of stopwords/punctuation only; assert [] and no SQL error.
});
```

- [ ] **Step 2: RED, then fix**

Replace the pg tsquery construction: tokenize the query with the shared `tokenize()`; if zero terms return []; build `to_tsquery('english', terms.join(" | "))` with each term passed through a sanitizer that strips tsquery operator characters (`& | ! ( ) : * ' <`) from the token (tokenize likely already yields clean word tokens; the sanitizer is the guard). Keep `ts_rank_cd` scoring and the status filter unchanged. Parameterize the joined expression as one bind value: `to_tsquery('english', $1)`.

- [ ] **Step 3: Green, gate, commit**

```bash
git add src/core/storage/pg-session-store.ts tests/integration/keyword-search-parity.pg.test.ts
git commit -m "fix(pg): keywordSearch uses shared tokenizer with OR semantics, matching sqlite"
```

---

### Task 5: I7 joins the cheap watchdog subset

The scheduled watchdog runs the cheap check subset (I1+I2+I6, see `runCheapChecksOnSqlite` / `runCheapChecksOnPg` in `src/core/integrity/check-invariants.ts` around line 375-430); I7, the standing detector for this branch-family's headline corruption class, only runs on full doctor invocations.

**Files:**
- Modify: `src/core/integrity/check-invariants.ts`
- Test: extend `tests/integration/check-invariants.test.ts` and `check-invariants.pg.test.ts`

- [ ] **Step 1: Failing tests** asserting the cheap-check runners report I7 violations (seed one superseded ghost, run the CHEAP variant, assert I7 present) on both backends.

- [ ] **Step 2: Add I7 to both cheap runners**, reusing the existing SQL_I7 constants and violation format. The I7 detection is a LEFT JOIN over the embeddings table (about 13 thousand rows in the reference corpus) with no full-body scans; that is within the cheap budget. State this in one comment line only if the cheap subset has a documented inclusion criterion; otherwise no comment.

- [ ] **Step 3: Green, gate, commit**

```bash
git add src/core/integrity/check-invariants.ts tests/integration/check-invariants.test.ts tests/integration/check-invariants.pg.test.ts
git commit -m "feat(integrity): I7 ghost-embedding check joins the cheap watchdog subset"
```

---

### Task 6: retired_at returned by every fact SELECT (I-8 remaining half)

Wave 2a made every fact INSERT persist retired_at; most SELECTs on both adapters still omit the column, so `Fact.retiredAt` reads as null from getById/findCurrent/list/listForRecall/listBySession and the `f.retiredAt != null` defense gate in `fact-recall-service.ts` only works on the getByIds path that happens to select it.

**Files:**
- Modify: `src/core/storage/sqlite-fact-store.ts` (SELECT column lists around lines 76-84, 99-111, 129-139, 142-153, 194-206)
- Modify: `src/core/storage/pg-fact-store.ts` (same methods; getByIds/listBySessions already include it)
- Test: extend `tests/contract/fact-store.contract.ts`

- [ ] **Step 1: Failing contract test** inserting a fact, retiring it via `retire()`, then reading through getById with includeSuperseded-style access where the method allows reading retired rows, asserting `retiredAt` is non-null on read-back; plus a live fact asserting `retiredAt === null` (not undefined) from every read method touched.

- [ ] **Step 2: Add the column** to every fact SELECT on both adapters; rowToFact already maps it (`retired_at ?? null`).

- [ ] **Step 3: Green, gate, commit**

```bash
git add src/core/storage/sqlite-fact-store.ts src/core/storage/pg-fact-store.ts tests/contract/fact-store.contract.ts
git commit -m "fix(storage): every fact SELECT returns retired_at on both adapters"
```

---

### Task 7: pg rowToSession computes live status (parity defect found in Task 1 review)

sqlite's rowToSession returns `status: liveSessionStatus(row.transcript_path, row.status)` (sqlite-session-store.ts:1066); pg returns `status: row.status` raw (pg-session-store.ts:720 post-Task-1). A live session whose transcript is still open can project a different status on pg vs sqlite.

**Files:**
- Modify: `src/core/storage/pg-session-store.ts` (rowToSession)
- Test: extend `tests/integration/pg-action-overlay.pg.test.ts` or the session-search pg test with one status-projection case
- Reference: where `liveSessionStatus` lives and what it needs (sqlite-session-store.ts imports it; confirm it is a pure/portable helper importable from pg code without sqlite deps)

- [ ] **Step 1: Failing test** seeding a session whose transcript_path points at a fixture file that mimics a live transcript per liveSessionStatus's rules (read the helper first to learn its liveness criterion), asserting the pg read-back status matches what sqlite would compute.

- [ ] **Step 2: Wrap the status** in pg rowToSession with the same helper; if the helper is sqlite-adapter-local, move it to a shared module both adapters import (no behavior change for sqlite).

- [ ] **Step 3: Green, gate, commit**

```bash
git add src/core/storage/pg-session-store.ts tests/
git commit -m "fix(pg): rowToSession computes live session status, matching sqlite"
```

---

## Out of scope

O-1 overlay caching (both adapters, after this wave the pg cost is one extra query per read call, same class as sqlite's full scan); pg batch INSERT round-trips and ivfflat-friendly semanticSearch (O-8); `findByNormalizedLabel` full-table scan on pg (fine at current scale). The factSink ghost-embedding test nicety from the Wave 2a review is CLOSED (covered by the batchWinners fix tests).
