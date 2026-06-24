# Workstream Surfacing (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the workstream abstraction (built in Plan A) through the read paths — a new `recall_workstream(idOrLabel)` that returns a coherent project view, a work-digest topic provider that attributes time to workstream labels instead of the alphabetically-first entity, a stable `workstream_id` exposed on digest/recall outputs for an external telemetry layer, and an optional `workstream` filter on `recall_sessions`.

**Architecture:** Plan A's `rollupWorkstream(deps, workstreamId)` and `resolveWorkstreamId` already exist; Plan B wires them to the MCP/CLI surface and the work-digest. The work-digest gains a workstream-aware topic provider by threading `sessions.workstream_id` onto the `listByDateRange` projection and resolving it to a label inside `buildWorkDigest`. Telemetry is exactly one thing: a `workstream_id` on `byTopic[].meta` and on the recall_workstream output. No new external-telemetry concept enters NLM core (spec §11).

**Tech Stack:** TypeScript (ESM, `@core`/`@ports` aliases), better-sqlite3 + sqlite-vec (live runtime), Postgres + pgvector (parity-only), `@modelcontextprotocol/sdk` (MCP, Zod input schemas), `commander` (CLI), vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md` (§9 recall, §10 work-digest, §11 telemetry). This plan implements Plan B (SURFACING). Plans A (foundation) is merged; C (lifecycle) and D (seed/backfill/flip) are separate.
- **Builds on Plan A (present at branch base):** `src/core/workstream/{model,resolve,rollup}.ts`, `WorkstreamStore` port + sqlite/pg adapters, `SessionStore.{getWorkstreamIds,listSessionIdsByWorkstreams,setWorkstreamBinding}`, `FactStore.listBySessions`, `CodeExemplarStore.listBySessions`, `storage.workstreams`.
- **TDD always:** failing test → run-it-fails → minimal impl → green → commit. `npm run test` + `npm run typecheck` pass before every commit.
- **SQLite + Postgres parity:** every store change ships in both adapters. SQLite is the verified runtime (`~/.nlm/canonical.sqlite`); PG is parity-only.
- **Merge-chain resolution everywhere:** any workstream lookup resolves `merged_into` to the live survivor via `resolveWorkstreamId` before querying (spec §9). `rollupWorkstream` already does this internally.
- **Read-only / fail-soft:** all new surface is read-only (`readOnlyHint: true`). A workstream lookup that finds nothing returns a graceful "not found" message, never an error that breaks the caller.
- **Telemetry is exactly `workstream_id`:** spec §11 — expose a stable `workstream_id` on digest (`byTopic[].meta.workstream_id`) and on recall_workstream output. Add no other external-telemetry concept to core.
- **Behavior-neutral for unbound sessions:** the work-digest fallback (alias-map / first-entity) must keep working for sessions with `workstream_id = NULL` during rollout. Binding is still flag-gated off until Plan D, so in practice almost all sessions are unbound today — the swap must not blank the digest.
- **Daemon code change:** the work-digest deps wiring touches `src/cli/nlm.ts` (daemon). After Plan B merges, rebuild dist + restart the daemon so running config matches source-of-truth (post-merge, not during the plan).

---

## File Structure

**New:**
- `src/core/workstream/compose-recall.ts` — `composeWorkstreamRecall(view)`: pure markdown formatter for the recall_workstream output (mirrors `compose-work-digest.ts`).
- `tests/unit/core/workstream/compose-recall.test.ts`
- `tests/integration/recall-workstream-mcp.test.ts`
- `tests/unit/core/work-digest/workstream-topic.test.ts`

**Modified:**
- `src/shared/types.ts` — `Session` gains optional `workstreamId?: string | null`; `RecallQuery` gains optional `workstream?: string`.
- `src/core/storage/sqlite-session-store.ts` + `pg-session-store.ts` — `listByDateRange` SELECT adds `workstream_id`; `SessionRow` gains `workstream_id`; `rowToSession` threads `workstreamId`.
- `src/core/work-digest/topics.ts` — `TopicInput` gains `workstreamLabel?: string`; new `workstreamTopicProvider(fallback)`.
- `src/core/work-digest/build-work-digest.ts` — `BuildWorkDigestDeps` gains optional `workstreams`; resolve each session's `workstreamId` → label; pass `workstreamLabel` into the provider; thread `workstreamId` into `SessionActivity`.
- `src/core/work-digest/types.ts` — (uses existing `TopicShare.meta`; no type change, just populate it).
- `src/core/work-digest/attribute.ts` — set `meta.workstream_id` on `byTopic` entries from the winning session's `workstreamId`.
- `src/core/work-digest/build-work-digest.ts` (SessionActivity) — `SessionActivity` gains `workstreamId?: string | null`.
- `src/mcp/server.ts` — `McpDeps` gains optional `workstreams` (RollupDeps + WorkstreamStore); `recallWorkstreamHandler`; register `recall_workstream` tool; `recall_sessions` schema/handler gain `workstream`.
- `src/core/recall/recall-service.ts` — apply optional `workstream` filter (resolve → allowed session-id set) at the existing entity/kind filter point.
- `src/cli/nlm.ts` — wire `workstreams: storage.workstreams` into the 3 work-digest deps sites; add `nlm recall-workstream <idOrLabel>` command; thread `workstreams` into the 2 `createMcpServer`/`mcpDeps` sites; add `--workstream` option on `nlm recall`.

---

## Canonical Contracts (defined once; every task uses these names)

```typescript
// src/shared/types.ts — Session gains (optional, like supersedes/supersededBy — populated by projections that select it):
readonly workstreamId?: string | null;

// src/shared/types.ts — RecallQuery gains:
readonly workstream?: string;   // idOrLabel; filter to sessions whose resolved workstream matches

// src/core/work-digest/topics.ts — TopicInput gains:
readonly workstreamLabel?: string;   // resolved live-workstream label, when the session is bound

// New provider (topics.ts):
export function workstreamTopicProvider(fallback: TopicProvider): TopicProvider;
// returns (input) => input.workstreamLabel && input.workstreamLabel.trim() ? input.workstreamLabel : fallback(input)

// src/core/work-digest/build-work-digest.ts — BuildWorkDigestDeps gains:
readonly workstreams?: Pick<import("@ports/workstream-store.js").WorkstreamStore, "listAll">;
// SessionActivity gains:
readonly workstreamId?: string | null;   // resolved live-workstream id (for telemetry meta)

// src/core/workstream/compose-recall.ts:
export interface WorkstreamRecallView {
  readonly workstream: import("./model.js").Workstream;   // the live survivor
  readonly sessionIds: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<import("../../shared/types.js").Fact>;
  readonly exemplars: ReadonlyArray<import("../../shared/types.js").CodeExemplar>;
}
export function composeWorkstreamRecall(view: WorkstreamRecallView): string;

// src/mcp/server.ts — McpDeps gains (mirrors RollupDeps + the store for idOrLabel resolution):
readonly workstreams?: {
  readonly store: import("@ports/workstream-store.js").WorkstreamStore;
  readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
  readonly facts: Pick<FactStore, "listBySessions">;
  readonly exemplars: Pick<import("@ports/code-exemplar-store.js").CodeExemplarStore, "listBySessions">;
};
export function recallWorkstreamHandler(deps: McpDeps, input: { idOrLabel?: string }): Promise<ToolResult>;
```

---

## Task 1: Project `workstream_id` onto the Session read model

**Files:**
- Modify: `src/shared/types.ts` (Session interface)
- Modify: `src/core/storage/sqlite-session-store.ts` (`SessionRow`, `listByDateRange` SELECT, `rowToSession`)
- Modify: `src/core/storage/pg-session-store.ts` (`listByDateRange` SELECT, `rowToSession`)
- Test: `tests/integration/session-workstream-projection.test.ts`

**Interfaces:**
- Produces: `Session.workstreamId?: string | null`, populated by `listByDateRange` in both adapters.

**Background (verified):** `Session` (`src/shared/types.ts:21-41`) currently has no workstream field. `listByDateRange` (sqlite `:616-634`, pg `:130-146`) selects a fixed column list that omits `workstream_id`. `SessionRow` (sqlite `:80-93`) and `rowToSession` (sqlite `:1030-1073`) build the projection. Add `workstreamId` as an OPTIONAL field (like `supersedes`/`supersededBy`) so other read paths that don't select it stay valid.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/session-workstream-projection.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-wsproj-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

describe("listByDateRange surfaces workstream_id", () => {
  it("returns workstreamId when the session is bound, null otherwise", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", startedAt: "2026-06-24T10:00:00.000Z" }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2", startedAt: "2026-06-24T11:00:00.000Z" }));
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    await storage.sessions.setWorkstreamBinding("s1", "ws_1", "classifier", 0.9);

    const rows = await storage.sessions.listByDateRange("2026-06-24T00:00:00.000Z", "2026-06-25T00:00:00.000Z");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("s1")!.workstreamId).toBe("ws_1");
    expect(byId.get("s2")!.workstreamId ?? null).toBeNull();
  });
});
```

(If `makeSession`/`insertSessionForTest` does not accept `startedAt`, use whatever the fixture provides so both sessions fall in the 2026-06-24 day window; verify the fixture before writing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/session-workstream-projection.test.ts`
Expected: FAIL — `workstreamId` is `undefined` (column not selected/threaded).

- [ ] **Step 3: Add the field to the `Session` type**

In `src/shared/types.ts`, inside `interface Session`, after `supersededBy`:
```typescript
  /** Live binding to a workstream, if any. Populated by projections that select it (e.g. listByDateRange); absent elsewhere. */
  readonly workstreamId?: string | null;
```

- [ ] **Step 4: Thread it through the SQLite adapter**

In `sqlite-session-store.ts`: add `workstream_id: string | null;` to the `SessionRow` type. Add `workstream_id` to the `listByDateRange` SELECT column list:
```typescript
      SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
             label, summary, status, transcript_kind, transcript_path, workstream_id
```
In `rowToSession`, add to the returned object (near `entities`):
```typescript
    workstreamId: row.workstream_id ?? null,
```

- [ ] **Step 5: Thread it through the Postgres adapter**

In `pg-session-store.ts`: add `workstream_id` to the `listByDateRange` SELECT (same position), and in its `rowToSession` add `workstreamId: row.workstream_id ?? null,`. If the PG `SessionRow` type is shared from sqlite or local, ensure `workstream_id: string | null` is present on the type the query row is cast to.

- [ ] **Step 6: Run test + typecheck + commit**

Run: `npx vitest run tests/integration/session-workstream-projection.test.ts && npm run test && npm run typecheck`
Expected: PASS (typecheck confirms no other `listByDateRange`/Session consumer breaks; `workstreamId` is optional so other projections that omit it stay valid).

```bash
git add src/shared/types.ts src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts tests/integration/session-workstream-projection.test.ts
git commit -m "feat(workstream): project workstream_id onto listByDateRange session read model (#367)"
```

---

## Task 2: Workstream-aware topic provider in the work-digest

**Files:**
- Modify: `src/core/work-digest/topics.ts` (`TopicInput`, new `workstreamTopicProvider`)
- Modify: `src/core/work-digest/build-work-digest.ts` (`BuildWorkDigestDeps`, `SessionActivity`, resolve + pass label)
- Modify: `src/cli/nlm.ts` (wire `workstreams: storage.workstreams` into the 3 work-digest deps sites)
- Test: `tests/unit/core/work-digest/workstream-topic.test.ts`

**Interfaces:**
- Consumes: `Session.workstreamId` (Task 1), `resolveWorkstreamId` (Plan A), `WorkstreamStore.listAll` (Plan A).
- Produces: `workstreamTopicProvider(fallback)`; `TopicInput.workstreamLabel`; `BuildWorkDigestDeps.workstreams`; `SessionActivity.workstreamId`.

**Background (verified):** `topics.ts` defines `TopicInput = {entities, label}`, `defaultTopicProvider` (first entity), `aliasTopicProvider`. `build-work-digest.ts:52-54` calls `topicProvider({ entities: s.entities, label: s.label })` per session; `BuildWorkDigestDeps` (`:11-16`) has `store`+`topicProvider`. `loadTopicProvider()` (`nlm.ts:159-167`) supplies the configured fallback. The new provider prefers the workstream label when present and falls through otherwise (spec §10). The resolution (workstream_id → live survivor → label) happens in `buildWorkDigest` using `workstreams.listAll()` once.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/work-digest/workstream-topic.test.ts
import { describe, expect, it } from "vitest";
import { workstreamTopicProvider, defaultTopicProvider } from "../../../../src/core/work-digest/topics.js";

describe("workstreamTopicProvider", () => {
  it("uses the workstream label when present", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["somedotfile"], label: "x", workstreamLabel: "NLM" })).toBe("NLM");
  });
  it("falls back when no workstream label", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["Foo"], label: "x" })).toBe("foo"); // default normalizes
  });
  it("falls back on blank workstream label", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["Foo"], label: "x", workstreamLabel: "  " })).toBe("foo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/work-digest/workstream-topic.test.ts`
Expected: FAIL — `workstreamTopicProvider` not exported.

- [ ] **Step 3: Add to `topics.ts`**

Extend `TopicInput`:
```typescript
export interface TopicInput {
  readonly entities: ReadonlyArray<string>;
  readonly label: string;
  /** Resolved live-workstream label, when the session is bound. Takes precedence over entity/alias topics. */
  readonly workstreamLabel?: string;
}
```
Add the provider:
```typescript
/** NLM-core: prefer the bound workstream's label; fall through to `fallback`
 *  (alias-map / first-entity) for unbound sessions. Retires the
 *  alphabetically-first-entity dependency for bound sessions (spec §10). */
export function workstreamTopicProvider(fallback: TopicProvider): TopicProvider {
  return (input) =>
    input.workstreamLabel && input.workstreamLabel.trim() ? input.workstreamLabel : fallback(input);
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `npx vitest run tests/unit/core/work-digest/workstream-topic.test.ts`
Expected: PASS.

- [ ] **Step 5: Resolve + pass the label in `build-work-digest.ts`**

Extend `BuildWorkDigestDeps`:
```typescript
  readonly workstreams?: Pick<import("@ports/workstream-store.js").WorkstreamStore, "listAll">;
```
Extend `SessionActivity` (find its declaration in this file or a sibling and add):
```typescript
  readonly workstreamId?: string | null;
```
In `buildWorkDigest`, after `const topicProvider = deps.topicProvider ?? defaultTopicProvider;`, wrap it and build the resolver map:
```typescript
import { resolveWorkstreamId } from "@core/workstream/resolve.js";
import { workstreamTopicProvider } from "./topics.js";
// ...
const provider = deps.workstreams ? workstreamTopicProvider(topicProvider) : topicProvider;
const wsList = deps.workstreams ? await deps.workstreams.listAll() : [];
const wsById = new Map(wsList.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
const wsLabel = new Map(wsList.map((w) => [w.id, w.label]));
function resolveWs(id: string | null | undefined): { id: string; label: string } | null {
  if (!id) return null;
  const live = resolveWorkstreamId(id, wsById);
  const label = wsLabel.get(live);
  return label ? { id: live, label } : null;
}
```
In the per-session loop, replace the `topicProvider({...})` call:
```typescript
    const ws = resolveWs(s.workstreamId);
    const topic = provider({ entities: s.entities, label: s.label, ...(ws ? { workstreamLabel: ws.label } : {}) });
    activities.push({ sessionId: s.id, topic, timestampsMs, ...(ws ? { workstreamId: ws.id } : {}) });
```

- [ ] **Step 6: Wire `workstreams` into the 3 deps sites in `nlm.ts`**

At each work-digest deps assembly (`nlm.ts` ~`:388` HTTP mcpDeps, ~`:1017` stdio `mcp` command, ~`:1993` `work-digest` CLI command), add `workstreams: storage.workstreams` to the `workDigest: { store, topicProvider: loadTopicProvider(), ...workDigestEnv() }` object → `workDigest: { store, topicProvider: loadTopicProvider(), workstreams: storage.workstreams, ...workDigestEnv() }`. (Confirm `storage` is in scope at each site; the `work-digest` CLI destructures `{ storage, store }` from `buildStack()`.)

- [ ] **Step 7: Write an integration test for the resolution path**

Add to `tests/unit/core/work-digest/workstream-topic.test.ts` a `buildWorkDigest`-level case using a fake store + fake `workstreams.listAll`, asserting a bound session's topic is its workstream label and a merged workstream resolves to the survivor's label:
```typescript
import { buildWorkDigest } from "../../../../src/core/work-digest/build-work-digest.js";

it("attributes a bound session to its (merge-resolved) workstream label", async () => {
  const sessions = [
    { id: "s1", entities: ["dotfile"], label: "x", decisions: [], open: [], transcriptPath: "/t1", workstreamId: "ws_old" },
  ] as any;
  const deps: any = {
    store: { listByDateRange: async () => sessions },
    workstreams: { listAll: async () => [
      { id: "ws_old", label: "Old", mergedInto: "ws_new" },
      { id: "ws_new", label: "NLM", mergedInto: null },
    ] },
    readTimestamps: () => [Date.parse("2026-06-24T10:00:00Z"), Date.parse("2026-06-24T10:30:00Z")],
  };
  const d = await buildWorkDigest(deps, "2026-06-24");
  expect(d.byTopic.map((t) => t.topic)).toContain("NLM"); // resolved through merged_into
});
```

- [ ] **Step 8: Run tests + typecheck + commit**

Run: `npx vitest run tests/unit/core/work-digest/workstream-topic.test.ts && npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/core/work-digest/topics.ts src/core/work-digest/build-work-digest.ts src/cli/nlm.ts tests/unit/core/work-digest/workstream-topic.test.ts
git commit -m "feat(workstream): work-digest topic provider attributes time to workstream labels (#367)"
```

---

## Task 3: Telemetry seam — expose `workstream_id` on `byTopic[].meta`

**Files:**
- Modify: `src/core/work-digest/attribute.ts` (set `meta.workstream_id` on winning topic)
- Test: `tests/unit/core/work-digest/workstream-topic.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionActivity.workstreamId` (Task 2), `TopicShare.meta` (existing, `types.ts:20`).
- Produces: `byTopic[].meta.workstream_id` populated for topics whose winning session is workstream-bound.

**Background (verified):** `TopicShare.meta?: Record<string, unknown>` (`work-digest/types.ts:20`) is the documented opaque extension seam. `attribute()` (`attribute.ts:20-75`) picks, per merged interval, the session with the most timestamps (`best`), maps `best.topic`, and aggregates minutes by topic into `byTopic`. To expose a stable `workstream_id` (spec §11), carry the winning session's `workstreamId` onto the topic's `meta`. Because a topic IS the workstream label for bound sessions, all of a topic's intervals won by bound sessions share one `workstreamId`; set it once per topic.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/core/work-digest/workstream-topic.test.ts
it("exposes the resolved workstream_id on the topic's meta (telemetry seam §11)", async () => {
  const sessions = [
    { id: "s1", entities: ["x"], label: "x", decisions: [], open: [], transcriptPath: "/t1", workstreamId: "ws_old" },
  ] as any;
  const deps: any = {
    store: { listByDateRange: async () => sessions },
    workstreams: { listAll: async () => [
      { id: "ws_old", label: "Old", mergedInto: "ws_new" },
      { id: "ws_new", label: "NLM", mergedInto: null },
    ] },
    readTimestamps: () => [Date.parse("2026-06-24T10:00:00Z"), Date.parse("2026-06-24T10:30:00Z")],
  };
  const d = await buildWorkDigest(deps, "2026-06-24");
  const nlm = d.byTopic.find((t) => t.topic === "NLM");
  expect(nlm?.meta?.["workstream_id"]).toBe("ws_new"); // survivor id, not ws_old
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/work-digest/workstream-topic.test.ts -t "telemetry seam"`
Expected: FAIL — `meta` is `undefined`.

- [ ] **Step 3: Populate `meta.workstream_id` in `attribute.ts`**

In `attribute()`, while accumulating segments, also record the winning session's `workstreamId` per topic. After building `byTopicMap`, build a `wsByTopic: Map<string, string>` from segments (a topic's `workstream_id` = the `workstreamId` of any winning session for that topic; they agree for bound topics). Then when mapping `byTopic`, attach `meta` only when present:
```typescript
  // alongside the existing per-interval `best` selection, capture best.workstreamId:
  segments.push({ topic: best ? best.topic : "uncategorized", minutes, workstreamId: best?.workstreamId ?? null });
  // ...
  const wsByTopic = new Map<string, string>();
  for (const seg of segments) if (seg.workstreamId && !wsByTopic.has(seg.topic)) wsByTopic.set(seg.topic, seg.workstreamId);
  // in the byTopic .map():
    .map(([topic, mins]) => {
      const wsId = wsByTopic.get(topic);
      return {
        topic,
        activeMinutes: round1(mins),
        share: totalMin ? round2(mins / totalMin) : 0,
        ...(wsId ? { meta: { workstream_id: wsId } } : {}),
      };
    })
```
Add `workstreamId` to the local `segments` element type and to the `SessionActivity` type if `attribute` reads it from there (it reads `best`, a `SessionActivity`, which already gained `workstreamId` in Task 2).

- [ ] **Step 4: Run test + typecheck + commit**

Run: `npx vitest run tests/unit/core/work-digest/workstream-topic.test.ts && npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/core/work-digest/attribute.ts tests/unit/core/work-digest/workstream-topic.test.ts
git commit -m "feat(workstream): expose stable workstream_id on work-digest byTopic meta (#367 §11)"
```

---

## Task 4: `composeWorkstreamRecall` — the recall view formatter

**Files:**
- Create: `src/core/workstream/compose-recall.ts`
- Test: `tests/unit/core/workstream/compose-recall.test.ts`

**Interfaces:**
- Consumes: `WorkstreamRollup` shape (Plan A `model.ts`): `{ workstream, sessionIds, facts, exemplars }`; `Fact`/`CodeExemplar` (`shared/types.ts`).
- Produces: `WorkstreamRecallView`, `composeWorkstreamRecall(view): string` (see Canonical Contracts).

**Background (verified):** mirrors `composeWorkDigest` (`compose-work-digest.ts:26-65`): build a `string[]`, `join("\n")`, return plain text/markdown. `Fact` has `kind` (`"decision"|"open"|"attribute"`), `subject`, `predicate`, `value`. Group current facts by kind: decisions, open loops, attributes. `CodeExemplar` has `repo`, `taskContext`, `outcome`. Newest-first sessions: the rollup gives `sessionIds`; this composer renders counts + the fact/exemplar detail (the spec §9 "coherent project view").

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/workstream/compose-recall.test.ts
import { describe, expect, it } from "vitest";
import { composeWorkstreamRecall } from "../../../../src/core/workstream/compose-recall.js";
import type { Fact, CodeExemplar } from "../../../../src/shared/types.js";

const fact = (kind: Fact["kind"], subject: string, value: string): Fact => ({
  id: `f_${subject}`, kind, subject, predicate: "is", value,
  sourceSessionId: "s1", sourceQuote: null, createdAt: "2026-06-24T00:00:00Z",
  supersededBy: null, confidence: 1, retiredAt: null,
});

describe("composeWorkstreamRecall", () => {
  it("renders the workstream label, session count, decisions, open loops, and exemplars", () => {
    const out = composeWorkstreamRecall({
      workstream: { id: "ws_1", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: "2026-06-24T00:00:00Z" },
      sessionIds: ["s1", "s2"],
      facts: [fact("decision", "store", "use sqlite-vec"), fact("open", "thresholds", "tune HIGH/LOW")],
      exemplars: [{ id: "e1", installScope: "x", signalId: null, sessionId: "s1", repo: "nlm-memory", model: "m", lang: "ts", taskContext: "matcher", code: "x", codeHash: "h", outcome: "kept", gitSha: null, survived: 1, ts: "t", createdAt: "t", retiredAt: null, labelSource: "llm" } as CodeExemplar],
    });
    expect(out).toContain("NLM");
    expect(out).toContain("2 sessions");
    expect(out).toContain("use sqlite-vec");
    expect(out).toContain("tune HIGH/LOW");
    expect(out).toContain("nlm-memory");
    expect(out).not.toContain("undefined");
  });

  it("handles an empty workstream gracefully", () => {
    const out = composeWorkstreamRecall({
      workstream: { id: "ws_1", label: "Empty", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
      sessionIds: [], facts: [], exemplars: [],
    });
    expect(out).toContain("Empty");
    expect(out).toContain("0 sessions");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/compose-recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `compose-recall.ts`**

```typescript
// src/core/workstream/compose-recall.ts
import type { Workstream } from "./model.js";
import type { Fact, CodeExemplar } from "../../shared/types.js";

export interface WorkstreamRecallView {
  readonly workstream: Workstream;
  readonly sessionIds: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<Fact>;
  readonly exemplars: ReadonlyArray<CodeExemplar>;
}

export function composeWorkstreamRecall(view: WorkstreamRecallView): string {
  const { workstream, sessionIds, facts, exemplars } = view;
  const lines: string[] = [];
  lines.push(`WORKSTREAM: ${workstream.label}`);
  lines.push(`(${sessionIds.length} sessions${workstream.lastSessionAt ? `, last active ${workstream.lastSessionAt.slice(0, 10)}` : ""})`);
  lines.push("");

  const decisions = facts.filter((f) => f.kind === "decision");
  const open = facts.filter((f) => f.kind === "open");
  const attrs = facts.filter((f) => f.kind === "attribute");

  if (decisions.length) {
    lines.push("DECISIONS:");
    for (const f of decisions) lines.push(`  - ${f.value}`);
    lines.push("");
  }
  if (open.length) {
    lines.push("OPEN LOOPS:");
    for (const f of open) lines.push(`  - ${f.value}`);
    lines.push("");
  }
  if (attrs.length) {
    lines.push("FACTS:");
    for (const f of attrs) lines.push(`  - ${f.subject} ${f.predicate} ${f.value}`);
    lines.push("");
  }
  if (exemplars.length) {
    lines.push("CODE EXEMPLARS:");
    for (const e of exemplars) lines.push(`  - [${e.outcome}] ${e.repo}: ${e.taskContext}`);
    lines.push("");
  }
  if (!decisions.length && !open.length && !attrs.length && !exemplars.length) {
    lines.push("(no accumulated facts or exemplars yet)");
  }
  return lines.join("\n").trimEnd();
}
```

- [ ] **Step 4: Run test + typecheck + commit**

Run: `npx vitest run tests/unit/core/workstream/compose-recall.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/core/workstream/compose-recall.ts tests/unit/core/workstream/compose-recall.test.ts
git commit -m "feat(workstream): recall view composer (#367 §9)"
```

---

## Task 5: `recall_workstream` MCP tool + handler + CLI + deps wiring

**Files:**
- Modify: `src/mcp/server.ts` (`McpDeps`, `recallWorkstreamHandler`, register tool)
- Modify: `src/cli/nlm.ts` (thread `workstreams` into the 2 `createMcpServer` sites; add `nlm recall-workstream` command)
- Test: `tests/integration/recall-workstream-mcp.test.ts`

**Interfaces:**
- Consumes: `rollupWorkstream` (Plan A), `composeWorkstreamRecall` (Task 4), `WorkstreamStore.{getById,findByNormalizedLabel,listAll}` + `normalizeLabel` (Plan A), `storage.workstreams`/`store`/`facts`/`exemplars`.
- Produces: `McpDeps.workstreams`, `recallWorkstreamHandler`, the `recall_workstream` tool, `nlm recall-workstream` CLI.

**Background (verified):** MCP tools register via `server.registerTool(name, {title, description, inputSchema (Zod), annotations}, async (args) => handler(deps, args) as never)` (`server.ts:597`). Handlers return `ToolResult` via `okText(text)` for markdown or `err(e)`; an "unavailable" guard returns `okText(...)` when a deps slice is absent (see `workSummaryHandler` `:177-191`). `McpDeps` (`:45-58`) is the deps bag. `rollupWorkstream(deps, workstreamId)` returns `WorkstreamRollup | null`. idOrLabel resolution: try `getById(idOrLabel)`; if null, `findByNormalizedLabel(normalizeLabel(idOrLabel))`. Resolve the found workstream's id through the rollup (which already resolves merged_into). The 2 `createMcpServer` deps sites are `nlm.ts:388` (HTTP, in mcpDeps) and `nlm.ts:1007-1021` (stdio `mcp`).

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/recall-workstream-mcp.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { recallWorkstreamHandler } from "../../src/mcp/server.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-rws-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

function deps() {
  return {
    recall: {} as any, store: storage.sessions,
    workstreams: { store: storage.workstreams, sessions: storage.sessions, facts: storage.facts, exemplars: storage.exemplars },
  } as any;
}

describe("recall_workstream handler", () => {
  it("resolves by label and returns the rolled-up view", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    const r = await recallWorkstreamHandler(deps(), { idOrLabel: "NLM" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toContain("NLM");
  });
  it("returns a graceful not-found message for an unknown workstream", async () => {
    const r = await recallWorkstreamHandler(deps(), { idOrLabel: "Nonexistent" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });
  it("returns an unavailable message when workstreams deps are not wired", async () => {
    const r = await recallWorkstreamHandler({ recall: {}, store: storage.sessions } as any, { idOrLabel: "NLM" });
    expect(r.content[0]!.text.toLowerCase()).toContain("not available");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/recall-workstream-mcp.test.ts`
Expected: FAIL — `recallWorkstreamHandler` not exported.

- [ ] **Step 3: Add `McpDeps.workstreams` + the handler in `server.ts`**

Add to `McpDeps`:
```typescript
  /** Wire to enable recall_workstream. Mirrors RollupDeps + the store for idOrLabel resolution. */
  readonly workstreams?: {
    readonly store: import("@ports/workstream-store.js").WorkstreamStore;
    readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
    readonly facts: Pick<FactStore, "listBySessions">;
    readonly exemplars: Pick<import("@ports/code-exemplar-store.js").CodeExemplarStore, "listBySessions">;
  };
```
Add the handler (near `workSummaryHandler`):
```typescript
import { rollupWorkstream } from "@core/workstream/rollup.js";
import { composeWorkstreamRecall } from "@core/workstream/compose-recall.js";
import { normalizeLabel } from "@core/workstream/model.js";

export async function recallWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("recall_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const ws = deps.workstreams.store;
    const found =
      (await ws.getById(idOrLabel)) ?? (await ws.findByNormalizedLabel(normalizeLabel(idOrLabel)));
    if (!found) return okText(`No workstream matches "${idOrLabel}".`);
    const view = await rollupWorkstream(
      { workstreams: deps.workstreams.store, sessions: deps.workstreams.sessions, facts: deps.workstreams.facts, exemplars: deps.workstreams.exemplars },
      found.id,
    );
    if (!view) return okText(`No workstream matches "${idOrLabel}".`);
    return okText(composeWorkstreamRecall(view));
  } catch (e) {
    return err(e);
  }
}
```
(`rollupWorkstream`'s `RollupDeps` expects `workstreams` with `listAll`+`getById` — `deps.workstreams.store` satisfies both. Confirm the `RollupDeps` shape against `src/core/workstream/rollup.ts` and pass `deps.workstreams.store` as its `workstreams`.)

- [ ] **Step 4: Register the `recall_workstream` tool**

In `createMcpServer`, near the `work_summary` registration:
```typescript
server.registerTool(
  "recall_workstream",
  {
    title: "Recall a workstream's accumulated context",
    description:
      "Return the coherent project view for a workstream: its member sessions, current decisions and open loops, accumulated facts, and code exemplars. Accepts a workstream id or label; merge chains resolve to the live workstream.",
    inputSchema: {
      idOrLabel: z.string().describe("Workstream id (ws_...) or label (e.g. 'NLM')."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => recallWorkstreamHandler(deps, args) as never,
);
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `npx vitest run tests/integration/recall-workstream-mcp.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire deps + add the CLI command in `nlm.ts`**

At the HTTP `mcpDeps` (`:388` area) and the stdio `createMcpServer` (`:1007-1021`), add:
```typescript
        workstreams: { store: storage.workstreams, sessions: store, facts: facts, exemplars: storage.exemplars },
```
(use the variables in scope at each site — `storage`, `store`, `facts`). Add the CLI command (mirror the `recall` command at `nlm.ts:527`):
```typescript
program
  .command("recall-workstream")
  .description("Recall a workstream's accumulated context (id or label)")
  .argument("<idOrLabel>", "workstream id or label")
  .action(async (idOrLabel) => {
    const { storage, store } = await buildStack();
    try {
      const r = await recallWorkstreamHandler(
        { recall: {} as never, store, workstreams: { store: storage.workstreams, sessions: store, facts: storage.facts, exemplars: storage.exemplars } } as never,
        { idOrLabel },
      );
      process.stdout.write(r.content[0]!.text + "\n");
    } finally {
      await storage.close();
    }
  });
```
(Import `recallWorkstreamHandler` from `../mcp/server.js`. If importing a handler into the CLI is awkward, factor the body into a small `recallWorkstream(view-deps, idOrLabel): Promise<string>` core fn that both the MCP handler and CLI call — preferred if the lint/structure favors it. Use your judgment; keep one source of truth.)

- [ ] **Step 7: Run full suite + typecheck + commit**

Run: `npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/mcp/server.ts src/cli/nlm.ts tests/integration/recall-workstream-mcp.test.ts
git commit -m "feat(workstream): recall_workstream MCP tool + CLI (#367 §9)"
```

---

## Task 6: Optional `workstream` filter on `recall_sessions`

**Files:**
- Modify: `src/shared/types.ts` (`RecallQuery.workstream`)
- Modify: `src/core/recall/recall-service.ts` (apply workstream filter at the entity/kind filter point)
- Modify: `src/mcp/server.ts` (`RecallToolInput.workstream`, schema, handler spread)
- Modify: `src/cli/nlm.ts` (`--workstream` option on `nlm recall`)
- Test: `tests/integration/recall-workstream-filter.test.ts`

**Interfaces:**
- Consumes: `WorkstreamStore.{listAll}` + `resolveWorkstreamId` + `SessionStore.listSessionIdsByWorkstreams` (Plan A), the existing recall filter pipeline.
- Produces: `RecallQuery.workstream`, `RecallToolInput.workstream`, the filter behavior.

**Background (verified):** `recall_sessions` filters by `entity`/`kind` inside `RecallService.search` (`recall-service.ts:77-281`); the entity/kind filter is applied at the in-search filter point (around `:150-158`) BEFORE the final limit, so a workstream filter belongs there (not a post-limit handler filter, which would under-fill `limit`). The filter resolves the `workstream` arg (id or label) → live survivor → member workstream ids → an allowed session-id `Set` (via `WorkstreamStore.listAll` + `resolveWorkstreamId` + `SessionStore.listSessionIdsByWorkstreams`), then keeps only hits whose session id is in the set. RecallService needs a way to compute this; inject a resolver into its deps OR resolve in the handler and pass an `allowedSessionIds` set into the query.

**Approach (read-then-mirror — this is the one task that reads existing code before editing):** First READ `recall-service.ts:77-281` to see the exact `entity`/`kind` filter call and the `RecallService` deps/constructor. Choose the lower-blast-radius option:
- **Option A (preferred if RecallService already holds a `store`/session handle):** add an optional `resolveWorkstreamSessions?: (idOrLabel: string) => Promise<Set<string>>` to the RecallService deps; when `query.workstream` is set, compute the allowed set and filter `hitSessions` alongside entity/kind.
- **Option B:** resolve the allowed set in `recallSessionsHandler` (it has `deps.workstreams`/`deps.store`) and pass `allowedSessionIds?: ReadonlySet<string>` through `RecallQuery`; filter in-search by membership at the same point.

Pick one, keep it consistent, and document the choice in the commit message.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/recall-workstream-filter.test.ts
// Build a SqliteStorage, insert 2 sessions with distinct keyword-matchable labels,
// bind s1 to ws_1 ("NLM"), leave s2 unbound (or bound to ws_2). Run recall.search({ query: <matches both>, workstream: "NLM" })
// and assert only s1 is returned. Model store/recall construction on tests/integration/recall-sqlite.test.ts.
```

Model the store + `RecallService` construction on the existing `tests/integration/recall-sqlite.test.ts`. Assert: with `workstream: "NLM"`, a query that keyword-matches both sessions returns only the workstream-bound session; without the filter, both return.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/recall-workstream-filter.test.ts`
Expected: FAIL — `workstream` filter not applied (both sessions returned).

- [ ] **Step 3: Add `workstream` to the query types**

In `src/shared/types.ts` `RecallQuery`, add `readonly workstream?: string;`. In `src/mcp/server.ts` `RecallToolInput`, add `workstream: string | undefined;`.

- [ ] **Step 4: Apply the filter in `recall-service.ts`**

Per the chosen option, resolve `query.workstream` → allowed session-id `Set` and filter `hitSessions` at the same point entity/kind are filtered. Resolution helper (place in recall-service or a small util):
```typescript
async function allowedWorkstreamSessions(
  idOrLabel: string,
  wsStore: { listAll(): Promise<ReadonlyArray<{ id: string; label: string; mergedInto: string | null }>>; },
  sessions: { listSessionIdsByWorkstreams(ids: ReadonlyArray<string>): Promise<ReadonlyArray<string>>; },
  normalize: (s: string) => string,
  resolve: (id: string, byId: ReadonlyMap<string, { id: string; mergedInto: string | null }>) => string,
): Promise<Set<string>> {
  const all = await wsStore.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const direct = all.find((w) => w.id === idOrLabel);
  const target = direct ?? all.find((w) => normalize(w.label) === normalize(idOrLabel));
  if (!target) return new Set();
  const survivor = resolve(target.id, byId);
  const members = all.filter((w) => resolve(w.id, byId) === survivor).map((w) => w.id);
  return new Set(await sessions.listSessionIdsByWorkstreams(members));
}
```
Then where entity/kind filter the hit set, add: if `query.workstream`, drop hits whose session id is not in the allowed set. Inject `WorkstreamStore` + the session handle + `normalizeLabel` + `resolveWorkstreamId` into RecallService deps as needed (Option A), or accept a precomputed set (Option B).

- [ ] **Step 5: Wire the MCP schema + handler + CLI**

In the `recall_sessions` `inputSchema` (`server.ts:597`), add:
```typescript
      workstream: z.string().optional().describe("Filter to sessions bound to this workstream (id or label; merge chains resolve)."),
```
In `recallSessionsHandler`, spread it into the query: `...(input.workstream !== undefined ? { workstream: input.workstream } : {})`. In `nlm.ts` `recall` command, add `.option("-w, --workstream <idOrLabel>", "filter by workstream")` and spread `...(opts.workstream ? { workstream: opts.workstream } : {})` into the `recall.search({...})` call.

- [ ] **Step 6: Run test + full suite + typecheck + commit**

Run: `npx vitest run tests/integration/recall-workstream-filter.test.ts && npm run test && npm run typecheck`
Expected: PASS.

```bash
git add src/shared/types.ts src/core/recall/recall-service.ts src/mcp/server.ts src/cli/nlm.ts tests/integration/recall-workstream-filter.test.ts
git commit -m "feat(workstream): optional workstream filter on recall_sessions (#367 §9)"
```

---

## Self-Review

**1. Spec coverage (Plan B scope):**
- §9 `recall_workstream(idOrLabel)` (member sessions, rolled-up facts/decisions/open-loops, exemplars) → Tasks 4 (composer) + 5 (tool/CLI) ✓
- §9 `recall_sessions` optional `workstream` filter → Task 6 ✓
- §9 merge chains resolve through `merged_into` → `rollupWorkstream` (Plan A) + `resolveWorkstreamId` used in Tasks 2, 5, 6 ✓
- §10 work-digest topic provider swap (TopicInput + listByDateRange projection + provider rewire, fallback for unbound) → Tasks 1 + 2 ✓
- §11 telemetry seam (stable `workstream_id` on digest + recall outputs, nothing more) → Task 3 (`byTopic[].meta.workstream_id`) + Task 5 (recall_workstream surfaces the workstream id/label) ✓
- Deferred correctly (NOT Plan B): lifecycle mutations / merge-suggestion (Plan C); seed/backfill/flip (Plan D); v2 start-side binding (spec §14). ✓

**2. Placeholder scan:** every code step has complete code. Two tasks carry explicit "read existing code then mirror" instructions (Task 6's filter-insertion point; Task 5's CLI handler-vs-core-fn structure choice) — flagged as deliberate, not hidden TODOs, because the exact insertion site/structure depends on the current `recall-service.ts` filter pipeline and the team's CLI-import convention. Task 6's failing test is described against the existing `recall-sqlite.test.ts` pattern rather than fully transcribed (the store/recall construction must be copied from the repo's nearest recall integration test).

**3. Type consistency:** `Session.workstreamId`, `TopicInput.workstreamLabel`, `SessionActivity.workstreamId`, `BuildWorkDigestDeps.workstreams`, `TopicShare.meta.workstream_id`, `WorkstreamRecallView`/`composeWorkstreamRecall`, `McpDeps.workstreams`, `recallWorkstreamHandler`, `RecallQuery.workstream`/`RecallToolInput.workstream` are defined once and referenced unchanged. `recallWorkstreamHandler` passes `deps.workstreams.store` as `rollupWorkstream`'s `workstreams` (needs `listAll`+`getById` — `WorkstreamStore` has both).

**Cross-plan notes:**
- Binding is still flag-OFF until Plan D, so today almost every session is unbound: the work-digest swap is behavior-neutral in practice (fallback path), and `recall_workstream` returns mostly-empty rollups until Plan D seeds + flips. That is expected; Plan B builds the read surface so Plan D's flip lights it up.
- The work-digest deps wiring (`nlm.ts`) is a daemon change → rebuild + restart post-merge so running config matches source-of-truth.
