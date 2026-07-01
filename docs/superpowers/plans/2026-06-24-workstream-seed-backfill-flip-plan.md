# Workstream Seed / Backfill / Flip (Plan D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans for the CODE tasks (1–5). The ROLLOUT RUNBOOK (R1–R6) is a human/data/operational procedure executed by the controller (not subagents), in order, against the LIVE `~/.nlm/canonical.sqlite`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Light up the workstream binder in production: extract one shared matcher-input builder (runtime + eval use it), seed the operator's project taxonomy from `~/.nlm/work-topics.json`, build a locked ~50-session gold set hand-labeled *independently* of the seed map, derive HIGH/LOW thresholds from that gold set, match-only-backfill history, verify the digest, then flip `NLM_WORKSTREAM_BIND=true`.

**Architecture:** Plans A–C built and surfaced the workstream abstraction (matcher, store, recall, work-digest labels, lifecycle tools), all behind a default-OFF binding flag (`scheduler.ts:48`). Plan D is the real-data-gated rollout (spec §13): it adds NO new abstraction, only (a) a small DRY refactor extracting `buildMatchInputs` so the eval/backfill run the *exact* runtime matcher (spec §15 "one source of truth"), (b) a seed loader, (c) the real tune-matcher wiring, (d) a reversible match-only backfill, (e) gold-derived thresholds. The flip is an env-var change to the daemon, gated on the gold set + verification passing first. Embeddings are NOT re-computed — the embedder is unchanged (nomic-v1.5), so the matcher reuses the existing `session_embeddings` via `semanticSearch`.

**Tech Stack:** TypeScript (ESM, `@core`/`@ports` aliases), better-sqlite3 (live runtime `~/.nlm/canonical.sqlite`), Postgres parity where a store method changes (none new in Plan D), `tsx` (eval/seed/backfill scripts), vitest. LM Studio on the Mac Studio serves the classifier (`qwen3.5-4b-mlx`) + recall embedder (`nomic-v1.5`) via the OpenAI-compatible endpoints in `~/.nlm/.env`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-24-workstream-abstraction-design.md` §13 (seed/backfill/rollout, ordered + reversible), §16 (locked gold set, independence), §6 (match-or-create bands), §15 (one source of truth), §17 (matcher precision is load-bearing; gold set MUST be built before backfill).
- **Builds on (verified, present on main):** `bindSessionToWorkstream` (`src/core/workstream/bind.ts`) — the runtime binder, whose embed→neighbors→candidates pipeline is the thing being extracted; `matchWorkstream(inputs)` + `jaccard` (`match.ts`); `DEFAULT_THRESHOLDS={high:0.55,low:0.3}` + `DEFAULT_WEIGHTS={semantic:0.5,entity:0.5}` (`thresholds.ts` — provisional, replaced here); `MatchInputs`/`MatchDecision`/`MatchThresholds`/`MatchWeights`/`WorkstreamCandidate` (`model.ts`); `SessionStore.{semanticSearch, getWorkstreamIds, setWorkstreamBinding}` (Plan A); `WorkstreamStore.{create, findByNormalizedLabel, listAll, upsertEntities, candidatesByEntityOverlap, entitiesFor}` (Plan A); the eval harness `scripts/eval/lib/matcher-gold.ts` (`loadGold/scoreGold/sweepThresholds`, `Prediction`) + the stub `scripts/eval/tune-matcher.ts` + `scripts/eval/dump-matcher-candidates.ts` (Plan A Task 10); the resumable backfill pattern `src/core/facts/backfill-facts.ts` (`backfillFacts`, JSON state at `~/.nlm/backfill_facts.state`); the binding flag `process.env["NLM_WORKSTREAM_BIND"]==="true"` (`scheduler.ts:48`, default off).
- **TDD for code tasks (1–5):** failing test → run-it-fails → minimal impl → green. `npm run test` + `npm run typecheck` before every commit. The matcher binding runs in the scheduler sweep (hot-ish path) — after Task 1's bind.ts refactor and after Task 5's threshold change, run `npm run build:server` to confirm the daemon compiles (but DEFER the daemon restart to post-push, per the repo rule: never run the live daemon on unpushed/feature-branch dist).
- **GOLD-SET INDEPENDENCE (load-bearing, spec §16/§17):** the ~50-session gold set is hand-labeled from each session's *transcript/label* — NOT by reading or copying the seed alias map. Grading the matcher against its own seed inflates precision. The labeler (the controller, in a focused pass) must not consult `~/.nlm/work-topics.json` while assigning gold workstreams. Build the gold set BEFORE the backfill (§17). Lock it (like the usefulness-judge gold) so runs are comparable.
- **REVERSIBILITY + ORDER (spec §13):** schema (done in Plan A) → seed → validate(gold+thresholds) → backfill(match-only, NEVER create) → verify → flip. Backfill sets ONLY `workstream_id` (reversible: `UPDATE sessions SET workstream_id=NULL WHERE binding_source='classifier'`). The flag stays OFF until R6. Each step is independently reversible; do not reorder.
- **NO re-embedding:** the embedder/endpoint is unchanged, so the embedding space is stable — do NOT run `reembedCorpus`. The matcher reuses existing `session_embeddings` via `semanticSearch`. (If the embedder is ever swapped, that is a separate re-embed-then-verify task, per the repo rule — not part of Plan D.)
- **LIVE-SYSTEM rigor (do not reason from theory):** R-steps run against the real `~/.nlm/canonical.sqlite`. Verify on the real DB before asserting (query counts, inspect bindings). The daemon must be confirmed-down or the binding flag confirmed-OFF before any backfill write, so a concurrent sweep can't race the backfill.
- **Public-repo hygiene:** nlm-memory is PUBLIC. `~/.nlm/work-topics.json`, `~/.nlm/eval/gold-matcher.jsonl`, and `~/.nlm/canonical.sqlite` are operator-local and NEVER committed. Scripts that read them must reference `~/.nlm/...` (resolve `homedir()`), never hard-code `/Users/<username>/...`. Stage only each task's named files (never `git add .`; the untracked `scripts/eval/judge-calibration.ts` must NOT be staged). No home paths, host IPs, or client/infra/venture names in any commit (the seed file's project names live only in the operator-local JSON, never in committed code or fixtures). Do NOT push (Edward controls the public push); the daemon restart + the flag flip happen on Edward's machine after he pushes.

---

## File Structure

**New:**
- `src/core/workstream/build-match-inputs.ts` — `buildMatchInputs(deps, input): Promise<MatchInputs>`: the embed→neighbors→candidates assembly extracted verbatim from `bind.ts`. Pure-of-side-effects (reads only). Runtime (`bind.ts`) + eval (`tune-matcher`) + backfill all call it (spec §15).
- `tests/unit/core/workstream/build-match-inputs.test.ts`
- `scripts/seed-workstreams.ts` — read `~/.nlm/work-topics.json`, create `active` workstreams + populate `workstream_entities`; idempotent.
- `tests/unit/scripts/parse-work-topics.test.ts` — unit test on the pure `parseWorkTopics(json)`.
- `src/core/workstream/backfill-workstreams.ts` — `backfillWorkstreams(deps, opts)`: resumable match-only backfill core (mirrors `backfill-facts.ts`).
- `tests/integration/backfill-workstreams.test.ts`
- `scripts/backfill-workstreams.ts` — thin CLI composition root invoking `backfillWorkstreams` against the live stack (mirrors how `backfill-facts` is invoked).

**Modified:**
- `src/core/workstream/bind.ts` — replace its inline embed→neighbors→candidates block with a call to `buildMatchInputs`; behavior-identical.
- `scripts/eval/tune-matcher.ts` — replace the stub prediction loop with the real `buildMatchInputs` + `matchWorkstream` per gold session; map decision → `Prediction`.
- `src/core/workstream/thresholds.ts` — set `DEFAULT_THRESHOLDS` from the R3 tune-matcher run (the only value change; commit happens in R-runbook, see Task 5 note).
- `tests/unit/core/workstream/match.test.ts` — add the deferred Plan A exact-boundary tests (score==high binds, score==low → ambiguous) [Plan A deferred minor].
- `src/core/workstream/bind.ts` — add the deferred Plan A one-line orphan-workstream comment [Plan A deferred minor].

---

## Canonical Contracts (defined once; every task uses these names)

```typescript
// src/core/workstream/build-match-inputs.ts:
export interface BuildMatchInputsDeps {
  readonly workstreams: Pick<import("@ports/workstream-store.js").WorkstreamStore, "listAll" | "candidatesByEntityOverlap" | "entitiesFor">;
  readonly sessions: Pick<import("@ports/session-store.js").SessionStore, "semanticSearch" | "getWorkstreamIds">;
  readonly embedder: Pick<import("@ports/llm-client.js").LLMClient, "embed">;
  readonly thresholds: import("@core/workstream/model.js").MatchThresholds;
  readonly weights: import("@core/workstream/model.js").MatchWeights;
}
export interface BuildMatchInputsInput {
  readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>;
}
/** Embed label+summary as a query, gather semantic-neighbor + entity-overlap candidates,
 *  return the MatchInputs the matcher consumes. READ-ONLY: no create, no bind. (spec §15) */
export function buildMatchInputs(deps: BuildMatchInputsDeps, input: BuildMatchInputsInput): Promise<import("@core/workstream/model.js").MatchInputs>;

// scripts/seed-workstreams.ts (pure parser, exported for test):
export interface WorkTopic { readonly label: string; readonly entities: ReadonlyArray<string>; }
export function parseWorkTopics(raw: unknown): ReadonlyArray<WorkTopic>;

// src/core/workstream/backfill-workstreams.ts:
export interface BackfillWorkstreamsDeps {
  readonly buildInputs: (input: BuildMatchInputsInput) => Promise<import("@core/workstream/model.js").MatchInputs>;
  readonly setBinding: (sessionId: string, workstreamId: string, confidence: number | null) => Promise<void>;
  readonly listSessions: () => Promise<ReadonlyArray<BuildMatchInputsInput>>;  // historical sessions to consider
  readonly log?: (msg: string) => void;
}
export interface BackfillResult { readonly considered: number; readonly bound: number; readonly skipped: number; }
/** Match-only: for each session, build inputs + matchWorkstream; bind ONLY on kind==="bind"
 *  (never create, never ambiguous-LLM). Sets workstream_id + binding_source=classifier. Reversible. */
export function backfillWorkstreams(deps: BackfillWorkstreamsDeps): Promise<BackfillResult>;
```

---

## Task 1: Extract `buildMatchInputs` (DRY — one matcher pipeline for runtime + eval + backfill)

**Files:**
- Create: `src/core/workstream/build-match-inputs.ts`
- Create: `tests/unit/core/workstream/build-match-inputs.test.ts`
- Modify: `src/core/workstream/bind.ts` (call the extracted fn; behavior-identical)

**Interfaces:**
- Produces: `buildMatchInputs(deps, input): Promise<MatchInputs>` (see Canonical Contracts).
- Consumes: existing `SessionStore.semanticSearch/getWorkstreamIds`, `WorkstreamStore.listAll/candidatesByEntityOverlap/entitiesFor`, `LLMClient.embed`, `resolveWorkstreamId`.

**Background (verified):** `bind.ts:28-44` builds the matcher inputs: `embed(\`${label}\n${summary}\`, "query")` → `semanticSearch(vector, NEIGHBOR_K=10)` (drop self) → `listAll()` + `byId` map → `getWorkstreamIds(neighbor ids)` → per-neighbor `neighborScores` via `clamp01(1 - (distance*distance)/2)` (max per ws, resolved through `merged_into`) → `candidatesByEntityOverlap(entities, 10)` → union candidate ids → `entitiesFor([...candIds])` → `candidates: WorkstreamCandidate[]`. Then `matchWorkstream({sessionEntities: entities, neighborScores, candidates, thresholds, weights})`. The extraction takes EXACTLY that input-building block (not the decision, not the side-effects) into a new module; `bind.ts` then does `const inputs = await buildMatchInputs(deps, input); const decision = matchWorkstream(inputs);`. `NEIGHBOR_K` and `clamp01` move with it (or are re-declared in the new module and removed from bind.ts).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/workstream/build-match-inputs.test.ts
import { describe, expect, it } from "vitest";
import { buildMatchInputs } from "../../../../src/core/workstream/build-match-inputs.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../../../../src/core/workstream/thresholds.js";

function deps(over: Partial<any> = {}) {
  return {
    embedder: { embed: async () => ({ vector: [0.1, 0.2] }) },
    sessions: {
      semanticSearch: async () => [{ sessionId: "n1", distance: 0.2 }, { sessionId: "self", distance: 0 }],
      getWorkstreamIds: async () => new Map([["n1", "ws_a"]]),
    },
    workstreams: {
      listAll: async () => [{ id: "ws_a", label: "A", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
      candidatesByEntityOverlap: async () => [{ workstreamId: "ws_a", entities: ["x"] }],
      entitiesFor: async () => new Map([["ws_a", ["x"]]]),
    },
    thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_WEIGHTS,
    ...over,
  } as any;
}

describe("buildMatchInputs", () => {
  it("assembles neighbor scores + entity candidates and excludes the session itself", async () => {
    const inputs = await buildMatchInputs(deps(), { sessionId: "self", label: "L", summary: "S", entities: ["x"] });
    expect(inputs.sessionEntities).toEqual(["x"]);
    expect(inputs.candidates.map((c) => c.workstreamId)).toContain("ws_a");
    expect(inputs.neighborScores.get("ws_a")).toBeGreaterThan(0);   // n1 contributed; self excluded
    expect(inputs.thresholds).toBe(DEFAULT_THRESHOLDS);
  });
  it("resolves a neighbor's merged workstream to the survivor", async () => {
    const d = deps({
      sessions: {
        semanticSearch: async () => [{ sessionId: "n1", distance: 0.2 }],
        getWorkstreamIds: async () => new Map([["n1", "ws_old"]]),
      },
      workstreams: {
        listAll: async () => [
          { id: "ws_old", label: "Old", status: "merged", mergedInto: "ws_new", createdAt: "t", updatedAt: "t", lastSessionAt: null },
          { id: "ws_new", label: "New", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
        ],
        candidatesByEntityOverlap: async () => [],
        entitiesFor: async () => new Map([["ws_new", ["x"]]]),
      },
    });
    const inputs = await buildMatchInputs(d, { sessionId: "self", label: "L", summary: "S", entities: ["x"] });
    expect(inputs.neighborScores.has("ws_new")).toBe(true);   // survivor, not ws_old
    expect(inputs.neighborScores.has("ws_old")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/workstream/build-match-inputs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `build-match-inputs.ts` (lift the block from `bind.ts`)**

```typescript
// src/core/workstream/build-match-inputs.ts
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import type { MatchInputs, MatchThresholds, MatchWeights, WorkstreamCandidate } from "./model.js";
import { resolveWorkstreamId } from "./resolve.js";

const NEIGHBOR_K = 10;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface BuildMatchInputsDeps {
  readonly workstreams: Pick<WorkstreamStore, "listAll" | "candidatesByEntityOverlap" | "entitiesFor">;
  readonly sessions: Pick<SessionStore, "semanticSearch" | "getWorkstreamIds">;
  readonly embedder: Pick<LLMClient, "embed">;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
}
export interface BuildMatchInputsInput {
  readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>;
}

export async function buildMatchInputs(deps: BuildMatchInputsDeps, input: BuildMatchInputsInput): Promise<MatchInputs> {
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

  return { sessionEntities: input.entities, neighborScores, candidates, thresholds: deps.thresholds, weights: deps.weights };
}
```

- [ ] **Step 4: Refactor `bind.ts` to use it (behavior-identical)**

In `bind.ts`, replace lines from `const { vector } = await deps.embedder.embed(...)` through the `const decision = matchWorkstream({...})` so that the input-building is delegated:
```typescript
import { buildMatchInputs } from "./build-match-inputs.js";
// ...inside bindSessionToWorkstream, replacing the inline block:
    const inputs = await buildMatchInputs(deps, {
      sessionId: input.sessionId, label: input.label, summary: input.summary, entities: input.entities,
    });
    const decision = matchWorkstream(inputs);
```
Delete the now-unused `NEIGHBOR_K`/`clamp01`/`resolveWorkstreamId` import from `bind.ts` IF nothing else there uses them (check `createOrDedup` and the rest — `resolveWorkstreamId` is only used in the lifted block; `clamp01`/`NEIGHBOR_K` likewise). `BindDeps` already structurally satisfies `BuildMatchInputsDeps` (it has `workstreams`, `sessions` with the needed methods, `embedder`, `thresholds`, `weights`) — pass `deps` directly.

- [ ] **Step 5: Run the new test + full suite (bind.ts behavior unchanged) + typecheck**

Run: `npx vitest run tests/unit/core/workstream/build-match-inputs.test.ts && npm run test && npm run typecheck`
Expected: PASS — the existing bind.ts tests still pass (behavior-identical refactor), and the new test passes.

- [ ] **Step 6: build:server (daemon compiles) + commit**

Run: `npm run build:server`  (confirm clean; do NOT restart the daemon — deferred post-push)
```bash
git add src/core/workstream/build-match-inputs.ts src/core/workstream/bind.ts tests/unit/core/workstream/build-match-inputs.test.ts
git commit -m "refactor(workstream): extract buildMatchInputs — one matcher pipeline for runtime + eval + backfill (#367 §15)"
```

---

## Task 2: Seed loader — `~/.nlm/work-topics.json` → active workstreams + entities

**Files:**
- Create: `scripts/seed-workstreams.ts` (exports pure `parseWorkTopics`, plus a `main()` composition root)
- Create: `tests/unit/scripts/parse-work-topics.test.ts`

**Interfaces:**
- Produces: `parseWorkTopics(raw): ReadonlyArray<WorkTopic>` (pure), and a runnable `npx tsx scripts/seed-workstreams.ts`.
- Consumes: `WorkstreamStore.{findByNormalizedLabel, create, upsertEntities}` (Plan A), `makeWorkstreamId`/`normalizeLabel` (`model.ts`).

**Background (verified):** No seed loader exists yet. `~/.nlm/work-topics.json` is the operator-local alias map (already loaded by the work-digest's `loadTopicProvider` as an alias map; here we read it as the workstream seed). Its shape is operator-defined; `parseWorkTopics` must tolerate the two plausible shapes and normalize to `{label, entities[]}`: (a) an object map `{ "<label>": ["<entity>", ...], ... }` (alias-map style), or (b) an array `[{ "label": "...", "entities": [...] }]`. Validate at this boundary (fail loud on a shape that is neither). Seeding is idempotent: for each topic, if `findByNormalizedLabel(normalizeLabel(label))` exists, skip create (but still `upsertEntities` to top up the index); else `create({id: makeWorkstreamId(), label})` then `upsertEntities`. Status defaults to `active` (the `create` insert leaves the schema default, which is `active` per `025_workstreams.sql`).

- [ ] **Step 1: Write the failing unit test (pure parser)**

```typescript
// tests/unit/scripts/parse-work-topics.test.ts
import { describe, expect, it } from "vitest";
import { parseWorkTopics } from "../../../scripts/seed-workstreams.js";

describe("parseWorkTopics", () => {
  it("parses the object-map shape", () => {
    const out = parseWorkTopics({ "Project Alpha": ["alpha", "a-cli"], "Project Beta": ["beta"] });
    expect(out).toEqual([
      { label: "Project Alpha", entities: ["alpha", "a-cli"] },
      { label: "Project Beta", entities: ["beta"] },
    ]);
  });
  it("parses the array shape", () => {
    const out = parseWorkTopics([{ label: "Gamma", entities: ["g1", "g2"] }]);
    expect(out).toEqual([{ label: "Gamma", entities: ["g1", "g2"] }]);
  });
  it("throws on an unrecognized shape", () => {
    expect(() => parseWorkTopics(42)).toThrow();
    expect(() => parseWorkTopics([{ nope: true }])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/parse-work-topics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scripts/seed-workstreams.ts`**

```typescript
// scripts/seed-workstreams.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkTopic { readonly label: string; readonly entities: ReadonlyArray<string>; }

export function parseWorkTopics(raw: unknown): ReadonlyArray<WorkTopic> {
  if (Array.isArray(raw)) {
    return raw.map((t) => {
      if (!t || typeof t !== "object" || typeof (t as any).label !== "string" || !Array.isArray((t as any).entities)) {
        throw new Error(`work-topics: array item is not {label, entities[]}: ${JSON.stringify(t)}`);
      }
      return { label: (t as any).label, entities: ((t as any).entities as unknown[]).map(String) };
    });
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([label, ents]) => {
      if (!Array.isArray(ents)) throw new Error(`work-topics: value for "${label}" is not an array`);
      return { label, entities: ents.map(String) };
    });
  }
  throw new Error("work-topics: expected an object map or an array of {label, entities[]}");
}

async function main(): Promise<void> {
  const path = process.argv.find((a) => a.startsWith("--file="))?.slice(7)?.replace(/^~/, homedir())
    ?? join(homedir(), ".nlm", "work-topics.json");
  const topics = parseWorkTopics(JSON.parse(readFileSync(path, "utf8")));

  const { buildStack } = await import("../src/cli/build-stack.js").catch(() => ({ buildStack: null as any }));
  if (!buildStack) {
    // Fallback: open the canonical sqlite stack the same way the other eval scripts do.
    throw new Error("Wire this to the project's stack builder; see scripts/eval/lib/transcript.ts for the canonical open pattern.");
  }
  const { storage } = await buildStack();
  try {
    const { makeWorkstreamId, normalizeLabel } = await import("../src/core/workstream/model.js");
    let created = 0; let topped = 0;
    for (const t of topics) {
      const existing = await storage.workstreams.findByNormalizedLabel(normalizeLabel(t.label));
      const ws = existing ?? (await storage.workstreams.create({ id: makeWorkstreamId(), label: t.label }));
      if (!existing) created++; else topped++;
      await storage.workstreams.upsertEntities(ws.id, t.entities);
    }
    process.stdout.write(`seed-workstreams: ${topics.length} topics -> ${created} created, ${topped} already-present (entities topped up)\n`);
  } finally {
    await storage.close();
  }
}

// Run only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
}
```
(NOTE for the implementer: the `buildStack` import path is illustrative — find the ACTUAL composition-root the repo's scripts use to open the live `SqliteStorage` (grep how `backfill-facts` / `dump-matcher-candidates.ts` open the stack; `scripts/eval/lib/transcript.ts` has `openSessionContext`). Use that real pattern; do not invent a new stack builder. The pure `parseWorkTopics` + the idempotent seed loop are the load-bearing logic and are fully specified above.)

- [ ] **Step 4: Run unit test to verify it passes + typecheck**

Run: `npx vitest run tests/unit/scripts/parse-work-topics.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-workstreams.ts tests/unit/scripts/parse-work-topics.test.ts
git commit -m "feat(workstream): seed loader — work-topics.json -> active workstreams + entities (#367 §13)"
```

---

## Task 3: Wire the real matcher into `tune-matcher.ts` (replace the stub)

**Files:**
- Modify: `scripts/eval/tune-matcher.ts` (replace the stub prediction loop)
- (Optional) Modify: `scripts/eval/lib/matcher-gold.ts` only if a decision→Prediction mapping helper is cleaner there

**Interfaces:**
- Consumes: `buildMatchInputs` (Task 1), `matchWorkstream` (Plan A), `loadGold/scoreGold/sweepThresholds` + `Prediction` (Plan A harness), `openSessionContext` (`scripts/eval/lib/transcript.ts`), the live stack opener used by the other eval scripts.
- Produces: a runnable `tune-matcher.ts` that emits REAL predictions; no exported API change.

**Background (verified):** `tune-matcher.ts` (Plan A stub) already loads gold via `loadGold`, opens `openSessionContext()`, and emits stub `Prediction{predicted:null,score:0}`. The wiring per gold session: build `MatchInputs` via `buildMatchInputs`, get the TOP candidate's id AND raw score (regardless of band), map to `Prediction{goldWorkstream, predicted: topId, score: topScore}` so `sweepThresholds` can pick HIGH/LOW from the raw score grid. The live workstream store + embedder + session store come from the real stack opener. This is a MATCH-ONLY run (read-only).

> **CRITICAL CORRECTIONS from critical-review (apply exactly):**
> 1. **Entities source.** `openSessionContext().get(id)` returns a STRING (`\`${label}\n${summary}\n${body}\``, `scripts/eval/lib/transcript.ts`), NOT an object with `.entities`. Do NOT read `sctx.entities` — it does not exist and would silently zero the entity-Jaccard half of every score, corrupting the threshold sweep. Source entities from the real store: `await storage.sessions.getEntities(g.sessionId)` (`SessionStore.getEntities`, sqlite impl confirmed). The tuner already opens `storage` for `buildMatchInputs`, so this is the same handle.
> 2. **One scoring formula (spec §15).** Do NOT recompute the candidate score inline in the tuner — that duplicates `match.ts` and diverges the moment scoring changes (e.g. the §18 IDF-weighting open question). Extract `scoreCandidates(inputs)` from `match.ts` and have BOTH `matchWorkstream` and the tuner call it (Step 1 below). The inline-recompute approach is forbidden.

- [ ] **Step 1: Extract `scoreCandidates` from `match.ts` (the §15 one-source-of-truth step) + 1-line test**

`matchWorkstream` (`match.ts:13-32`) already computes a sorted `scored` list internally. Extract it:
```typescript
// src/core/workstream/match.ts — new export; matchWorkstream calls it instead of inlining.
export function scoreCandidates(inputs: MatchInputs): Array<{ workstreamId: string; score: number }> {
  const { sessionEntities, neighborScores, candidates, weights } = inputs;
  return candidates
    .map((c) => ({
      workstreamId: c.workstreamId,
      score: weights.semantic * (neighborScores.get(c.workstreamId) ?? 0) + weights.entity * jaccard(sessionEntities, c.entities),
    }))
    .sort((x, y) => y.score - x.score);
}
```
Refactor `matchWorkstream` to `const scored = scoreCandidates(inputs);` (delete the inline `.map(...).sort(...)`), keeping the band logic (`top.score < thresholds.low` → create; `>= thresholds.high` → bind; else ambiguous) unchanged. Add a test:
```typescript
// add to tests/unit/core/workstream/match.test.ts
import { scoreCandidates } from "../../../../src/core/workstream/match.js";
it("scoreCandidates returns candidates sorted by combined score desc", () => {
  const out = scoreCandidates({
    sessionEntities: ["x"], neighborScores: new Map([["ws_a", 0.9], ["ws_b", 0.1]]),
    candidates: [{ workstreamId: "ws_a", entities: ["x"] }, { workstreamId: "ws_b", entities: [] }],
    thresholds: { high: 0.5, low: 0.3 }, weights: { semantic: 0.5, entity: 0.5 },
  });
  expect(out[0]!.workstreamId).toBe("ws_a");
  expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
});
```
Run: `npx vitest run tests/unit/core/workstream/match.test.ts && npm run typecheck` → PASS (existing `matchWorkstream` tests still green — behavior-identical).

- [ ] **Step 2: Wire the real matcher into `tune-matcher.ts`**

Replace the stub loop (correctness verified by the R3 runbook run on real data; this is an eval script edit, no live-data unit gate is practical):
```typescript
import { buildMatchInputs } from "../../src/core/workstream/build-match-inputs.js";
import { scoreCandidates } from "../../src/core/workstream/match.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../../src/core/workstream/thresholds.js";
// open the live stack the same way signals-eval.ts / dump-matcher-candidates.ts do:
//   const storage = SqliteStorage.create({ dbPath: DB, migrationsDir: MIGRATIONS_DIR }); await storage.init();
//   const embedder = new OllamaClient({});   // (the real embedder the other eval scripts use)
const preds: Prediction[] = [];
for (const g of gold) {
  const entities = await storage.sessions.getEntities(g.sessionId);   // REAL entities — not sctx
  const inputs = await buildMatchInputs(
    { workstreams: storage.workstreams, sessions: storage.sessions, embedder, thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_WEIGHTS },
    { sessionId: g.sessionId, label: g.label, summary: g.summary, entities },
  );
  // embed kind is "query", inherited from buildMatchInputs — do NOT hand-roll an embed call (would risk a kind mismatch).
  const top = scoreCandidates(inputs)[0];   // raw top score+id regardless of band, so sweepThresholds sees every cut
  preds.push({ goldWorkstream: g.goldWorkstream, predicted: top?.workstreamId ?? null, score: top?.score ?? 0 });
}
```
(`DEFAULT_THRESHOLDS` values are irrelevant here — we read raw scores via `scoreCandidates`, never the banded decision — so any thresholds compile; passing `DEFAULT_THRESHOLDS` just satisfies the `MatchInputs` type. The `ctx`/`openSessionContext` from the stub can be removed if nothing else uses it.)

- [ ] **Step 3: Verify it typechecks + dry-runs without a gold file gracefully**

Run: `npm run typecheck` and `npx tsx scripts/eval/tune-matcher.ts --gold=/dev/null` (should print `gold n=0` and exit cleanly, not crash).
Expected: typecheck clean; empty-gold run prints the no-threshold message.

- [ ] **Step 4: Commit**

```bash
git add scripts/eval/tune-matcher.ts src/core/workstream/match.ts tests/unit/core/workstream/match.test.ts
git commit -m "feat(workstream): scoreCandidates extraction + wire real matcher into tune-matcher sweep (#367 §13 §15)"
```

---

## Task 4: Match-only backfill core + CLI

**Files:**
- Modify: `src/core/workstream/model.ts` (add `"backfill"` to the `BindingSource` union — additive, no migration)
- Create: `src/core/workstream/backfill-workstreams.ts`
- Create: `tests/integration/backfill-workstreams.test.ts`
- Create: `scripts/backfill-workstreams.ts` (thin composition root)

**Interfaces:**
- Consumes: `buildMatchInputs` (Task 1), `matchWorkstream` (Plan A), `SessionStore.setWorkstreamBinding` (Plan A).
- Produces: `backfillWorkstreams(deps): Promise<BackfillResult>`, runnable `npx tsx scripts/backfill-workstreams.ts`.

**Background (verified):** `backfill-facts.ts` is the resumable-backfill template (state file at `~/.nlm/backfill_facts.state`, listed candidates, per-row work). The workstream backfill is simpler and MATCH-ONLY: for each historical session, `matchWorkstream(buildMatchInputs(...))`; bind ONLY when `decision.kind==="bind"` (deterministic auto-bind, score ≥ HIGH) — NEVER create, NEVER invoke the ambiguous-LLM path (no LLM fan-out across history, spec §13). Unmatched sessions stay NULL (forward binding picks them up after the flip). Reversible (sets only `workstream_id`). The core takes injected `buildInputs`/`setBinding`/`listSessions` deps so it is unit-testable without the live stack.

> **CRITICAL CORRECTIONS from critical-review (apply exactly):**
> 1. **Distinct `binding_source='backfill'` (reversal safety).** Forward binding writes `binding_source='classifier'` (bind.ts). If the backfill ALSO writes `'classifier'`, the reversal query `WHERE binding_source='classifier'` cannot distinguish backfill-bound from forward-bound sessions — safe ONLY while the flag is OFF, but destructive if ever run post-flip (it would wipe legitimately forward-bound sessions). Fix: add `"backfill"` to the `BindingSource` union (`src/core/workstream/model.ts`: `"classifier" | "operator" | "backfill"`) — additive, the DB column is free-text TEXT so NO migration — and the backfill CLI binds with source `"backfill"`. Then the R4/R6 reversal is surgical: `WHERE binding_source='backfill'`, safe at any time. When adding the union member, grep for any exhaustive `switch`/comparison on `BindingSource` and handle the new arm (there are none today that need a code branch, but confirm).
> 2. **`listSessions` MUST include entities.** `BuildMatchInputsInput` requires `entities`; the historical-session projection (mirroring `dump-matcher-candidates.ts`'s `SELECT id,label,COALESCE(summary,'')...`) does NOT select entities. Add `await storage.sessions.getEntities(id)` per session (or a join) so the backfill matches on real entities — omitting them zeroes the entity-Jaccard half exactly like the Task 3 bug. Do NOT ship a backfill that matches on empty entities.

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/backfill-workstreams.test.ts
import { describe, expect, it } from "vitest";
import { backfillWorkstreams } from "../../src/core/workstream/backfill-workstreams.js";
import { DEFAULT_WEIGHTS } from "../../src/core/workstream/thresholds.js";

describe("backfillWorkstreams (match-only)", () => {
  it("binds sessions that match >= HIGH and skips the rest, never creating", async () => {
    const bound: Array<{ s: string; w: string }> = [];
    const HIGH = 0.6;
    // session s1 has a strong entity match to ws_a; s2 matches nothing.
    const deps = {
      listSessions: async () => [
        { sessionId: "s1", label: "L1", summary: "S1", entities: ["x", "y"] },
        { sessionId: "s2", label: "L2", summary: "S2", entities: ["zzz"] },
      ],
      buildInputs: async (input: any) => ({
        sessionEntities: input.entities,
        neighborScores: new Map(input.sessionId === "s1" ? [["ws_a", 0.9]] : []),
        candidates: input.sessionId === "s1" ? [{ workstreamId: "ws_a", entities: ["x", "y"] }] : [],
        thresholds: { high: HIGH, low: 0.3 },
        weights: DEFAULT_WEIGHTS,
      }),
      setBinding: async (s: string, w: string) => { bound.push({ s, w }); },
    } as any;
    const res = await backfillWorkstreams(deps);
    expect(res.bound).toBe(1);
    expect(bound).toEqual([{ s: "s1", w: "ws_a" }]);   // only the >=HIGH match bound
    expect(res.considered).toBe(2);
    expect(res.skipped).toBe(1);                        // s2 unmatched, left NULL
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/backfill-workstreams.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `backfill-workstreams.ts`**

```typescript
// src/core/workstream/backfill-workstreams.ts
import { matchWorkstream } from "./match.js";
import type { MatchInputs } from "./model.js";

export interface BuildMatchInputsInput {
  readonly sessionId: string; readonly label: string; readonly summary: string; readonly entities: ReadonlyArray<string>;
}
export interface BackfillWorkstreamsDeps {
  readonly buildInputs: (input: BuildMatchInputsInput) => Promise<MatchInputs>;
  readonly setBinding: (sessionId: string, workstreamId: string, confidence: number | null) => Promise<void>;
  readonly listSessions: () => Promise<ReadonlyArray<BuildMatchInputsInput>>;
  readonly log?: (msg: string) => void;
}
export interface BackfillResult { readonly considered: number; readonly bound: number; readonly skipped: number; }

export async function backfillWorkstreams(deps: BackfillWorkstreamsDeps): Promise<BackfillResult> {
  const sessions = await deps.listSessions();
  let bound = 0; let skipped = 0;
  for (const s of sessions) {
    const decision = matchWorkstream(await deps.buildInputs(s));
    if (decision.kind === "bind") {
      await deps.setBinding(s.sessionId, decision.workstreamId, decision.confidence);
      bound++;
      deps.log?.(`[backfill] ${s.sessionId} -> ${decision.workstreamId} (${decision.confidence?.toFixed(3)})`);
    } else {
      skipped++;   // ambiguous or create: leave NULL, forward binding handles it (never create in backfill)
    }
  }
  return { considered: sessions.length, bound, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/backfill-workstreams.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the thin CLI composition root `scripts/backfill-workstreams.ts`**

```typescript
// scripts/backfill-workstreams.ts — match-only historical backfill against the live stack.
// Reuses buildMatchInputs (Task 1) so the backfill matcher == the runtime matcher (spec §15).
import { buildMatchInputs } from "../src/core/workstream/build-match-inputs.js";
import { backfillWorkstreams } from "../src/core/workstream/backfill-workstreams.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../src/core/workstream/thresholds.js";

async function main(): Promise<void> {
  // Open the live stack the same way backfill-facts / dump-matcher-candidates do (find the real opener).
  // const { storage, embedder } = await openEvalStack();
  // Build the historical session list from the canonical store (id,label,summary,entities) — reuse the
  // same projection dump-matcher-candidates.ts already uses to list sessions.
  const res = await backfillWorkstreams({
    // Historical sessions projection: mirror dump-matcher-candidates.ts's SELECT id,label,COALESCE(summary,'')
    // AND fetch entities per session (getEntities) — entities are required by BuildMatchInputsInput.
    listSessions: async () => {
      const base = /* SELECT id,label,summary from sessions — reuse the dump-matcher projection */ [] as Array<{ sessionId: string; label: string; summary: string }>;
      return Promise.all(base.map(async (s) => ({ ...s, entities: await storage.sessions.getEntities(s.sessionId) })));
    },
    buildInputs: (input) => buildMatchInputs(
      { workstreams: storage.workstreams, sessions: storage.sessions, embedder, thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_WEIGHTS },
      input,
    ),
    setBinding: (s, w, c) => storage.sessions.setWorkstreamBinding(s, w, "backfill", c),   // distinct source for surgical reversal
    log: (m) => process.stdout.write(m + "\n"),
  });
  process.stdout.write(`backfill-workstreams: considered ${res.considered}, bound ${res.bound}, skipped ${res.skipped}\n`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
}
```
(NOTE for the implementer: fill `storage`/`embedder`/the historical-session projection from the REAL stack opener + the existing session-listing query that `dump-matcher-candidates.ts` already uses — do not invent. The DEFAULT_THRESHOLDS here are replaced by the gold-derived values from Task 5 BEFORE the R4 backfill run; the script always imports the current `DEFAULT_THRESHOLDS`, so updating `thresholds.ts` in Task 5 is what makes the backfill use the tuned cut. The core `backfillWorkstreams` is fully tested above; this root is thin glue verified by the R4 dry-run.)

- [ ] **Step 6: Full suite + typecheck + build:server + commit**

Before committing, extend the `BindingSource` union in `src/core/workstream/model.ts` to `"classifier" | "operator" | "backfill"` (additive; the DB column is free-text TEXT so no migration; grep for any exhaustive `BindingSource` switch and handle the new arm — none today need a branch, confirm). The backfill CLI's `setWorkstreamBinding(..., "backfill", ...)` depends on this.

Run: `npm run test && npm run typecheck && npm run build:server`
Expected: PASS / clean.
```bash
git add src/core/workstream/model.ts src/core/workstream/backfill-workstreams.ts scripts/backfill-workstreams.ts tests/integration/backfill-workstreams.test.ts
git commit -m "feat(workstream): match-only historical backfill (binding_source=backfill) core + CLI (#367 §13)"
```

---

## Task 5: Gold-derived thresholds + Plan A deferred-minor cleanup

> **This task's threshold VALUES come from the R3 runbook run.** Do the code-mechanical parts (exact-boundary tests, orphan comment) first; set the threshold numbers in the same commit AFTER R3 produces them. If executing Tasks 1–5 before the runbook, leave `DEFAULT_THRESHOLDS` provisional and do ONLY the boundary tests + comment here, then update the numbers during R3.

**Files:**
- Modify: `src/core/workstream/thresholds.ts` (set `DEFAULT_THRESHOLDS` from R3)
- Modify: `tests/unit/core/workstream/match.test.ts` (add exact-boundary tests — Plan A deferred minor)
- Modify: `src/core/workstream/bind.ts` (one-line orphan-workstream comment — Plan A deferred minor)

**Interfaces:** none new; tightens existing.

**Background (verified):** `match.test.ts` exists (Plan A). `matchWorkstream` uses `top.score < thresholds.low → create`, `top.score >= thresholds.high → bind`, else `ambiguous` — so the exact boundaries are: `score == high` → bind (`>=`), `score == low` → ambiguous (NOT create, since `< low` is strict). These are the deferred Plan A minors: lock the `>=`/`<` operators against regression. The orphan-workstream comment is the Plan A Task 8 deferred minor: in `createOrDedup`/the create path, a `create()` that succeeds before a later persist throws can leave an inert orphan workstream (acceptable under fail-open; dedup folds it next time) — document it in one line.

- [ ] **Step 1: Write the failing boundary tests**

```typescript
// add to tests/unit/core/workstream/match.test.ts
import { matchWorkstream } from "../../../../src/core/workstream/match.js";

it("binds when the top score exactly equals HIGH (>= boundary)", () => {
  const d = matchWorkstream({
    sessionEntities: ["x"], neighborScores: new Map([["ws_a", 1]]),
    candidates: [{ workstreamId: "ws_a", entities: ["x"] }],
    thresholds: { high: 0.5, low: 0.3 }, weights: { semantic: 0.5, entity: 0.5 }, // 0.5*1 + 0.5*1 = 1.0 ... pick weights to land ON high
  });
  expect(d.kind).toBe("bind");
});
it("is ambiguous (not create) when the top score exactly equals LOW", () => {
  // Construct inputs whose top score == low exactly, assert kind === "ambiguous".
  const d = matchWorkstream({
    sessionEntities: ["x"], neighborScores: new Map([["ws_a", 0.6]]),
    candidates: [{ workstreamId: "ws_a", entities: [] }],          // entity jaccard 0
    thresholds: { high: 0.5, low: 0.3 }, weights: { semantic: 0.5, entity: 0.5 }, // 0.5*0.6 + 0 = 0.30 == low
  });
  expect(d.kind).toBe("ambiguous");
});
```
(VERIFY the arithmetic when implementing: pick `neighborScores`/`weights` so the computed `top.score` lands EXACTLY on `high` for the first test and EXACTLY on `low` for the second — the comment shows the intended product. Adjust the numbers to hit the boundary precisely; the assertion is the contract.)

- [ ] **Step 2: Run to verify they pass (the operators are already correct; these LOCK them)**

Run: `npx vitest run tests/unit/core/workstream/match.test.ts`
Expected: PASS (these are regression-guards, not red-first — `matchWorkstream` already implements `>=`/`<`; if either FAILS, that is a real bug to fix in `match.ts`).

- [ ] **Step 3: Add the orphan-workstream comment in `bind.ts`**

In `createOrDedup` (or at the `create` call site), add:
```typescript
  // NOTE: a create() that succeeds before a later persist throws can leave an inert orphan
  // workstream. Acceptable under fail-open — it has no sessions, surfaces in no rollup, and
  // dedup-by-normalized-label folds it the next time the same label is proposed. (#367 §17)
```

- [ ] **Step 4: (RUNBOOK-COUPLED) set `DEFAULT_THRESHOLDS` from R3**

After R3 prints `HIGH = <h>  LOW = <l>`, set:
```typescript
export const DEFAULT_THRESHOLDS: MatchThresholds = { high: <h from R3>, low: <l from R3> };
```
Remove the "Provisional — replaced by the gold-set" comment (it is no longer provisional). If executing code-only ahead of the runbook, SKIP this step and do it during R3.

- [ ] **Step 5: Run tests + typecheck + build:server + commit**

Run: `npm run test && npm run typecheck && npm run build:server`
```bash
git add src/core/workstream/thresholds.ts tests/unit/core/workstream/match.test.ts src/core/workstream/bind.ts
git commit -m "feat(workstream): gold-derived match thresholds + boundary tests + orphan note (#367 §13)"
```

---

## ROLLOUT RUNBOOK (R1–R6) — controller-executed, in order, against the LIVE DB

> These are NOT subagent TDD tasks. They are a data/operational procedure on `~/.nlm/canonical.sqlite`, executed by the controller (with Edward in the loop for the irreversible flip). Each step is reversible until R6. Verify on the real DB at each step (do not assume).

- [ ] **R1 — Preconditions.** Confirm `NLM_WORKSTREAM_BIND` is OFF (it is, default) and the daemon is not mid-sweep writing bindings: `launchctl print gui/$(id -u)/com.github.pbmagnet4.nlm-memory` (or stop it) so the backfill can't race a sweep. Confirm `~/.nlm/work-topics.json` exists and parses. Confirm the embedder endpoint is up (LM Studio, nomic-v1.5) — the matcher needs it.

- [ ] **R2 — Seed.** `npx tsx scripts/seed-workstreams.ts`. Verify on the DB: `SELECT count(*) FROM workstreams WHERE status='active';` matches the topic count, and `SELECT count(*) FROM workstream_entities;` is non-zero. Idempotent — safe to re-run.

- [ ] **R3 — Gold set + thresholds (the load-bearing, independence-critical step).**
  1. Generate candidates: `npx tsx scripts/eval/dump-matcher-candidates.ts` → produces the candidate list for labeling.
  2. **Hand-label ~50 historical sessions INDEPENDENTLY of the seed map** into `~/.nlm/eval/gold-matcher.jsonl` (one `{key,sessionId,label,summary,goldWorkstream}` per line). Assign each `goldWorkstream` by reading the session's OWN transcript/label/summary and judging which workstream it belongs to — WITHOUT consulting `~/.nlm/work-topics.json` (spec §16/§17: grading the matcher against its own seed inflates precision). Lock the file (treat as immutable like the usefulness-judge gold).
  3. `npx tsx scripts/eval/tune-matcher.ts --min-recall=0.9` → reads the gold, runs the REAL matcher (Task 3 wiring), prints precision/recall + recommended `HIGH`/`LOW`.
  4. Put those numbers into `src/core/workstream/thresholds.ts` (Task 5 Step 4), re-run `npm run test && npm run typecheck && npm run build:server`, commit.

- [ ] **R4 — Match-only backfill.** With the tuned `DEFAULT_THRESHOLDS` committed: `npx tsx scripts/backfill-workstreams.ts`. It binds only `>=HIGH` matches, never creates. Verify on the DB: `SELECT count(*) FROM sessions WHERE workstream_id IS NOT NULL;` increased; spot-check 3–5 bindings are sane (`SELECT s.id, w.label FROM sessions s JOIN workstreams w ON s.workstream_id=w.id LIMIT 5;`). **Reversal if wrong (surgical, safe at any time):** `UPDATE sessions SET workstream_id=NULL, binding_source=NULL, binding_confidence=NULL WHERE binding_source='backfill';` then re-tune/re-backfill. (Targets ONLY backfill-written rows — never the forward-bound `'classifier'` rows that accumulate after the flip.)

- [ ] **R5 — Verify the digest reads workstream labels.** Run `nlm work-digest <a known venture-workstream day>` and `nlm work-digest <a known client-site day>` (the two days validated during brainstorming, spec §13). Confirm the topic is now the workstream LABEL (not the alphabetically-first entity / dotfile). The fallback still serves unbound days. If a day still shows entity-topics, those sessions were below HIGH at backfill — expected; forward binding picks them up after the flip.

- [ ] **R6 — FLIP (irreversible-ish; Edward in the loop).** Only after R2–R5 pass: set `NLM_WORKSTREAM_BIND=true` in the daemon environment (`~/.nlm/.env` or the launchctl plist `EnvironmentVariables`), then — AFTER Edward pushes main and the running dist matches source-of-truth — restart the daemon: `launchctl kickstart -k gui/$(id -u)/com.github.pbmagnet4.nlm-memory`. From here each ingested session auto-binds in the sweep. **Reversal:** set the flag back to anything but `true` and restart; existing bindings persist (harmless). To undo ONLY the historical backfill without touching post-flip forward bindings, use the R4 surgical query (`WHERE binding_source='backfill'`) — it is safe at any time because backfill and forward rows now carry distinct `binding_source` values. The alias map retires as a runtime stopgap and persists as the seed-of-record (spec §13).

---

## Self-Review

**1. Spec coverage (Plan D scope, §13 ordered steps):**
- §13.1 schema → done in Plan A (additive migration `025_workstreams.sql`) ✓ (no Plan D schema work)
- §13.2 seed from `~/.nlm/work-topics.json` → Task 2 + R2 ✓
- §13.3 validate on locked gold set hand-labeled INDEPENDENTLY of the seed; set HIGH/LOW from its distribution → Task 3 (wiring) + Task 5 (apply) + R3 (the independent labeling + tune run) ✓ (independence called out as a load-bearing constraint)
- §13.4 backfill match-only, NEVER create, reversible → Task 4 + R4 ✓
- §13.5 verify digest on the two historical days → R5 ✓
- §13.6 flip the topic provider / binding flag → R6 ✓ (the work-digest already prefers the workstream label when present, from Plan B; the flag controls forward BINDING; the provider swap landed in Plan B behind the same flag-OFF reality, so "flip" = enable binding so sessions HAVE labels for the already-swapped provider to read)
- §15 one source of truth (runtime + eval same matcher) → Task 1 `buildMatchInputs` reused by bind.ts + tune-matcher + backfill ✓
- §16/§17 gold set built BEFORE backfill, locked, independence → R3 before R4, locked, independence-stated ✓
- Plan A deferred minors folded into the flip wave (boundary tests, orphan comment) → Task 5 ✓
- Plan B deferred minors (recall_sessions merge-branch test; exercise real wiring) → fold into Task-4/Task-1 test additions OR a small R-step; NOT forgotten — see note below. ✓
- No re-embedding (embedder unchanged) → stated in Global Constraints ✓

**2. Placeholder scan:** the two thin composition roots (`seed-workstreams.ts main()`, `backfill-workstreams.ts main()`) carry EXPLICIT "find the real stack opener / session projection — do not invent" notes, because the exact live-stack open pattern must be copied from the repo's existing scripts (`backfill-facts.ts`, `dump-matcher-candidates.ts`, `scripts/eval/lib/transcript.ts`) rather than guessed. The LOAD-BEARING logic (`parseWorkTopics`, `buildMatchInputs`, `backfillWorkstreams` core, the decision→Prediction mapping) is fully specified and unit-tested. This is a deliberate read-then-mirror at the I/O boundary, not a hidden TODO. Task 3's score-reading note (`scoreCandidates` export vs inline jaccard) is flagged as a small in-task choice.

**3. Type consistency:** `buildMatchInputs`/`BuildMatchInputsDeps`/`BuildMatchInputsInput`, `parseWorkTopics`/`WorkTopic`, `backfillWorkstreams`/`BackfillWorkstreamsDeps`/`BackfillResult` defined once in Canonical Contracts and reused. `BindDeps` structurally satisfies `BuildMatchInputsDeps` (verified field-by-field against `bind.ts`). `setWorkstreamBinding(sessionId, workstreamId, "classifier", confidence)` matches the Plan A signature. `DEFAULT_THRESHOLDS`/`DEFAULT_WEIGHTS` import path is `thresholds.js`.

**Cross-plan + risk notes:**
- **Plan B deferred minors (decided):** add ONE standalone test commit after Task 4 (before R4) — a `tests/integration/recall-workstream-filter.test.ts` case that seeds a MERGED workstream and asserts `recall_sessions --workstream <survivor>` returns the ancestor-bound session, exercising the real `buildStack` resolver (not a hand-copy). Commit message `test(workstream): cover recall_sessions merge-chain filter via real wiring (#367)`. They are transitively covered today (resolve.test.ts/rollup.test.ts) so they do NOT block the flip, but this closes them cleanly.
- **Matcher precision is load-bearing (spec §17):** if R3 cannot find a HIGH cut meeting min-recall=0.9 at acceptable precision, DO NOT flip. Options before flipping: lower min-recall and accept more ambiguous→LLM, or add IDF-weighting to the entity Jaccard (spec §18 open question — resolve against the gold set, not by guess), or expand the seed. The flip is gated on the gold-set numbers being acceptable, not on a schedule.
- **Fail-open on the hot path (asymmetry):** binding runs in the sweep; a bind failure is logged + skipped (bind.ts already fail-opens), so a dropped binding never blocks ingest. This is why flipping is low-risk operationally once thresholds are sound.
- **Daemon restart timing:** never restart the live daemon on unpushed/feature-branch dist (repo rule #6). R6's restart happens AFTER Edward pushes main, so running config == source-of-truth.
