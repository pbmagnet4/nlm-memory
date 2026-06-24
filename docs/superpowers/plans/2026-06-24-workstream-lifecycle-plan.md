# Workstream Lifecycle (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose operator-initiated, supersedence-style lifecycle corrections for workstreams — `rebind_session`, `merge_workstreams`, `rename_workstream`, `retire_workstream`, and an on-demand `list_merge_suggestions` cleanup surface — as MCP tools + CLI, mirroring the existing supersede tools.

**Architecture:** Plan A built the workstream foundation (model/match/resolve/rollup/bind) and the `WorkstreamStore` with read + create + entity methods. Plan B surfaced read paths (recall_workstream, work-digest labels). Plan C adds the *mutation* surface: three new `WorkstreamStore` methods (`setLabel`, `setStatus`, `merge`), reuse of the existing `SessionStore.setWorkstreamBinding` for rebind, and five MCP tools + CLI commands. All corrections are audit-trailed via the existing `merged_into` supersedence pointer and `binding_source=operator`; merge chains resolve through `resolveWorkstreamId` (Plan A) so no `session.workstream_id` is ever rewritten on merge. No schema migration: every lifecycle op uses columns that already exist (`workstreams.label/status/merged_into`, `sessions.workstream_id/binding_source/binding_confidence`, `workstream_entities`).

**Tech Stack:** TypeScript (ESM, `@core`/`@ports` aliases), better-sqlite3 (live runtime, transactions available), Postgres + pgvector (parity-only, NO test runner — judge PG SQL by reading it), `@modelcontextprotocol/sdk` (MCP, Zod input schemas), `commander` (CLI), vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md` (§12 lifecycle & supersedence, §7 duplication control / merge-suggestion, §4 atomic rebind). This plan implements Plan C (LIFECYCLE). Plans A (foundation) + B (surfacing) are merged to local main; D (seed/backfill/flip) is separate.
- **Builds on (present at branch base — verified):** `WorkstreamStore.{create,getById,findByNormalizedLabel,listAll,touchLastSession,upsertEntities,entitiesFor,candidatesByEntityOverlap}` (`src/ports/workstream-store.ts`); `SessionStore.setWorkstreamBinding(sessionId, workstreamId|null, source, confidence)` (`src/ports/session-store.ts:86`) + `SessionStore.listSessionIdsByWorkstreams(ids)`; `resolveWorkstreamId(id, byId)` (`src/core/workstream/resolve.ts`); `normalizeLabel(label)` (`src/core/workstream/model.ts:51`); `WorkstreamStatus = "active"|"merged"|"retired"`, `BindingSource = "classifier"|"operator"` (`model.ts`); `McpDeps.workstreams = { store: WorkstreamStore, sessions: Pick<SessionStore,"listSessionIdsByWorkstreams">, facts, exemplars }` (`src/mcp/server.ts`, added in Plan B).
- **TDD always:** failing test → run-it-fails → minimal impl → green. `npm run test` + `npm run typecheck` pass before every commit.
- **SQLite + Postgres parity:** every `WorkstreamStore` change ships in BOTH `src/core/storage/sqlite-workstream-store.ts` and `src/core/storage/pg-workstream-store.ts`. SQLite is the verified runtime (`~/.nlm/canonical.sqlite`); PG is parity-only with NO test runner in the suite — read the PG SQL by eye to confirm column names + dialect.
- **Supersedence, not deletion:** merge sets `merged_into` + `status="merged"` (never deletes the row); retire sets `status="retired"`. Queries resolve `merged_into` to the live survivor via `resolveWorkstreamId` before reading (rollup/recall already do this — Plan A/B).
- **No hot-path code, hot-path-free (spec §16):** lifecycle is operator-initiated MCP/CLI only; no scheduler, no daemon sweep change. `build:server` is NOT required as a gate for this plan (no `src/cli/nlm.ts` daemon-sweep change; the CLI command additions are operator commands, but to keep the running daemon in sync, the post-MERGE rebuild/restart still happens once after Plan C lands — deferred, post-push, per the repo rule).
- **Mutating MCP tools:** annotate `readOnlyHint: false`. Merge/rebind/rename/retire are reversible corrections (`destructiveHint: false`); `list_merge_suggestions` is `readOnlyHint: true`.
- **Fail-soft at the boundary:** every handler validates its inputs (workstream/session exists; not self-merge; not already-merged-away) and returns a graceful `okText(...)` message on a bad-but-expected request — never throws to the transport. Internal store methods may assume valid input (the handler is the boundary).
- **Public-repo hygiene:** nlm-memory is PUBLIC. Stage only each task's named files (never `git add .`/`-A`; an untracked `scripts/eval/judge-calibration.ts` is present and must NOT be staged). No home paths, host IPs, or client/infra/venture names in any commit. Do NOT push (Edward controls the public push).

---

## File Structure

**New:**
- `src/core/workstream/merge-suggest.ts` — pure: `scoreMergePair(a, b)` + `suggestMerges(input)` → ranked candidate pairs (shared entities + co-occurring sessions + label edit-distance). No I/O.
- `tests/unit/core/workstream/merge-suggest.test.ts`
- `tests/integration/workstream-lifecycle-store.test.ts` — store-level: setLabel/setStatus/merge + entity union + merged_into resolution.
- `tests/integration/workstream-lifecycle-mcp.test.ts` — handler-level: rebind/merge/rename/retire/suggest end-to-end on a real SqliteStorage, asserting the audit trail (status, merged_into, binding_source).

**Modified:**
- `src/ports/workstream-store.ts` — add `setLabel`, `setStatus`, `merge` to the interface.
- `src/core/storage/sqlite-workstream-store.ts` — implement the three (merge in a transaction).
- `src/core/storage/pg-workstream-store.ts` — implement the three (parity).
- `src/mcp/server.ts` — add `rebindSessionHandler`, `mergeWorkstreamsHandler`, `renameWorkstreamHandler`, `retireWorkstreamHandler`, `listMergeSuggestionsHandler`; register the five tools.
- `src/cli/nlm.ts` — add `nlm rebind-session`, `nlm merge-workstreams`, `nlm rename-workstream`, `nlm retire-workstream`, `nlm merge-suggestions` commands (mirror the `recall-workstream` command added in Plan B).

---

## Canonical Contracts (defined once; every task uses these names)

```typescript
// src/ports/workstream-store.ts — WorkstreamStore gains:
setLabel(id: string, label: string): Promise<void>;
setStatus(id: string, status: import("@core/workstream/model.js").WorkstreamStatus): Promise<void>;
/** Supersede `fromId` into `intoId`: set from.merged_into=intoId, from.status="merged",
 *  union from's workstream_entities into into (summing session_count), then clear from's rows.
 *  Atomic on sqlite (transaction). Assumes both ids exist and from!==into (handler validates). */
merge(fromId: string, intoId: string): Promise<void>;

// src/core/workstream/merge-suggest.ts:
export interface MergeSuggestInputItem {
  readonly id: string;
  readonly label: string;
  readonly entities: ReadonlyArray<string>;     // canonical entity names for this workstream
  readonly sessionIds: ReadonlyArray<string>;   // sessions bound to this workstream
}
export interface MergeSuggestion {
  readonly aId: string; readonly aLabel: string;
  readonly bId: string; readonly bLabel: string;
  readonly score: number;                       // 0..1, higher = more likely duplicate
  readonly sharedEntities: number;
  readonly sharedSessions: number;
  readonly labelSimilarity: number;             // 0..1, normalized Levenshtein on normalizeLabel(label)
}
export function scoreMergePair(a: MergeSuggestInputItem, b: MergeSuggestInputItem): MergeSuggestion;
/** All unordered active pairs scoring >= minScore, ranked desc. Pure. */
export function suggestMerges(items: ReadonlyArray<MergeSuggestInputItem>, minScore: number): ReadonlyArray<MergeSuggestion>;

// src/mcp/server.ts — handlers (each takes the McpDeps bag added in Plan B):
export function rebindSessionHandler(deps: McpDeps, input: { sessionId?: string; workstream?: string }): Promise<ToolResult>;
export function mergeWorkstreamsHandler(deps: McpDeps, input: { from?: string; into?: string }): Promise<ToolResult>;
export function renameWorkstreamHandler(deps: McpDeps, input: { idOrLabel?: string; label?: string }): Promise<ToolResult>;
export function retireWorkstreamHandler(deps: McpDeps, input: { idOrLabel?: string }): Promise<ToolResult>;
export function listMergeSuggestionsHandler(deps: McpDeps, input: { minScore?: number }): Promise<ToolResult>;
```

**Shared resolution helper (used by every mutating handler — idOrLabel → live survivor `Workstream` | null):** each handler resolves its `idOrLabel`/`from`/`into`/`workstream` arg the same way `recallWorkstreamHandler` (Plan B) does — `getById(arg)` then `findByNormalizedLabel(normalizeLabel(arg))` — then resolves `merged_into` to the live survivor via the `listAll()`-built `byId` map + `resolveWorkstreamId`. Factor this into a small module-private `async function resolveWorkstream(store, idOrLabel): Promise<Workstream | null>` in `server.ts` (one source of truth; `recallWorkstreamHandler` may be refactored to use it but that is optional and out of this plan's required scope). Place it once; all Task 3–6 handlers call it.

---

## Task 1: `setLabel` + `setStatus` store mutators (sqlite + pg parity)

**Files:**
- Modify: `src/ports/workstream-store.ts` (add `setLabel`, `setStatus` to the interface)
- Modify: `src/core/storage/sqlite-workstream-store.ts`
- Modify: `src/core/storage/pg-workstream-store.ts`
- Test: `tests/integration/workstream-lifecycle-store.test.ts`

**Interfaces:**
- Produces: `WorkstreamStore.setLabel(id, label)`, `WorkstreamStore.setStatus(id, status)`.

**Background (verified):** `SqliteWorkstreamStore` (`sqlite-workstream-store.ts:17`) wraps `private readonly db: Database.Database`; `touchLastSession` (`:41`) is the exact pattern — `UPDATE workstreams SET ... , updated_at = datetime('now') WHERE id = ?`. `PgWorkstreamStore` (`pg-workstream-store.ts`) uses `this.pool.query(sql, params)` with `$1` placeholders and `updated_at = NOW()`. `WorkstreamStatus = "active"|"merged"|"retired"` (`model.ts`). There are exactly two `WorkstreamStore` implementors today (sqlite + pg); no test doubles implement the port (the lifecycle tests use a real `SqliteStorage`), so adding methods to the interface forces both real adapters and nothing else.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/workstream-lifecycle-store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wslc-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("WorkstreamStore.setLabel / setStatus", () => {
  it("renames a workstream and bumps updated_at", async () => {
    const ws = await storage.workstreams.create({ id: "ws_1", label: "Old Name" });
    await storage.workstreams.setLabel("ws_1", "New Name");
    const after = await storage.workstreams.getById("ws_1");
    expect(after!.label).toBe("New Name");
    expect(after!.updatedAt >= ws.updatedAt).toBe(true);
  });
  it("retires a workstream by setting status", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Dead" });
    await storage.workstreams.setStatus("ws_1", "retired");
    expect((await storage.workstreams.getById("ws_1"))!.status).toBe("retired");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-lifecycle-store.test.ts`
Expected: FAIL — `setLabel`/`setStatus` not a function (not on the port/impl).

- [ ] **Step 3: Add to the port interface**

In `src/ports/workstream-store.ts`, inside `interface WorkstreamStore`, after `touchLastSession`:
```typescript
  setLabel(id: string, label: string): Promise<void>;
  setStatus(id: string, status: import("@core/workstream/model.js").WorkstreamStatus): Promise<void>;
```

- [ ] **Step 4: Implement in the SQLite adapter**

In `SqliteWorkstreamStore`, after `touchLastSession`:
```typescript
  async setLabel(id: string, label: string): Promise<void> {
    this.db.prepare("UPDATE workstreams SET label = ?, updated_at = datetime('now') WHERE id = ?").run(label, id);
  }

  async setStatus(id: string, status: Workstream["status"]): Promise<void> {
    this.db.prepare("UPDATE workstreams SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }
```

- [ ] **Step 5: Implement in the Postgres adapter (parity)**

In `PgWorkstreamStore`, after `touchLastSession`:
```typescript
  async setLabel(id: string, label: string): Promise<void> {
    await this.pool.query("UPDATE workstreams SET label = $1, updated_at = NOW() WHERE id = $2", [label, id]);
  }

  async setStatus(id: string, status: Workstream["status"]): Promise<void> {
    await this.pool.query("UPDATE workstreams SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);
  }
```

- [ ] **Step 6: Run test + typecheck + commit**

Run: `npx vitest run tests/integration/workstream-lifecycle-store.test.ts && npm run test && npm run typecheck`
Expected: PASS (typecheck confirms both adapters satisfy the widened port and no other implementor exists).

```bash
git add src/ports/workstream-store.ts src/core/storage/sqlite-workstream-store.ts src/core/storage/pg-workstream-store.ts tests/integration/workstream-lifecycle-store.test.ts
git commit -m "feat(workstream): setLabel + setStatus store mutators (#367 §12)"
```

---

## Task 2: `merge` store mutator — supersedence pointer + entity union (sqlite + pg parity)

**Files:**
- Modify: `src/ports/workstream-store.ts` (add `merge`)
- Modify: `src/core/storage/sqlite-workstream-store.ts` (transactional)
- Modify: `src/core/storage/pg-workstream-store.ts` (sequential, parity)
- Test: `tests/integration/workstream-lifecycle-store.test.ts` (extend)

**Interfaces:**
- Consumes: existing `workstream_entities` table (`upsertEntities` shows its shape: `(workstream_id, entity_canonical, session_count)`, PK `(workstream_id, entity_canonical)`).
- Produces: `WorkstreamStore.merge(fromId, intoId)`.

**Background (verified):** `merge` must (1) set `from.merged_into = intoId`, `from.status = "merged"`, bump `updated_at`; (2) union `from`'s `workstream_entities` into `into` — for each `(entity_canonical, session_count)` of `from`, add to `into`'s row (insert or `session_count += from.session_count`); (3) delete `from`'s `workstream_entities` rows (they now live under the survivor; rollup/recall resolve `merged_into` for facts/exemplars so no session rewrite is needed). SQLite has `this.db.transaction(fn)` (used in `upsertEntities`) for atomicity. PG in this codebase does NOT use transactions (each `pool.query` is independent) — match that style: run the statements sequentially in fail-safe order (pointer first, then entity union, then delete), so a mid-failure still leaves `merged_into` correct (resolution works) with at worst a stale duplicate entity row (a derived index, self-heals on next sweep). Document this ordering in a comment.

- [ ] **Step 1: Write the failing test (extend the store test file)**

```typescript
// append to tests/integration/workstream-lifecycle-store.test.ts
describe("WorkstreamStore.merge", () => {
  it("points from->into, marks merged, and unions entities", async () => {
    await storage.workstreams.create({ id: "ws_from", label: "Dup" });
    await storage.workstreams.create({ id: "ws_into", label: "Keep" });
    await storage.workstreams.upsertEntities("ws_from", ["alpha", "shared"]);
    await storage.workstreams.upsertEntities("ws_into", ["shared", "beta"]);

    await storage.workstreams.merge("ws_from", "ws_into");

    const from = await storage.workstreams.getById("ws_from");
    expect(from!.mergedInto).toBe("ws_into");
    expect(from!.status).toBe("merged");

    const ents = await storage.workstreams.entitiesFor(["ws_into", "ws_from"]);
    const into = (ents.get("ws_into") ?? []).sort();
    expect(into).toEqual(["alpha", "beta", "shared"]); // union, deduped by PK
    expect(ents.get("ws_from") ?? []).toEqual([]);     // from's entity rows cleared

    // The non-obvious UPSERT branch: the shared entity's session_count must SUM (from 1 + into 1 = 2),
    // not overwrite. entitiesFor returns names only, so assert the count directly via the raw db.
    const sharedCount = storage.sessions.rawDb()
      .prepare("SELECT session_count FROM workstream_entities WHERE workstream_id = ? AND entity_canonical = ?")
      .get("ws_into", "shared") as { session_count: number };
    expect(sharedCount.session_count).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-lifecycle-store.test.ts -t "merge"`
Expected: FAIL — `merge` not a function.

- [ ] **Step 3: Add `merge` to the port**

In `src/ports/workstream-store.ts`, after `setStatus`:
```typescript
  /** Supersede fromId into intoId: set merged_into + status="merged", union entities, clear from's entity rows. */
  merge(fromId: string, intoId: string): Promise<void>;
```

- [ ] **Step 4: Implement in the SQLite adapter (transactional)**

In `SqliteWorkstreamStore`, after `setStatus`:
```typescript
  async merge(fromId: string, intoId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "UPDATE workstreams SET merged_into = ?, status = 'merged', updated_at = datetime('now') WHERE id = ?",
      ).run(intoId, fromId);
      // Union from's entities into into (sum session_count on PK conflict).
      this.db.prepare(`
        INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
        SELECT ?, entity_canonical, session_count FROM workstream_entities WHERE workstream_id = ?
        ON CONFLICT(workstream_id, entity_canonical)
        DO UPDATE SET session_count = session_count + excluded.session_count
      `).run(intoId, fromId);
      this.db.prepare("DELETE FROM workstream_entities WHERE workstream_id = ?").run(fromId);
    });
    tx();
  }
```

- [ ] **Step 5: Implement in the Postgres adapter (sequential, fail-safe order)**

In `PgWorkstreamStore`, after `setStatus`:
```typescript
  async merge(fromId: string, intoId: string): Promise<void> {
    // Pointer first (source of truth for resolution), then derived entity union, then clear.
    // No multi-statement transaction here to match this adapter's per-query style; a mid-failure
    // leaves merged_into correct (resolution works) with at worst a stale duplicate entity row.
    await this.pool.query(
      "UPDATE workstreams SET merged_into = $1, status = 'merged', updated_at = NOW() WHERE id = $2",
      [intoId, fromId],
    );
    await this.pool.query(
      `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
       SELECT $1, entity_canonical, session_count FROM workstream_entities WHERE workstream_id = $2
       ON CONFLICT (workstream_id, entity_canonical)
       DO UPDATE SET session_count = workstream_entities.session_count + excluded.session_count`,
      [intoId, fromId],
    );
    await this.pool.query("DELETE FROM workstream_entities WHERE workstream_id = $1", [fromId]);
  }
```

- [ ] **Step 6: Run test + typecheck + commit**

Run: `npx vitest run tests/integration/workstream-lifecycle-store.test.ts && npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/ports/workstream-store.ts src/core/storage/sqlite-workstream-store.ts src/core/storage/pg-workstream-store.ts tests/integration/workstream-lifecycle-store.test.ts
git commit -m "feat(workstream): merge store mutator — supersedence pointer + entity union (#367 §12)"
```

---

## Task 3: `rebind_session` MCP tool + handler + CLI

**Files:**
- Modify: `src/mcp/server.ts` (`resolveWorkstream` helper + `rebindSessionHandler` + register tool)
- Modify: `src/cli/nlm.ts` (`nlm rebind-session` command)
- Test: `tests/integration/workstream-lifecycle-mcp.test.ts`

**Interfaces:**
- Consumes: `SessionStore.setWorkstreamBinding` (Plan A), `McpDeps.workstreams.store` (Plan B), the new `resolveWorkstream` helper.
- Produces: `rebindSessionHandler`, the `rebind_session` tool, `nlm rebind-session`.

**Background (verified):** Rebind needs no new store method — `SessionStore.setWorkstreamBinding(sessionId, workstreamId, "operator", null)` (`session-store.ts:86`) sets the binding with operator provenance and null confidence (manual binding has no match score). `McpDeps.store` is a `SessionStore` (has `setWorkstreamBinding`). `McpDeps.workstreams.store` is a `WorkstreamStore` (for resolving the target). Handlers follow the `recallWorkstreamHandler` shape (Plan B): unavailable-guard returns `okText(...)`; resolution is `getById` → `findByNormalizedLabel(normalizeLabel(...))`. Tool registration mirrors `mark_superseded` (`server.ts:632` area) but with `readOnlyHint: false`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/workstream-lifecycle-mcp.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import {
  rebindSessionHandler, mergeWorkstreamsHandler, renameWorkstreamHandler,
  retireWorkstreamHandler, listMergeSuggestionsHandler,
} from "../../src/mcp/server.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-lcmcp-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

function deps() {
  return {
    recall: {} as never, store: storage.sessions,
    workstreams: { store: storage.workstreams, sessions: storage.sessions, facts: storage.facts, exemplars: storage.exemplars },
  } as never;
}

describe("rebind_session handler", () => {
  it("binds a session to a workstream with operator provenance", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    const r = await rebindSessionHandler(deps(), { sessionId: "s1", workstream: "NLM" });
    expect(r.isError).not.toBe(true);
    const ids = await storage.sessions.getWorkstreamIds(["s1"]);
    expect(ids.get("s1")).toBe("ws_1");
  });
  it("returns a graceful message when the workstream is unknown", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    const r = await rebindSessionHandler(deps(), { sessionId: "s1", workstream: "Nope" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });
  it("returns unavailable when workstreams deps are not wired", async () => {
    const r = await rebindSessionHandler({ recall: {}, store: storage.sessions } as never, { sessionId: "s1", workstream: "NLM" });
    expect(r.content[0]!.text.toLowerCase()).toContain("not available");
  });
});
```

(Verify `getWorkstreamIds` returns a `Map<string, string|null>` — Plan A added it on `SessionStore`. If its name/shape differs, query the binding via `listByDateRange` projection (`Session.workstreamId`, added in Plan B) instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "rebind_session"`
Expected: FAIL — `rebindSessionHandler` not exported.

- [ ] **Step 3: Add the shared `resolveWorkstream` helper + `rebindSessionHandler` in `server.ts`**

Near `recallWorkstreamHandler` (Plan B), add the module-private helper once:
```typescript
import { resolveWorkstreamId } from "@core/workstream/resolve.js";
import { normalizeLabel } from "@core/workstream/model.js";
import type { Workstream } from "@core/workstream/model.js";

/** idOrLabel -> live survivor workstream (merged_into resolved) | null. One source of truth for lifecycle handlers. */
async function resolveWorkstream(
  store: import("@ports/workstream-store.js").WorkstreamStore,
  idOrLabel: string,
): Promise<Workstream | null> {
  const found = (await store.getById(idOrLabel)) ?? (await store.findByNormalizedLabel(normalizeLabel(idOrLabel)));
  if (!found) return null;
  const all = await store.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const survivorId = resolveWorkstreamId(found.id, byId);
  return survivorId === found.id ? found : (await store.getById(survivorId)) ?? found;
}
```
Then the handler:
```typescript
export async function rebindSessionHandler(
  deps: McpDeps,
  input: { sessionId?: string; workstream?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rebind_session is not available in this deployment.");
  try {
    const sessionId = (input.sessionId ?? "").trim();
    const wsArg = (input.workstream ?? "").trim();
    if (!sessionId || !wsArg) return okText("Provide both a sessionId and a workstream (id or label).");
    const ws = await resolveWorkstream(deps.workstreams.store, wsArg);
    if (!ws) return okText(`No workstream matches "${wsArg}".`);
    await deps.store.setWorkstreamBinding(sessionId, ws.id, "operator", null);
    return okText(`Rebound session ${sessionId} -> workstream "${ws.label}" (${ws.id}).`);
  } catch (e) {
    return err(e);
  }
}
```

- [ ] **Step 4: Register the `rebind_session` tool**

In `createMcpServer`, near the supersede-tool registrations:
```typescript
server.registerTool(
  "rebind_session",
  {
    title: "Rebind a session to a different workstream",
    description: "Move a session's primary workstream binding (operator correction). Sets binding_source=operator. The session's facts and exemplars roll up under the new workstream automatically (rollup is by session binding).",
    inputSchema: {
      sessionId: z.string().describe("Session id to rebind."),
      workstream: z.string().describe("Target workstream id (ws_...) or label."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => rebindSessionHandler(deps, args) as never,
);
```

- [ ] **Step 5: Run the handler test to verify it passes**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "rebind_session"`
Expected: PASS.

- [ ] **Step 6: Add the `nlm rebind-session` CLI command**

In `src/cli/nlm.ts`, mirror the `recall-workstream` command (Plan B) — import the handler from `../mcp/server.js` and construct the same deps shape:
```typescript
program
  .command("rebind-session")
  .description("Rebind a session to a workstream (operator correction)")
  .argument("<sessionId>", "session id")
  .argument("<workstream>", "target workstream id or label")
  .action(async (sessionId, workstream) => {
    const { storage, store } = await buildStack();
    try {
      const r = await rebindSessionHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { sessionId, workstream },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });
```
(If Plan B already imports `recallWorkstreamHandler` from `../mcp/server.js`, add `rebindSessionHandler` to that same import.)

- [ ] **Step 7: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/mcp/server.ts src/cli/nlm.ts tests/integration/workstream-lifecycle-mcp.test.ts
git commit -m "feat(workstream): rebind_session MCP tool + CLI (#367 §12)"
```

---

## Task 4: `merge_workstreams` MCP tool + handler + CLI

**Files:**
- Modify: `src/mcp/server.ts` (`mergeWorkstreamsHandler` + register tool)
- Modify: `src/cli/nlm.ts` (`nlm merge-workstreams` command)
- Test: `tests/integration/workstream-lifecycle-mcp.test.ts` (extend)

**Interfaces:**
- Consumes: `WorkstreamStore.merge` (Task 2), `resolveWorkstream` (Task 3).
- Produces: `mergeWorkstreamsHandler`, the `merge_workstreams` tool, `nlm merge-workstreams`.

**Background (verified):** The handler resolves BOTH `from` and `into` through `resolveWorkstream` (so merging an already-merged id folds into its survivor). Guards: both must resolve; after resolution `from.id !== into.id` (self-merge / already-same-survivor is a graceful no-op message, not an error). On success call `deps.workstreams.store.merge(from.id, into.id)`. Audit trail is the `merged_into` pointer + `status="merged"` (assert in the test).

- [ ] **Step 1: Write the failing test (extend)**

```typescript
// append to tests/integration/workstream-lifecycle-mcp.test.ts
describe("merge_workstreams handler", () => {
  it("merges from into into and resolves the chain", async () => {
    await storage.workstreams.create({ id: "ws_from", label: "Dup" });
    await storage.workstreams.create({ id: "ws_into", label: "Keep" });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Dup", into: "Keep" });
    expect(r.isError).not.toBe(true);
    const from = await storage.workstreams.getById("ws_from");
    expect(from!.mergedInto).toBe("ws_into");
    expect(from!.status).toBe("merged");
  });
  it("refuses to merge a workstream into itself", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Solo" });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Solo", into: "Solo" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("same workstream");
    expect((await storage.workstreams.getById("ws_1"))!.mergedInto).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "merge_workstreams"`
Expected: FAIL — `mergeWorkstreamsHandler` not exported.

- [ ] **Step 3: Add `mergeWorkstreamsHandler` in `server.ts`**

```typescript
export async function mergeWorkstreamsHandler(
  deps: McpDeps,
  input: { from?: string; into?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("merge_workstreams is not available in this deployment.");
  try {
    const fromArg = (input.from ?? "").trim();
    const intoArg = (input.into ?? "").trim();
    if (!fromArg || !intoArg) return okText("Provide both `from` and `into` (workstream id or label).");
    const ws = deps.workstreams.store;
    const from = await resolveWorkstream(ws, fromArg);
    const into = await resolveWorkstream(ws, intoArg);
    if (!from) return okText(`No workstream matches "${fromArg}".`);
    if (!into) return okText(`No workstream matches "${intoArg}".`);
    if (from.id === into.id) return okText(`"${fromArg}" and "${intoArg}" resolve to the same workstream — nothing to merge.`);
    await ws.merge(from.id, into.id);
    return okText(`Merged "${from.label}" (${from.id}) into "${into.label}" (${into.id}).`);
  } catch (e) {
    return err(e);
  }
}
```

- [ ] **Step 4: Register the `merge_workstreams` tool**

```typescript
server.registerTool(
  "merge_workstreams",
  {
    title: "Merge one workstream into another",
    description: "Supersede a duplicate workstream into the one to keep: sets merged_into, marks it merged, and unions its entity index. Sessions, facts, and exemplars resolve to the survivor automatically (no session rewrite). Accepts ids or labels; merge chains resolve.",
    inputSchema: {
      from: z.string().describe("Workstream to retire (the duplicate); id or label."),
      into: z.string().describe("Workstream to keep (the survivor); id or label."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args) => mergeWorkstreamsHandler(deps, args) as never,
);
```

- [ ] **Step 5: Run handler test to verify it passes**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "merge_workstreams"`
Expected: PASS.

- [ ] **Step 6: Add the `nlm merge-workstreams` CLI command**

```typescript
program
  .command("merge-workstreams")
  .description("Merge a duplicate workstream into the one to keep")
  .argument("<from>", "duplicate workstream id or label")
  .argument("<into>", "survivor workstream id or label")
  .action(async (from, into) => {
    const { storage, store } = await buildStack();
    try {
      const r = await mergeWorkstreamsHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { from, into },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });
```
(Add `mergeWorkstreamsHandler` to the existing `../mcp/server.js` import.)

- [ ] **Step 7: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/mcp/server.ts src/cli/nlm.ts tests/integration/workstream-lifecycle-mcp.test.ts
git commit -m "feat(workstream): merge_workstreams MCP tool + CLI (#367 §12)"
```

---

## Task 5: `rename_workstream` + `retire_workstream` MCP tools + CLI

**Files:**
- Modify: `src/mcp/server.ts` (`renameWorkstreamHandler`, `retireWorkstreamHandler` + register both)
- Modify: `src/cli/nlm.ts` (`nlm rename-workstream`, `nlm retire-workstream`)
- Test: `tests/integration/workstream-lifecycle-mcp.test.ts` (extend)

**Interfaces:**
- Consumes: `WorkstreamStore.setLabel`/`setStatus` (Task 1), `resolveWorkstream` (Task 3).
- Produces: `renameWorkstreamHandler`, `retireWorkstreamHandler`, the two tools, the two CLI commands.

**Background (verified):** Rename resolves the target, then guards against a normalized-label collision with a DIFFERENT existing workstream (renaming "NLM" to a name that normalizes onto another workstream's label is a graceful refusal — prevents an accidental case/spacing duplicate; renaming to a label that normalizes to itself is allowed, e.g. fixing casing). Retire resolves the target and calls `setStatus(id, "retired")`. Both are operator corrections (`binding_source` not involved). `findByNormalizedLabel(normalizeLabel(newLabel))` returns the colliding workstream or null.

- [ ] **Step 1: Write the failing test (extend)**

```typescript
// append to tests/integration/workstream-lifecycle-mcp.test.ts
describe("rename_workstream + retire_workstream handlers", () => {
  it("renames a workstream", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Old" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "New" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("New");
  });
  it("refuses a rename that collides with a different workstream's normalized label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Alpha" });
    await storage.workstreams.create({ id: "ws_2", label: "Beta" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "  beta " });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("already");
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("Alpha"); // unchanged
  });
  it("retires a workstream", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Dead" });
    const r = await retireWorkstreamHandler(deps(), { idOrLabel: "Dead" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.status).toBe("retired");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "rename_workstream"`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Add both handlers in `server.ts`**

```typescript
export async function renameWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string; label?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rename_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    const label = (input.label ?? "").trim();
    if (!idOrLabel || !label) return okText("Provide the workstream (id or label) and the new label.");
    const ws = deps.workstreams.store;
    const target = await resolveWorkstream(ws, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    const collision = await ws.findByNormalizedLabel(normalizeLabel(label));
    if (collision && collision.id !== target.id) {
      return okText(`Label "${label}" is already used by workstream "${collision.label}" (${collision.id}).`);
    }
    await ws.setLabel(target.id, label);
    return okText(`Renamed workstream ${target.id}: "${target.label}" -> "${label}".`);
  } catch (e) {
    return err(e);
  }
}

export async function retireWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("retire_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const target = await resolveWorkstream(deps.workstreams.store, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    await deps.workstreams.store.setStatus(target.id, "retired");
    return okText(`Retired workstream "${target.label}" (${target.id}).`);
  } catch (e) {
    return err(e);
  }
}
```

- [ ] **Step 4: Register both tools**

```typescript
server.registerTool(
  "rename_workstream",
  {
    title: "Rename a workstream",
    description: "Relabel a workstream. Refuses a label that collides with a different existing workstream's normalized label (prevents accidental duplicates). Accepts id or label.",
    inputSchema: {
      idOrLabel: z.string().describe("Workstream id or current label."),
      label: z.string().describe("New label."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => renameWorkstreamHandler(deps, args) as never,
);
server.registerTool(
  "retire_workstream",
  {
    title: "Retire a workstream",
    description: "Mark a workstream retired (status=retired). Operator cleanup for dead one-off workstreams. Reversible by re-setting status. Accepts id or label.",
    inputSchema: { idOrLabel: z.string().describe("Workstream id or label.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => retireWorkstreamHandler(deps, args) as never,
);
```

- [ ] **Step 5: Run handler test to verify it passes**

Run: `npx vitest run tests/integration/workstream-lifecycle-mcp.test.ts -t "rename_workstream"`
Expected: PASS.

- [ ] **Step 6: Add the two CLI commands**

```typescript
program
  .command("rename-workstream")
  .description("Rename a workstream")
  .argument("<idOrLabel>", "workstream id or current label")
  .argument("<label>", "new label")
  .action(async (idOrLabel, label) => {
    const { storage, store } = await buildStack();
    try {
      const r = await renameWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel, label },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally { await storage.close(); }
  });

program
  .command("retire-workstream")
  .description("Retire (mark dead) a workstream")
  .argument("<idOrLabel>", "workstream id or label")
  .action(async (idOrLabel) => {
    const { storage, store } = await buildStack();
    try {
      const r = await retireWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally { await storage.close(); }
  });
```
(Add both handlers to the existing `../mcp/server.js` import.)

- [ ] **Step 7: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/mcp/server.ts src/cli/nlm.ts tests/integration/workstream-lifecycle-mcp.test.ts
git commit -m "feat(workstream): rename_workstream + retire_workstream MCP tools + CLI (#367 §12)"
```

---

## Task 6: Merge-suggestion scorer (pure) + `list_merge_suggestions` MCP tool

**Files:**
- Create: `src/core/workstream/merge-suggest.ts`
- Create: `tests/unit/core/workstream/merge-suggest.test.ts`
- Modify: `src/mcp/server.ts` (`listMergeSuggestionsHandler` + register tool)
- Modify: `src/cli/nlm.ts` (`nlm merge-suggestions` command)
- Test: `tests/integration/workstream-lifecycle-mcp.test.ts` (extend with a suggest case)

**Interfaces:**
- Consumes: `WorkstreamStore.{listAll,entitiesFor}` + `SessionStore.listSessionIdsByWorkstreams` (Plan A), `normalizeLabel` (Plan A).
- Produces: `scoreMergePair`, `suggestMerges` (pure), `listMergeSuggestionsHandler`, the `list_merge_suggestions` tool, `nlm merge-suggestions`.

**Background + scoping decision (verified):** Spec §7 describes a low-frequency *scheduler* pass writing high-similarity pairs to a "merge-suggestion surface." This plan ships the suggestion as an **on-demand computed MCP tool** — NO new table and NO scheduler wiring. Rationale (YAGNI + asymmetry): the operator value (see candidate dup pairs → one-click `merge_workstreams`) is delivered identically by computing pairs live from `listAll` + `entitiesFor`, and the workstream set is small (operator-meaningful, dozens not thousands), so a live O(n²) pair scan is cheap. Persisting suggestions + a scheduler is added later only if the live scan proves too slow or the operator wants a standing queue — which there is no evidence of today. **This is a deliberate departure from the spec's "scheduler" wording, flagged here for the critical-review and the reviewer to adjudicate.** The score combines three normalized signals: shared-entity Jaccard, shared-session Jaccard, and label similarity (1 − normalized Levenshtein on `normalizeLabel(label)`), averaged. Only `active` workstreams are paired (merged/retired excluded).

- [ ] **Step 1: Write the failing unit test**

```typescript
// tests/unit/core/workstream/merge-suggest.test.ts
import { describe, expect, it } from "vitest";
import { scoreMergePair, suggestMerges } from "../../../../src/core/workstream/merge-suggest.js";

const item = (id: string, label: string, entities: string[], sessionIds: string[]) => ({ id, label, entities, sessionIds });

describe("scoreMergePair", () => {
  it("scores identical-entity, similar-label pairs high", () => {
    const s = scoreMergePair(item("a", "NLM Memory", ["x", "y"], ["s1"]), item("b", "nlm-memory", ["x", "y"], ["s2"]));
    expect(s.sharedEntities).toBe(2);
    expect(s.labelSimilarity).toBeGreaterThan(0.5);
    expect(s.score).toBeGreaterThan(0.5);
  });
  it("scores disjoint pairs low", () => {
    const s = scoreMergePair(item("a", "Alpha", ["x"], ["s1"]), item("b", "Beta", ["z"], ["s2"]));
    expect(s.sharedEntities).toBe(0);
    expect(s.score).toBeLessThan(0.3);
  });
});

describe("suggestMerges", () => {
  it("returns only pairs at or above minScore, ranked desc, each pair once", () => {
    const items = [
      item("a", "NLM", ["x", "y"], ["s1"]),
      item("b", "NLM Memory", ["x", "y"], ["s1"]),
      item("c", "Totally Other", ["q"], ["s9"]),
    ];
    const out = suggestMerges(items, 0.3);
    expect(out.length).toBe(1);              // only a/b clears the bar
    expect(new Set([out[0]!.aId, out[0]!.bId])).toEqual(new Set(["a", "b"]));
    expect(out[0]!.score).toBeGreaterThanOrEqual(0.3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/merge-suggest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `merge-suggest.ts`**

```typescript
// src/core/workstream/merge-suggest.ts
import { normalizeLabel } from "./model.js";

export interface MergeSuggestInputItem {
  readonly id: string;
  readonly label: string;
  readonly entities: ReadonlyArray<string>;
  readonly sessionIds: ReadonlyArray<string>;
}

export interface MergeSuggestion {
  readonly aId: string; readonly aLabel: string;
  readonly bId: string; readonly bLabel: string;
  readonly score: number;
  readonly sharedEntities: number;
  readonly sharedSessions: number;
  readonly labelSimilarity: number;
}

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): { shared: number; score: number } {
  const sa = new Set(a); const sb = new Set(b);
  let shared = 0;
  for (const x of sa) if (sb.has(x)) shared++;
  const union = sa.size + sb.size - shared;
  return { shared, score: union === 0 ? 0 : shared / union };
}

function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a); const nb = normalizeLabel(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export function scoreMergePair(a: MergeSuggestInputItem, b: MergeSuggestInputItem): MergeSuggestion {
  const ent = jaccard(a.entities, b.entities);
  const sess = jaccard(a.sessionIds, b.sessionIds);
  const lab = labelSimilarity(a.label, b.label);
  const score = (ent.score + sess.score + lab) / 3;
  return {
    aId: a.id, aLabel: a.label, bId: b.id, bLabel: b.label,
    score, sharedEntities: ent.shared, sharedSessions: sess.shared, labelSimilarity: lab,
  };
}

/** All unordered pairs scoring >= minScore, ranked desc. Pure; O(n^2) over the (small) workstream set. */
export function suggestMerges(items: ReadonlyArray<MergeSuggestInputItem>, minScore: number): ReadonlyArray<MergeSuggestion> {
  const out: MergeSuggestion[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = scoreMergePair(items[i]!, items[j]!);
      if (s.score >= minScore) out.push(s);
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `npx vitest run tests/unit/core/workstream/merge-suggest.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `listMergeSuggestionsHandler` in `server.ts`**

```typescript
import { suggestMerges } from "@core/workstream/merge-suggest.js";

export async function listMergeSuggestionsHandler(
  deps: McpDeps,
  input: { minScore?: number },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("list_merge_suggestions is not available in this deployment.");
  try {
    const minScore = typeof input.minScore === "number" ? input.minScore : 0.5;
    const all = (await deps.workstreams.store.listAll()).filter((w) => w.status === "active");
    if (all.length < 2) return okText("Not enough active workstreams to suggest merges.");
    const ids = all.map((w) => w.id);
    const entMap = await deps.workstreams.store.entitiesFor(ids);
    const items = await Promise.all(
      all.map(async (w) => ({
        id: w.id, label: w.label,
        entities: entMap.get(w.id) ?? [],
        sessionIds: await deps.workstreams!.sessions.listSessionIdsByWorkstreams([w.id]),
      })),
    );
    const suggestions = suggestMerges(items, minScore);
    if (suggestions.length === 0) return okText(`No merge suggestions at or above score ${minScore}.`);
    const lines = ["MERGE SUGGESTIONS:"];
    for (const s of suggestions) {
      lines.push(`  - ${(s.score).toFixed(2)}  "${s.aLabel}" (${s.aId}) ~ "${s.bLabel}" (${s.bId})  [entities ${s.sharedEntities}, sessions ${s.sharedSessions}, label ${(s.labelSimilarity).toFixed(2)}]`);
    }
    lines.push("", "Merge a pair with: merge_workstreams(from, into).");
    return okText(lines.join("\n"));
  } catch (e) {
    return err(e);
  }
}
```
(Confirm `deps.workstreams.sessions` includes `listSessionIdsByWorkstreams` — the Plan B `McpDeps.workstreams.sessions` is `Pick<SessionStore, "listSessionIdsByWorkstreams">`, so it does.)

- [ ] **Step 6: Register the tool + add the integration suggest case + CLI command**

Register:
```typescript
server.registerTool(
  "list_merge_suggestions",
  {
    title: "Suggest duplicate workstreams to merge",
    description: "Score active workstream pairs by shared entities, co-occurring sessions, and label similarity; list likely duplicates for one-click merge_workstreams. Computed on demand; read-only.",
    inputSchema: { minScore: z.number().optional().describe("Minimum similarity score 0..1 (default 0.5).") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => listMergeSuggestionsHandler(deps, args) as never,
);
```
Integration case (append to `tests/integration/workstream-lifecycle-mcp.test.ts`):
```typescript
describe("list_merge_suggestions handler", () => {
  it("suggests a near-duplicate active pair", async () => {
    await storage.workstreams.create({ id: "ws_a", label: "NLM" });
    await storage.workstreams.create({ id: "ws_b", label: "NLM Memory" });
    await storage.workstreams.upsertEntities("ws_a", ["alpha", "beta"]);
    await storage.workstreams.upsertEntities("ws_b", ["alpha", "beta"]);
    const r = await listMergeSuggestionsHandler(deps(), { minScore: 0.2 });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toContain("ws_a");
    expect(r.content[0]!.text).toContain("ws_b");
  });
});
```
CLI:
```typescript
program
  .command("merge-suggestions")
  .description("List likely-duplicate workstreams to merge")
  .option("-m, --min-score <n>", "minimum similarity score 0..1", "0.5")
  .action(async (opts) => {
    const { storage, store } = await buildStack();
    try {
      const r = await listMergeSuggestionsHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { minScore: Number(opts.minScore) },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally { await storage.close(); }
  });
```
(Add `listMergeSuggestionsHandler` to the existing `../mcp/server.js` import.)

- [ ] **Step 7: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/core/workstream/merge-suggest.ts src/mcp/server.ts src/cli/nlm.ts tests/unit/core/workstream/merge-suggest.test.ts tests/integration/workstream-lifecycle-mcp.test.ts
git commit -m "feat(workstream): merge-suggestion scorer + list_merge_suggestions tool (#367 §7)"
```

---

## Self-Review

**1. Spec coverage (Plan C scope):**
- §12 `rebind_session` (atomic; reuse `setWorkstreamBinding` operator) → Task 3 ✓
- §12 `merge_workstreams` (set `merged_into`, union `workstream_entities`, chain resolves) → Tasks 2 (store) + 4 (tool) ✓
- §12 `rename_workstream` → Tasks 1 (store) + 5 (tool) ✓
- §12 `retire` (operator-only status) → Tasks 1 (store) + 5 (tool) ✓
- §12 `split` = bulk `rebind_session`, "no new primitive" → covered by Task 3 (call rebind N times); NO separate tool, documented here. ✓
- §12 "Exposed as MCP tools alongside the existing supersede tools" → all five registered next to `mark_superseded`/`supersede_fact` ✓
- §7 merge-suggestion (shared entities + co-occurring sessions + label edit-distance) → Task 6 ✓ (shipped on-demand, NOT as a scheduler/persisted surface — deliberate scoping departure flagged for review)
- Merge-chain resolution everywhere (§8/§12): `resolveWorkstream` helper resolves `merged_into` before every mutation → Tasks 3–6 ✓
- Deferred correctly (NOT Plan C): seed/backfill/flip + gold set + threshold tuning (Plan D); v2 start-side binding (§14). ✓

**2. Placeholder scan:** every code step contains complete code. Two verification asides are deliberate, not hidden TODOs: Task 3 Step 1 notes "verify `getWorkstreamIds` shape" (Plan A method, confirm before asserting); Task 6 Step 5 notes "confirm `deps.workstreams.sessions` has `listSessionIdsByWorkstreams`" (it does, per the Plan B `Pick` type). Both are read-confirm-then-proceed, with a stated fallback.

**3. Type consistency:** `setLabel`/`setStatus`/`merge` (port + both adapters), `resolveWorkstream` helper, the five handler signatures, `MergeSuggestInputItem`/`MergeSuggestion`/`scoreMergePair`/`suggestMerges` are defined once in Canonical Contracts and referenced unchanged. Handlers reuse the Plan B `McpDeps.workstreams` slice (no new deps field). Rebind reuses `SessionStore.setWorkstreamBinding` (no new session-store method). `WorkstreamStatus` values (`active`/`merged`/`retired`) match `model.ts`.

**Cross-plan notes:**
- No schema migration: every column used (`label`, `status`, `merged_into`, `workstream_entities`, `sessions.workstream_id/binding_source/binding_confidence`) exists from Plan A. So no `migrations/` or `pg/` delta, and no fresh-install `pg/001` edit.
- Lifecycle is operator-only and hot-path-free (spec §16) — no daemon-sweep code changes, so no mid-branch `build:server`/daemon-restart. The daemon still gets one rebuild+restart after Plan C merges + is pushed (so the running MCP server exposes the five new tools), deferred per the repo rule (never run the live daemon on unpushed/feature-branch dist).
- Merge-suggestion on-demand vs scheduler: the single intentional spec departure; if the reviewer or Edward wants the persisted-surface + scheduler form, that becomes a follow-up task, not a blocker for the operator-facing capability.
