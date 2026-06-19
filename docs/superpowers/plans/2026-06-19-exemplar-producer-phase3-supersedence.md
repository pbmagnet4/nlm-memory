# Code-exemplar producer — Phase 3 (supersedence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make captured code exemplars editable — a human can retire (exclude from recall) or relabel an exemplar's outcome, with an `llm`/`human` provenance where **a human verdict is sticky (LLM operations no-op on it)**. Mirrors how facts already use `retired_at`, with provenance made explicit.

**Architecture:** Add `retired_at` + `label_source` columns to `code_exemplars` (SQLite migration + the consolidated PG schema). A new `setVerdict(id, patch, source)` store method applies a retire/relabel and enforces the "human wins" rule atomically. `searchByVector` excludes retired exemplars (the single recall-exclusion point, covering both `recall_code` and the Phase-2 passive recall); `getById` still returns them for audit. A `POST /api/exemplar/:id/verdict` REST route and a `supersede_exemplar` MCP tool are the human override surface (both write `source = "human"`).

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, better-sqlite3, pg/pgvector, the existing `CodeExemplarStore` (SQLite + PG impls) and shared contract test, the MCP server (`server.ts`).

## Global Constraints

- Gated by `process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1"` for the REST/MCP surface (the schema + store methods exist regardless; the routes/tool are off by default like the rest of the lane).
- **Human-wins rule (the core invariant):** `setVerdict(id, patch, "llm")` is a **no-op when the row's current `label_source === "human"`** (returns `human_locked`). `setVerdict(..., "human")` always applies and stamps `label_source = "human"`. The rule is enforced inside the store update (atomic), not in a caller.
- **Recall excludes retired; audit retains it:** `searchByVector` adds `retired_at IS NULL`; `getById` does NOT filter (returns retired rows). The embedding row is left intact on retire (retire is reversible — a later `setVerdict({retired:false})` restores recall without re-embedding).
- Capture is unchanged: new inserts get `label_source = "llm"` via the column DEFAULT (no insert-statement change needed).
- Both backends must pass the SAME shared contract (`tests/contract/code-exemplar-store.contract.ts`) — SQLite (integration test) and PG (`.pg.test.ts`, run against a `pgvector/pgvector:pg16` container with `NLM_PG_TEST_URL`).
- ESM/NodeNext `.js` imports; `@core/@ports/@shared` aliases. Public repo, no secrets.
- **TDD per task; run `npm run typecheck` (BOTH `tsconfig.json` AND `tsconfig.test.json` — CI runs both; the first config alone misses `exactOptionalPropertyTypes` errors in test files) before each commit.** Run `npx vitest run` before the final commit of each task.

---

### Task 1: Schema + audit fields (`retired_at`, `label_source`)

**Files:**
- Create: `migrations/023_code_exemplars_supersedence.sql`
- Modify: `migrations/pg/001_initial.sql` (the `code_exemplars` table)
- Modify: `src/shared/types.ts` (`CodeExemplar` gains `retiredAt` + `labelSource`)
- Modify: `src/core/storage/sqlite-code-exemplar-store.ts` (`ExemplarRow` + `getById` SELECT/mapping)
- Modify: `src/core/storage/pg-code-exemplar-store.ts` (`ExemplarRow` + `COLUMNS` + `rowToExemplar`)
- Modify: `tests/contract/code-exemplar-store.contract.ts` (a "defaults" assertion)

**Interfaces:**
- Produces: `CodeExemplar` gains `readonly retiredAt: string | null;` and `readonly labelSource: "llm" | "human";`.

- [ ] **Step 1: Write the SQLite migration**

```sql
-- migrations/023_code_exemplars_supersedence.sql
-- Migration 023: code_exemplars supersedence — operator/LLM verdict on exemplars.
--
-- retired_at: non-null = excluded from recall (the "verdict"), like facts.retired_at.
-- label_source: who last set the verdict/outcome ('llm' at capture; 'human' on
-- operator override). A human verdict is sticky — see CodeExemplarStore.setVerdict.

ALTER TABLE code_exemplars ADD COLUMN retired_at TEXT;
ALTER TABLE code_exemplars ADD COLUMN label_source TEXT NOT NULL DEFAULT 'llm';

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (23, '023_code_exemplars_supersedence');
```

- [ ] **Step 2: Add the columns to the consolidated PG schema**

In `migrations/pg/001_initial.sql`, in the `CREATE TABLE IF NOT EXISTS code_exemplars (...)` block, add two columns before the closing `)`:
```sql
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (now()::text),
  retired_at    TEXT,
  label_source  TEXT NOT NULL DEFAULT 'llm'
);
```
(Insert the two new lines after the existing `created_at` line, adding the comma to `created_at`.)

- [ ] **Step 3: Add the fields to `CodeExemplar` (src/shared/types.ts)**

In the `CodeExemplar` interface, after `createdAt`:
```ts
  readonly retiredAt: string | null;
  readonly labelSource: "llm" | "human";
```

- [ ] **Step 4: Surface the columns in both stores' `getById`**

In `src/core/storage/sqlite-code-exemplar-store.ts`:
- Add `retired_at: string | null;` and `label_source: "llm" | "human";` to the `ExemplarRow` type.
- In the `getById` SELECT (the `FROM code_exemplars WHERE id = ?` query), add `, retired_at, label_source` to the column list.
- In `rowToExemplar`, add `retiredAt: row.retired_at, labelSource: row.label_source,`.

In `src/core/storage/pg-code-exemplar-store.ts`:
- Add `retired_at: string | null;` and `label_source: "llm" | "human";` to its `ExemplarRow` type.
- Add `retired_at` and `label_source` to the `COLUMNS` constant string.
- In `rowToExemplar`, add `retiredAt: row.retired_at, labelSource: row.label_source,`.

- [ ] **Step 5: Add the failing contract assertion**

In `tests/contract/code-exemplar-store.contract.ts`, add an `it` to the contract `describe`:
```ts
    it("a freshly inserted exemplar is active, llm-sourced", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const fetched = await storage.exemplars.getById(id);
      expect(fetched).not.toBeNull();
      expect(fetched!.retiredAt).toBeNull();
      expect(fetched!.labelSource).toBe("llm");
    });
```

- [ ] **Step 6: Run the SQLite contract + typecheck**

Run: `npx vitest run tests/integration/sqlite-code-exemplar-store.test.ts && npm run typecheck`
Expected: PASS (the new assertion + existing cases); typecheck clean.

- [ ] **Step 7: Run the PG contract against a container**

Run:
```bash
docker rm -f nlm-pg-sup >/dev/null 2>&1
docker run -d --name nlm-pg-sup -p 55432:5432 -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
sleep 4
NLM_PG_TEST_URL="postgres://postgres:test@localhost:55432/postgres" npx vitest run tests/integration/pg-code-exemplar-store.pg.test.ts
docker rm -f nlm-pg-sup >/dev/null 2>&1
```
Expected: PASS (the contract incl. the new assertion runs green on PG).

- [ ] **Step 8: Commit**

```bash
git add migrations/023_code_exemplars_supersedence.sql migrations/pg/001_initial.sql src/shared/types.ts src/core/storage/sqlite-code-exemplar-store.ts src/core/storage/pg-code-exemplar-store.ts tests/contract/code-exemplar-store.contract.ts
git commit -m "feat(exemplars): add retired_at + label_source columns (supersedence schema)"
```

---

### Task 2: `setVerdict` — retire/relabel with the human-wins rule

**Files:**
- Modify: `src/ports/code-exemplar-store.ts` (port method + result types)
- Modify: `src/core/storage/sqlite-code-exemplar-store.ts` (`setVerdict`)
- Modify: `src/core/storage/pg-code-exemplar-store.ts` (`setVerdict`)
- Modify: `tests/contract/code-exemplar-store.contract.ts` (verdict cases)

**Interfaces:**
- Produces (in the port):
  ```ts
  export type ExemplarVerdictSource = "llm" | "human";
  export interface ExemplarVerdictPatch {
    readonly retired?: boolean;            // true → set retired_at=now; false → clear it
    readonly outcome?: CodeExemplarOutcome;
  }
  export interface ExemplarVerdictResult {
    readonly status: "applied" | "not_found" | "human_locked";
  }
  // on CodeExemplarStore:
  setVerdict(id: string, patch: ExemplarVerdictPatch, source: ExemplarVerdictSource): Promise<ExemplarVerdictResult>;
  ```

- [ ] **Step 1: Add the types + method to the port**

In `src/ports/code-exemplar-store.ts`, add the three exported types above (import `CodeExemplarOutcome` from `@shared/types.js` if not already), and add to the `CodeExemplarStore` interface:
```ts
  /**
   * Apply an operator/LLM verdict (retire/un-retire and/or relabel outcome).
   * Human-wins: a `source: "llm"` call is a no-op when the row is already
   * `label_source: "human"`. Returns the outcome so callers can surface it.
   */
  setVerdict(id: string, patch: ExemplarVerdictPatch, source: ExemplarVerdictSource): Promise<ExemplarVerdictResult>;
```

- [ ] **Step 2: Write the failing contract cases**

In `tests/contract/code-exemplar-store.contract.ts`, add:
```ts
    it("setVerdict retire sets retired_at + label_source", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const res = await storage.exemplars.setVerdict(id, { retired: true }, "human");
      expect(res.status).toBe("applied");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).not.toBeNull();
      expect(fetched!.labelSource).toBe("human");
    });

    it("setVerdict can relabel outcome and un-retire", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      await storage.exemplars.setVerdict(id, { retired: true, outcome: "fail" }, "human");
      const res = await storage.exemplars.setVerdict(id, { retired: false }, "human");
      expect(res.status).toBe("applied");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).toBeNull();
      expect(fetched!.outcome).toBe("fail");
    });

    it("human wins: an llm verdict no-ops on a human-sourced row", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      await storage.exemplars.setVerdict(id, { retired: true }, "human");
      const res = await storage.exemplars.setVerdict(id, { retired: false }, "llm");
      expect(res.status).toBe("human_locked");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).not.toBeNull(); // unchanged — human verdict held
      expect(fetched!.labelSource).toBe("human");
    });

    it("an llm verdict applies on an llm-sourced (default) row", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const res = await storage.exemplars.setVerdict(id, { retired: true }, "llm");
      expect(res.status).toBe("applied");
      expect((await storage.exemplars.getById(id))!.labelSource).toBe("llm");
    });

    it("setVerdict on a missing id reports not_found", async () => {
      const res = await storage.exemplars.setVerdict("nope", { retired: true }, "human");
      expect(res.status).toBe("not_found");
    });
```

- [ ] **Step 3: Implement `setVerdict` in the SQLite store**

```ts
  async setVerdict(
    id: string,
    patch: ExemplarVerdictPatch,
    source: ExemplarVerdictSource,
  ): Promise<ExemplarVerdictResult> {
    const row = this.db
      .prepare<[string], { label_source: "llm" | "human" }>(
        "SELECT label_source FROM code_exemplars WHERE id = ?",
      )
      .get(id);
    if (!row) return { status: "not_found" };
    if (source === "llm" && row.label_source === "human") return { status: "human_locked" };

    const sets: string[] = ["label_source = @source"];
    const params: Record<string, unknown> = { id, source };
    if (patch.retired !== undefined) {
      sets.push("retired_at = @retiredAt");
      params["retiredAt"] = patch.retired ? new Date().toISOString() : null;
    }
    if (patch.outcome !== undefined) {
      sets.push("outcome = @outcome");
      params["outcome"] = patch.outcome;
    }
    this.db.prepare(`UPDATE code_exemplars SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return { status: "applied" };
  }
```

- [ ] **Step 4: Implement `setVerdict` in the PG store**

```ts
  async setVerdict(
    id: string,
    patch: ExemplarVerdictPatch,
    source: ExemplarVerdictSource,
  ): Promise<ExemplarVerdictResult> {
    const cur = await this.pool.query<{ label_source: "llm" | "human" }>(
      "SELECT label_source FROM code_exemplars WHERE id = $1",
      [id],
    );
    if (cur.rows.length === 0) return { status: "not_found" };
    if (source === "llm" && cur.rows[0]!.label_source === "human") return { status: "human_locked" };

    const sets: string[] = [];
    const values: unknown[] = [];
    let n = 1;
    sets.push(`label_source = $${n++}`);
    values.push(source);
    if (patch.retired !== undefined) {
      sets.push(`retired_at = $${n++}`);
      values.push(patch.retired ? new Date().toISOString() : null);
    }
    if (patch.outcome !== undefined) {
      sets.push(`outcome = $${n++}`);
      values.push(patch.outcome);
    }
    values.push(id);
    await this.pool.query(`UPDATE code_exemplars SET ${sets.join(", ")} WHERE id = $${n}`, values);
    return { status: "applied" };
  }
```
Add the type imports (`ExemplarVerdictPatch`, `ExemplarVerdictResult`, `ExemplarVerdictSource`) from `@ports/code-exemplar-store.js` to both store files.

- [ ] **Step 5: Run the SQLite contract + typecheck, then the PG contract**

Run: `npx vitest run tests/integration/sqlite-code-exemplar-store.test.ts && npm run typecheck`
Then the PG container run (same as Task 1 Step 7, against `pg-code-exemplar-store.pg.test.ts`).
Expected: all verdict cases PASS on both backends; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/ports/code-exemplar-store.ts src/core/storage/sqlite-code-exemplar-store.ts src/core/storage/pg-code-exemplar-store.ts tests/contract/code-exemplar-store.contract.ts
git commit -m "feat(exemplars): setVerdict — retire/relabel with human-wins provenance, both backends"
```

---

### Task 3: `searchByVector` excludes retired exemplars

**Files:**
- Modify: `src/core/storage/sqlite-code-exemplar-store.ts` (`searchByVector`)
- Modify: `src/core/storage/pg-code-exemplar-store.ts` (`searchByVector`)
- Modify: `tests/contract/code-exemplar-store.contract.ts` (exclusion case)

- [ ] **Step 1: Write the failing contract case**

```ts
    it("searchByVector excludes retired exemplars but getById still returns them", async () => {
      const inp = makeExemplarInput();
      const { id } = await storage.exemplars.insert(inp);
      await storage.exemplars.upsertEmbedding(id, unitVec(0));
      // present before retire
      const before = await storage.exemplars.searchByVector(unitVec(0), { installScope: inp.installScope, k: 5 });
      expect(before.map((h) => h.id)).toContain(id);
      // retire → excluded from search, still in getById
      await storage.exemplars.setVerdict(id, { retired: true }, "human");
      const after = await storage.exemplars.searchByVector(unitVec(0), { installScope: inp.installScope, k: 5 });
      expect(after.map((h) => h.id)).not.toContain(id);
      expect(await storage.exemplars.getById(id)).not.toBeNull();
    });
```

> Implementer note: the contract test file may already define a `unitVec`-style helper (the PG suite uses one). If the shared contract has no unit-vector helper, add a small local one at the top of the contract: `function unitVec(i: number): Float32Array { const v = new Float32Array(768); v[i] = 1; return v; }`. Reuse whatever the file already has rather than duplicating.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/integration/sqlite-code-exemplar-store.test.ts`
Expected: FAIL — the retired exemplar is still returned by `searchByVector`.

- [ ] **Step 3: Add the exclusion filter in the SQLite store**

In `searchByVector`, the second query selects from `code_exemplars WHERE id IN (...) AND install_scope = ?`. Add the retired filter:
```sql
         FROM code_exemplars
         WHERE id IN (${placeholders}) AND install_scope = ? AND retired_at IS NULL`,
```

- [ ] **Step 4: Add the exclusion filter in the PG store**

In `searchByVector`, the join query has `WHERE ce.install_scope = $2`. Change it to:
```sql
       WHERE ce.install_scope = $2 AND ce.retired_at IS NULL
```

- [ ] **Step 5: Run the SQLite contract + typecheck + the PG contract + full suite**

Run: `npx vitest run tests/integration/sqlite-code-exemplar-store.test.ts && npm run typecheck && npx vitest run`
Then the PG container run.
Expected: exclusion case PASS on both backends; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/core/storage/sqlite-code-exemplar-store.ts src/core/storage/pg-code-exemplar-store.ts tests/contract/code-exemplar-store.contract.ts
git commit -m "feat(exemplars): exclude retired exemplars from searchByVector (recall + passive)"
```

---

### Task 4: Human override surface — REST route + MCP tool

**Files:**
- Modify: `src/http/app.ts` (add `POST /api/exemplar/:id/verdict`)
- Modify: `src/mcp/server.ts` (add `supersede_exemplar` tool in the existing `recall_code` gated block)
- Test: `tests/unit/http/exemplar-verdict-route.test.ts` (create)

**Interfaces:**
- Consumes: `CodeExemplarStore.setVerdict` (Task 2).

- [ ] **Step 1: Write the failing route test**

```ts
// tests/unit/http/exemplar-verdict-route.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { ExemplarVerdictPatch, ExemplarVerdictSource } from "../../../src/ports/code-exemplar-store.js";

function fakeStore(calls: Array<{ id: string; patch: ExemplarVerdictPatch; source: ExemplarVerdictSource }>) {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict(id: string, patch: ExemplarVerdictPatch, source: ExemplarVerdictSource) {
      calls.push({ id, patch, source });
      return { status: id === "missing" ? "not_found" as const : "applied" as const };
    },
  };
}
function appWith(store: ReturnType<typeof fakeStore>) {
  return createApp({ recall: { search: async () => ({}) }, store: {}, exemplarStore: store, installScope: "s" } as never);
}

describe("POST /api/exemplar/:id/verdict", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1"; });
  afterEach(() => { if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev; });

  it("retires an exemplar as a human verdict", async () => {
    const calls: Array<{ id: string; patch: ExemplarVerdictPatch; source: ExemplarVerdictSource }> = [];
    const app = appWith(fakeStore(calls));
    const res = await app.request("/api/exemplar/ex1/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ id: "ex1", patch: { retired: true }, source: "human" }]);
  });

  it("404s when the exemplar does not exist", async () => {
    const app = appWith(fakeStore([]));
    const res = await app.request("/api/exemplar/missing/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(404);
  });

  it("403s when the flag is off", async () => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    const app = appWith(fakeStore([]));
    const res = await app.request("/api/exemplar/ex1/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/http/exemplar-verdict-route.test.ts`
Expected: FAIL — route not defined (404 for all).

- [ ] **Step 3: Add the REST route in `app.ts`**

In the code-exemplar route block (next to `POST /api/exemplar`), add — mirroring its 503/403 guards:
```ts
  app.post("/api/exemplar/:id/verdict", async (c) => {
    if (!c.req.param("id") || !deps.exemplarStore) {
      return c.json({ error: "exemplar store not wired in this deployment" }, 503);
    }
    if (process.env["NLM_CODE_EXEMPLARS_ENABLED"] !== "1") {
      return c.json({ error: "code exemplars disabled" }, 403);
    }
    let body: { retire?: unknown; outcome?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const patch: { retired?: boolean; outcome?: CodeExemplarOutcome } = {};
    if (typeof body.retire === "boolean") patch.retired = body.retire;
    if (body.outcome === "pass" || body.outcome === "fail" || body.outcome === "fix" || body.outcome === "exhausted") {
      patch.outcome = body.outcome;
    }
    if (patch.retired === undefined && patch.outcome === undefined) {
      return c.json({ error: "provide retire (boolean) and/or outcome" }, 400);
    }
    const result = await deps.exemplarStore.setVerdict(c.req.param("id"), patch, "human");
    if (result.status === "not_found") return c.json({ error: "exemplar not found" }, 404);
    return c.json({ id: c.req.param("id"), status: result.status }, 200);
  });
```
(`CodeExemplarOutcome` is already importable in `app.ts` via `@shared/types.js` — add it to the existing type import if absent.)

- [ ] **Step 4: Add the `supersede_exemplar` MCP tool in `server.ts`**

Inside the existing `if (deps.exemplarStore && deps.installScope && NLM_CODE_EXEMPLARS_ENABLED === "1") { ... }` block (where `recall_code` is registered), register a sibling tool — mirror the `supersede_fact` registration shape:
```ts
    server.registerTool(
      "supersede_exemplar",
      {
        title: "Supersede a Code Exemplar",
        description: "Retire (exclude from recall) or relabel the outcome of a code exemplar returned by recall_code. Records the change as a human verdict, which an automated pass will not override.",
        inputSchema: {
          exemplar_id: z.string().min(4).describe("Exemplar id from recall_code."),
          retire: z.boolean().optional().describe("true to exclude from recall, false to restore."),
          outcome: z.enum(["pass", "fail", "fix", "exhausted"]).optional().describe("Relabel the exemplar's outcome."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const a = args as { exemplar_id: string; retire?: boolean; outcome?: "pass" | "fail" | "fix" | "exhausted" };
        const patch: { retired?: boolean; outcome?: "pass" | "fail" | "fix" | "exhausted" } = {};
        if (a.retire !== undefined) patch.retired = a.retire;
        if (a.outcome !== undefined) patch.outcome = a.outcome;
        const res = await exemplarStore.setVerdict(a.exemplar_id, patch, "human");
        return { content: [{ type: "text", text: JSON.stringify({ exemplar_id: a.exemplar_id, status: res.status }) }] } as never;
      },
    );
```
(`exemplarStore` is the `const exemplarStore = deps.exemplarStore;` already captured in that block for `recall_code`. Reuse it.)

- [ ] **Step 5: Run the route test + typecheck + full suite**

Run: `npx vitest run tests/unit/http/exemplar-verdict-route.test.ts && npm run typecheck && npx vitest run`
Expected: route test PASS; typecheck clean (both configs); full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/http/app.ts src/mcp/server.ts tests/unit/http/exemplar-verdict-route.test.ts
git commit -m "feat(exemplars): supersede_exemplar MCP tool + POST /api/exemplar/:id/verdict (human override)"
```

---

## Manual verification (end of Phase 3)

On a flag-on daemon: `recall_code` returns an exemplar id; calling the `supersede_exemplar` MCP tool (or `POST /api/exemplar/<id>/verdict {"retire":true}`) retires it; a subsequent `recall_code`/passive recall no longer surfaces it; `getById` (via the daemon internals/UI) still shows it with `retired_at` set and `label_source = "human"`. A later automated `setVerdict(..., "llm")` leaves the human verdict untouched.

## Self-review notes (coverage vs spec §D)

- §D `retired_at` + `label_source` columns → Task 1.
- §D human-wins resolution rule → Task 2 (`setVerdict`, atomic).
- §D recall excludes retired, audit retains → Task 3 (`searchByVector`) + `getById` unchanged.
- §D human override via MCP `supersede_exemplar` + REST verdict route → Task 4.
- Out of scope (documented in §D as deferred): an automated LLM retirement pass (no caller emits `source:"llm"` verdicts yet — the schema + rule are ready for it); a full per-change audit *stack* (the sticky-provenance row IS the record; a jsonl log like facts' is a later add); a management UI.
- Pre-existing inconsistency noted for a separate follow-up: the unused manual `migrations/pg/021_code_exemplars.sql` / `pg/022_facts_retired_at.sql` files diverge from the canonical `pg/001_initial.sql` (e.g. vec-table name `code_exemplars_vec` vs `code_exemplar_embeddings`). Not touched here.
