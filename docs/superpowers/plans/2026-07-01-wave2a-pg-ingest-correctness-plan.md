# Wave 2a: PG Ingest Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the #351-class corruption bugs still live on the Postgres path (intra-batch supersedence cycles, ghost embeddings in the ANN index) by giving pg fact-ingest a single source of truth, fixing the session-cascade embedding leak on both adapters, and making the whole class detectable via a new I7 invariant — all gated by pg tests that actually run in CI.

**Architecture:** Mirror the sqlite fix pattern (winners-map dedupe + capture-then-delete embeddings) into one shared pg helper called by every ingest path; delete the unused PgTx write-queue layer rather than fix its divergent copy; extend `check-invariants` with an I7 "embedding without live parent fact" check that would have caught the original 4,074-orphan incident.

**Tech Stack:** TypeScript ESM, `pg` Pool/PoolClient, better-sqlite3, Vitest, GitHub Actions with a `pgvector/pgvector` service container.

## Global Constraints

- pg tests are env-gated on `NLM_PG_TEST_URL` via `describe.skipIf` — keep that pattern; CI provides the env var, local runs without it still skip cleanly.
- Local pg for development: `docker run --rm -d --name nlm-pg-test -e POSTGRES_USER=nlm_test -e POSTGRES_PASSWORD=nlm_test -e POSTGRES_DB=nlm_test -p 5432:5432 pgvector/pgvector:pg16` then `export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"`.
- Full gate after every task: `npm run typecheck` clean + `npm test` green. The one tolerated failure is the pre-existing `cli-work-digest` subprocess flake (unhandled rejection); if it errors, verify its 3 tests pass in isolation.
- No new dependencies. No em dashes in any text. No comments narrating changes; comments only for non-obvious invariants, matching existing style.
- Do not touch `src/ui/**`. In `migrations/**`, ONLY Task 1's idempotency fix to `001_initial.sql` is permitted; no schema shape changes anywhere.
- Commit style: `fix(pg): ...` / `test(pg): ...` / `chore(storage): ...`, one commit per step-5 below.

---

### Task 1: Postgres service in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI runs every `*.pg.test.ts` file (they stop skipping because `NLM_PG_TEST_URL` is set). All later tasks rely on this gate.

- [ ] **Step 1: Add the service container and env var**

Replace the full contents of `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: nlm_test
          POSTGRES_PASSWORD: nlm_test
          POSTGRES_DB: nlm_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U nlm_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Test (pg, serial)
        run: npm run test:pg
        env:
          NLM_PG_TEST_URL: postgresql://nlm_test:nlm_test@localhost:5432/nlm_test

      - name: Build (server)
        run: npm run build
```

- [ ] **Step 2: Make schema apply idempotent**

The pg test harness applies `001_initial.sql` on every `setup()` call. Every statement is `IF NOT EXISTS`-guarded except the workstream FK at lines 283-285, which errors with `constraint "fk_sessions_workstream" for relation "sessions" already exists` on the second apply and fails the entire pg suite (79 tests). Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so replace lines 283-285 of `migrations/pg/001_initial.sql`:

```sql
DO $$
BEGIN
  ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_workstream
    FOREIGN KEY (workstream_id) REFERENCES workstreams(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

(keep the comment line above it; change nothing else in the file).

- [ ] **Step 3: Add the serial pg test script**

The ten pg test files share one database and TRUNCATE between tests; run in parallel they race each other (45 cross-file failures observed). They must run serially, in their own pass, with `npm test` left pg-free. Add to package.json scripts:

```json
"test:pg": "vitest run --no-file-parallelism .pg.test.ts"
```

(vitest CLI args are substring file filters; `.pg.test.ts` selects exactly the pg files, and `--no-file-parallelism` runs them one file at a time.)

- [ ] **Step 4: Verify the pg suite passes locally against a live container**

Start the container per Global Constraints, export `NLM_PG_TEST_URL`, then:

Run: `NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test" npm run test:pg`
Expected: ALL pg files PASS serially (previously these skipped without the env var). Also run plain `npm test` WITHOUT the env var and confirm pg files skip and the suite is green. If any pre-existing pg test fails here, STOP and report — that is a real pg bug this plan may already cover; note which test and continue only if it is one of the known-broken behaviors Tasks 3-4 fix (mutual supersede, ghost embeddings).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml migrations/pg/001_initial.sql package.json
git commit -m "ci: run pg adapter tests against a pgvector service container; make schema apply idempotent"
```

---

### Task 2: Delete the unused withTransaction / PgTx layer

The write-queue layer (`withTransaction` on the Storage port, `PgTxBoundFactStore`/`PgTxBoundSessionStore`) has zero production callers and its queued ops are semantically hollow copies (no cycle guard, no embedding delete). Deleting it removes the fourth divergent copy of pg fact-ingest before Task 3 unifies the remaining three.

**Files:**
- Modify: `src/ports/storage.ts` (remove `withTransaction` and `StorageContext`)
- Modify: `src/core/storage/pg-storage.ts` (remove `withTransaction`, `inTxn`, PgTx imports)
- Modify: `src/core/storage/sqlite-storage.ts` (remove its `withTransaction` impl)
- Delete: `src/core/storage/pg-tx-context.ts`
- Delete: `tests/contract/storage.contract.ts`
- Delete: `tests/integration/storage.pg.test.ts`
- Delete: any sqlite consumer of `storage.contract.ts` (grep first; as of writing none exists)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Storage` port without `withTransaction`; Task 3 adds nothing back — pg atomicity stays inside adapter methods via explicit BEGIN/COMMIT on a PoolClient, which is the pattern every production path already uses.

- [ ] **Step 1: Verify zero production callers**

Run: `grep -rn "withTransaction\|StorageContext\|PgTxBound" src/ --include="*.ts" | grep -v "pg-tx-context\|pg-storage\|sqlite-storage\|ports/storage"`
Expected: only comment-line hits (e.g. a doc comment in `sqlite-fact-store.ts`). If any CODE hit appears outside the four owning files, STOP and report — the deletion premise is wrong.

- [ ] **Step 2: Delete the layer**

Remove `withTransaction<T>(...)` and the `StorageContext` interface from `src/ports/storage.ts` (keep everything else, including the header comment's first paragraph — trim its withTransaction sentences). Remove the `withTransaction` method, `inTxn` field, and the `PgTxBoundFactStore, PgTxBoundSessionStore, type QueuedOp` import from `pg-storage.ts`. Remove the `withTransaction` implementation from `sqlite-storage.ts`. Delete `src/core/storage/pg-tx-context.ts`, `tests/contract/storage.contract.ts`, `tests/integration/storage.pg.test.ts`. Clean up any now-stale doc-comment references found in Step 1.

- [ ] **Step 3: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: clean / green (this proves nothing consumed the layer).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(storage): delete unused withTransaction write-queue layer (latent divergent pg ingest copy)"
```

---

### Task 3: Single source of truth for pg fact-ingest, with the #351 fixes

**Files:**
- Create: `src/core/storage/pg-fact-ingest.ts`
- Modify: `src/core/storage/pg-fact-store.ts:234-275` (`ingestSessionFacts`)
- Modify: `src/core/storage/pg-session-store.ts:466-499` (insertSession factSink block)
- Modify: `src/core/storage/pg-session-store.ts:608-648` (`insertFactsForSession`)
- Test: `tests/integration/pg-fact-ingest.pg.test.ts` (new)

**Interfaces:**
- Consumes: `Fact` from `@shared/types.js`, `PoolClient` type from `pg`.
- Produces: `export async function ingestSessionFactsOnClient(client: PoolClient, sessionId: string, facts: ReadonlyArray<Fact>): Promise<void>` — MUST be called inside an already-open transaction (caller owns BEGIN/COMMIT/ROLLBACK). All three call sites delegate to it.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/pg-fact-ingest.pg.test.ts`, copying the env-gating, `MIGRATIONS_DIR`, `TRUNCATE_SQL`, and setup/teardown harness shape from `tests/integration/fact-store.pg.test.ts`. Use `describe.skipIf(!process.env["NLM_PG_TEST_URL"])`. Tests (build facts with the existing `makeFact` fixture from `tests/fixtures/facts.js` if importable; otherwise inline object literals matching the `Fact` shape):

```typescript
it("intra-batch duplicate (subject,predicate) does not create a mutual supersedence cycle", async () => {
  // Two facts, same (subject, predicate), one batch. Winner = last in batch.
  const a = makeFact({ id: "f_a", subject: "svc", predicate: "framework", value: "Fastify", sourceSessionId: "s1" });
  const b = makeFact({ id: "f_b", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
  await storage.facts.ingestSessionFacts("s1", [a, b]);
  const rows = (await pool.query(
    "SELECT id, superseded_by FROM facts WHERE subject = 'svc' ORDER BY id",
  )).rows;
  // f_a superseded by f_b; f_b active. NOT f_a<->f_b mutual.
  expect(rows).toEqual([
    { id: "f_a", superseded_by: "f_b" },
    { id: "f_b", superseded_by: null },
  ]);
});

it("collapse deletes embeddings of newly superseded facts", async () => {
  const prior = makeFact({ id: "f_old", subject: "svc", predicate: "framework", value: "Express", sourceSessionId: "s0" });
  await storage.facts.ingestSessionFacts("s0", [prior]);
  await storage.facts.upsertEmbedding("f_old", new Float32Array(768).fill(0.1));
  const next = makeFact({ id: "f_new", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
  await storage.facts.ingestSessionFacts("s1", [next]);
  const emb = (await pool.query("SELECT fact_id FROM fact_embeddings WHERE fact_id = 'f_old'")).rows;
  expect(emb).toHaveLength(0); // ghost embedding must leave the ANN index
  const oldRow = (await pool.query("SELECT superseded_by FROM facts WHERE id = 'f_old'")).rows[0];
  expect(oldRow.superseded_by).toBe("f_new");
});

it("re-ingest of the same session is idempotent and leaves one active fact", async () => {
  const f1 = makeFact({ id: "f_1", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
  await storage.facts.ingestSessionFacts("s1", [f1]);
  const f1b = makeFact({ id: "f_1b", subject: "svc", predicate: "framework", value: "Hono", sourceSessionId: "s1" });
  await storage.facts.ingestSessionFacts("s1", [f1b]);
  const active = (await pool.query(
    "SELECT id FROM facts WHERE subject = 'svc' AND superseded_by IS NULL",
  )).rows;
  expect(active).toEqual([{ id: "f_1b" }]);
});
```

Also assert the same two bug-fix behaviors through the `insertSession` factSink path (the production daemon path) in the existing `tests/integration/pg-ingest.pg.test.ts` style: one added test there that ingests a session whose factSink carries a duplicate (subject,predicate) pair and asserts no mutual supersede. Copy its existing session-record scaffolding.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/pg-fact-ingest.pg.test.ts`
Expected: FAIL — the mutual-cycle test fails (both rows have non-null `superseded_by` pointing at each other) and the ghost-embedding test fails (embedding row still present).

- [ ] **Step 3: Write the shared helper**

Create `src/core/storage/pg-fact-ingest.ts`:

```typescript
/**
 * Single source of truth for pg fact-ingest. Caller owns the transaction:
 * this function MUST run on a client that already issued BEGIN.
 *
 * Mirrors SqliteFactStore.ingestSessionFactsInTxn semantics (NLM #351):
 *  - re-ingest clears prior facts for the session (fact_embeddings rows for
 *    DELETED facts self-clean via the FK ON DELETE CASCADE; UPDATE-superseded
 *    facts below need an explicit embedding delete)
 *  - one winner per (subject, predicate) per batch — last in batch wins —
 *    so an intra-batch duplicate can never create a mutual supersedence cycle
 *  - every fact the collapse supersedes leaves the ANN index immediately
 */

import type { PoolClient } from "pg";
import type { Fact } from "@shared/types.js";

export async function ingestSessionFactsOnClient(
  client: PoolClient,
  sessionId: string,
  facts: ReadonlyArray<Fact>,
): Promise<void> {
  await client.query("DELETE FROM facts WHERE source_session_id = $1", [sessionId]);
  if (facts.length === 0) return;

  for (const f of facts) {
    await client.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence, retired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [f.id, f.kind, f.subject, f.predicate, f.value, f.sourceSessionId,
       f.sourceQuote, f.createdAt, f.supersededBy, f.confidence, f.retiredAt],
    );
  }

  const winners = new Map<string, Fact>();
  for (const f of facts) winners.set(`${f.subject}\u0000${f.predicate}`, f);
  for (const f of winners.values()) {
    const collapsed = await client.query<{ id: string }>(
      `UPDATE facts SET superseded_by = $1
       WHERE subject = $2 AND predicate = $3 AND superseded_by IS NULL AND id != $1
       RETURNING id`,
      [f.id, f.subject, f.predicate],
    );
    const ids = collapsed.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [ids]);
    }
  }
}
```

Note the INSERT now persists `retired_at` (the sqlite insertStmt already does; this closes the pg half of that gap for the ingest path).

- [ ] **Step 4: Rewire the three call sites**

In `pg-fact-store.ts`, `ingestSessionFacts` becomes:

```typescript
async ingestSessionFacts(
  sessionId: string,
  facts: ReadonlyArray<Fact>,
): Promise<void> {
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    await ingestSessionFactsOnClient(client, sessionId, facts);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
```

with `import { ingestSessionFactsOnClient } from "./pg-fact-ingest.js";` added.

In `pg-session-store.ts` `insertSession`, replace the entire factSink block (lines 471-499, from `if (factSink !== null) {` through its closing brace) with:

```typescript
if (factSink !== null) {
  await ingestSessionFactsOnClient(client, record.id, factSink.facts);
}
```

keeping the existing explanatory comment above it but updating its text to: `// Atomic session+facts ingest on the session's own client. Single source of truth: pg-fact-ingest.ts.`

In `pg-session-store.ts` `insertFactsForSession`, replace the body of the transaction (the DELETE + insert loop + collapse UPDATE, lines 617-641) with the same one-line delegation `await ingestSessionFactsOnClient(client, sessionId, facts);` — the BEGIN/COMMIT/ROLLBACK/release scaffolding and the post-txn embedder loop stay.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration/pg-fact-ingest.pg.test.ts tests/integration/pg-ingest.pg.test.ts tests/integration/fact-store.pg.test.ts`
Expected: PASS, including the pre-existing contract suite (the winner-dedupe must not change single-fact-per-(s,p) behavior the contract already pins).

- [ ] **Step 6: Full gate and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/core/storage/pg-fact-ingest.ts src/core/storage/pg-fact-store.ts src/core/storage/pg-session-store.ts tests/integration/pg-fact-ingest.pg.test.ts tests/integration/pg-ingest.pg.test.ts
git commit -m "fix(pg): single-source fact ingest with winner dedupe + ghost-embedding cleanup (#351 parity)"
```

---

### Task 4: Session-cascade fact supersedence must clean embeddings (both adapters)

The session-level `markSuperseded` cascade sets `facts.superseded_by` with inline SQL on both adapters but never deletes the superseded facts' embeddings — the same ghost-vector defect Task 3 fixes for ingest, reachable via every operator `mark_superseded` call.

**Files:**
- Modify: `src/core/storage/sqlite-session-store.ts:835-852` (cascade block inside `markSuperseded`)
- Modify: `src/core/storage/pg-session-store.ts:284-304` (cascadeSQL block inside `markSuperseded`)
- Test: `tests/integration/session-supersede-fact-embeddings.test.ts` (new, sqlite)
- Test: `tests/integration/session-supersede-fact-embeddings.pg.test.ts` (new, env-gated)

**Interfaces:**
- Consumes: nothing from Task 3 (independent code paths); can run in parallel with it.
- Produces: nothing consumed by later tasks; Task 5's I7 invariant is the standing detector for regressions here.

- [ ] **Step 1: Write the failing tests**

Both files follow the corresponding backend's existing integration harness (`tests/integration/fact-supersedence.test.ts` shows the sqlite tmp-DB + storage setup pattern; the pg twin uses the `fact-store.pg.test.ts` harness shape). Core scenario, same on both backends:

```typescript
it("session markSuperseded cascade deletes embeddings of newly superseded facts", async () => {
  // Session A: fact (svc, framework) = Express, embedded.
  // Session B: fact (svc, framework) = Hono, active.
  // markSuperseded(A, B) must set A's fact superseded AND remove its embedding.
  await ingestSessionWithFact("sess_a", { id: "f_a", subject: "svc", predicate: "framework", value: "Express" });
  await upsertEmbedding("f_a");
  await ingestSessionWithFact("sess_b", { id: "f_b", subject: "svc", predicate: "framework", value: "Hono" });
  await sessions.markSuperseded("sess_a", "sess_b");

  expect(await factSupersededBy("f_a")).toBe("f_b");
  expect(await embeddingExists("f_a")).toBe(false);
});
```

Implement the tiny local helpers (`ingestSessionWithFact`, `upsertEmbedding`, `factSupersededBy`, `embeddingExists`) against the backend's raw handle, seeding sessions through the production `insertSession` path (NOT `insertSessionForTest` — cascade needs real fact rows from the factSink path). Add one negative case: a predecessor fact with no matching successor (different predicate) keeps its embedding and stays active.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/integration/session-supersede-fact-embeddings.test.ts`
Expected: FAIL on `embeddingExists("f_a")` → true (embedding still present).

- [ ] **Step 3: Fix sqlite**

In `sqlite-session-store.ts` `markSuperseded`, extend the cascade block. After the existing `updateFactSuperseded` prepare (line 842-844), add:

```typescript
const delFactEmbedding = this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
```

and inside the loop, after `updateFactSuperseded.run(successor.id, pFact.id);` add:

```typescript
delFactEmbedding.run(pFact.id);
```

(Same reason `markSuperseded`/`retire`/ingest delete embeddings: a superseded fact must not linger in the ANN index.)

- [ ] **Step 4: Fix pg**

In `pg-session-store.ts` `markSuperseded`, change the cascade to capture what it superseded and clean up, replacing the plain `await client.query(cascadeSQL, [predecessorId, successorId]);` with:

```typescript
const cascaded = await client.query<{ id: string }>(
  cascadeSQL + " RETURNING p.id",
  [predecessorId, successorId],
);
const cascadedIds = cascaded.rows.map((r) => r.id);
if (cascadedIds.length > 0) {
  await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [cascadedIds]);
}
```

(`cascadeSQL` is a template string ending after the WHERE clause; appending `RETURNING p.id` is valid because the statement is a single UPDATE.)

- [ ] **Step 5: Run tests to verify they pass, full gate, commit**

Run: `npx vitest run tests/integration/session-supersede-fact-embeddings.test.ts tests/integration/session-supersede-fact-embeddings.pg.test.ts && npm run typecheck && npm test`

```bash
git add src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts tests/integration/session-supersede-fact-embeddings.test.ts tests/integration/session-supersede-fact-embeddings.pg.test.ts
git commit -m "fix(storage): session-supersede cascade deletes fact embeddings on both adapters"
```

---

### Task 5: I7 invariant — no embedding without a live parent fact

Make the ghost/orphan class detectable by `nlm check-invariants`, so any future write path that forgets embedding cleanup is caught by the standing integrity check instead of a corpus audit.

**Files:**
- Modify: `src/core/integrity/check-invariants.ts`
- Test: extend `tests/integration/check-invariants.test.ts` and `tests/integration/check-invariants.pg.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (but its test seeds exercise the classes Tasks 3-4 fixed).
- Produces: violation id `"I7"` in check output; `--fix` deletes the offending embedding rows.

- [ ] **Step 1: Write the failing tests**

Follow the existing seed/detect/`--fix`/idempotency pattern in `check-invariants.test.ts` exactly (raw-SQL seeding is correct here; production paths can no longer create these states after Tasks 3-4). Three seeds per backend:

```typescript
it("I7 flags an embedding whose fact was superseded without cleanup", async () => {
  // seed: fact f_ghost superseded_by f_live, but fact_embeddings still has f_ghost
});
it("I7 flags an embedding whose fact is retired", async () => {
  // seed: fact with retired_at set, embedding present
});
it("I7 flags an embedding with no facts row at all (sqlite only — pg FK forbids)", async () => {
  // sqlite: insert into fact_embeddings with a fact_id that has no facts row
});
it("--fix deletes exactly the violating embedding rows and is idempotent", async () => {
  // run fix, assert violating rows gone, live fact's embedding untouched, second run reports zero
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/integration/check-invariants.test.ts`
Expected: FAIL — no `I7` violation id exists yet.

- [ ] **Step 3: Implement I7**

In `check-invariants.ts`, add alongside the existing portable SQL strings:

```typescript
// An embedding row must have a live (active, non-retired) parent fact.
// Superseded/retired facts leave the ANN index at write time (ingest collapse,
// markSuperseded, retire, session cascade); a row here means a write path
// skipped cleanup — the NLM #351 orphan class.
const SQL_I7_GHOST_EMBEDDINGS = `
  SELECT fe.fact_id AS bad_id
  FROM fact_embeddings fe
  LEFT JOIN facts f ON f.id = fe.fact_id
  WHERE f.id IS NULL OR f.superseded_by IS NOT NULL OR f.retired_at IS NOT NULL
  LIMIT 6
`;

const SQL_I7_COUNT = `
  SELECT COUNT(*) AS n
  FROM fact_embeddings fe
  LEFT JOIN facts f ON f.id = fe.fact_id
  WHERE f.id IS NULL OR f.superseded_by IS NOT NULL OR f.retired_at IS NOT NULL
`;

const SQL_I7_FIX = `
  DELETE FROM fact_embeddings
  WHERE fact_id IN (
    SELECT fe.fact_id
    FROM fact_embeddings fe
    LEFT JOIN facts f ON f.id = fe.fact_id
    WHERE f.id IS NULL OR f.superseded_by IS NOT NULL OR f.retired_at IS NOT NULL
  )
`;
```

Register I7 in the check list and the `--fix` path for BOTH backends, following exactly how I5's dangling-superseded check is wired into `runChecksOnSqlite` / `runChecksOnPg` and the fix runner (read those sections first; keep the description string format consistent: `"I7: fact embedding without a live parent fact"`). SQLite note: `fact_embeddings` is the vec0-adjacent table the repair script `scripts/repair-orphan-fact-embeddings.mjs` targets — mirror its table/column naming if it differs from the pg schema, and reuse its detection semantics (it is the proven-on-live-data reference).

- [ ] **Step 4: Run tests to verify they pass, full gate, commit**

Run: `npx vitest run tests/integration/check-invariants.test.ts tests/integration/check-invariants.pg.test.ts && npm run typecheck && npm test`

```bash
git add src/core/integrity/check-invariants.ts tests/integration/check-invariants.test.ts tests/integration/check-invariants.pg.test.ts
git commit -m "feat(integrity): I7 invariant — no fact embedding without a live parent fact"
```

---

## Out of scope (Wave 2b plan, separate session)

C-6 pg action-overlay on reads, I-7 pg migration runner, I-19 PgWorkstreamStore tests, I-9 keywordSearch semantics parity, O-8 pg batch inserts + ivfflat-friendly semanticSearch (flag as opportunistic pickups only if an implementer is already in the file). The bind-flip runbook must schedule the workstream backfill sweep as the retry net for failed binds (I-14 decision, 2026-07-01).
