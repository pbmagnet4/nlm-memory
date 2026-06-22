# Retrieval Quality T1 Implementation Plan (Steps 1-4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four Tier-1 retrieval-quality wins for NLM (default-mode fix, scheduled eval gate, precision pass, re-derivation-rate metric) with no schema changes and a measurable before/after on each.

**Architecture:** All four changes ride on existing surfaces. Step 1 fixes a default-mode mismatch between the MCP pull-path and the hook auto-path. Step 2 adds a standing regression gate so every later change is provably non-regressing. Step 3 reduces context pollution (score floor) and makes the session hybrid lane match the evidence (keyword-primary banding, mirroring the fact lane's semantic-primary banding). Step 4 implements the re-derivation-rate outcome metric and the `continues` edges it depends on.

**Tech Stack:** TypeScript (ESM/NodeNext, `@core`/`@ports`/`@shared` aliases, explicit `.js` imports), Vitest, better-sqlite3, Hono, Commander CLI, Ollama (`nomic-embed-text` embeddings, `qwen3.5:4b` classifier). Eval harnesses are `tsx` scripts under `scripts/`.

## Global Constraints

- **No code before sign-off applies per task.** This plan is approved for build; still commit per-task and keep each task independently reviewable.
- **No schema migrations in this plan.** All four steps are T1. Any migration is out of scope (deferred T2 steps 5-8).
- **Defaults only for step 1.** Any caller passing an explicit `mode=` must be unaffected.
- **PUBLIC repo.** No home paths (`/Users/...`, `~/.nlm`, `~/.cache/...`, `~/Documents/nlm-private-bench`), no client/property names (TX Tax, GOAT, Tella, Qoverage), no infra names/IPs/hostnames in committed code, tests, fixtures, or docs. The operator's private benchmark corpus is referenced generically and never committed.
- **No em dashes, no emojis** in any user-facing content.
- **TDD.** Failing test first, minimal implementation, green, commit.
- **Run the full suite** (`npm test`) green before each commit; `npm run typecheck` clean.
- **Branch:** `feat/retrieval-quality-t1` off `main`.

---

## File Structure

- `src/mcp/server.ts` (modify) — session recall handler default mode + tool describe strings.
- `src/core/recall-facts/fact-recall-service.ts` (modify) — service default mode; `retired_at` in `makeFilterPredicate`.
- `src/core/recall/recall-service.ts` (modify) — replace RRF `mergeHybrid` with keyword-primary banding.
- `src/hook/session-start-hook.ts`, `src/hook/prompt-recall-hook.ts` (modify) — score floor from env, default calibrated value.
- `src/cli/nlm.ts` (modify) — register `nlm eval` subcommand.
- `src/core/eval/run-eval.ts` (create) — corpus-agnostic R@k/MRR runner consumed by the CLI and the gate.
- `scripts/eval/fact-recall-eval.ts` (modify) — add precision-under-distractor arm.
- `package.json` (modify) — add `eval:fact-recall` script.
- `tests/integration/fact-recall-gate.test.ts` (create) — tolerant fact-recall CI gate mirroring `recall-golden.test.ts`.
- `src/core/scheduler/scheduler.ts`, `src/core/storage/*-tx-context.ts` (modify) — write `continues` edges.
- `src/core/metrics/re-derivation.ts` (create) — the detector over `session_edges` + decision-Jaccard.
- `docs/methodology-recall-baseline.md` (modify) — replace the fictional scorer table with the real 3-leg FTS5 BM25 description.

---

## Task 1: Fix the default-mode mismatch (the headline win)

**Files:**
- Modify: `src/mcp/server.ts` (session handler `mode ?? "hybrid"` at the two sites in `recallSessionsHandler`, ~122 and ~142; tool describe at ~320 and schema describe at ~566)
- Modify: `src/core/recall-facts/fact-recall-service.ts:66` (`input.mode ?? "keyword"` -> `"hybrid"`)
- Modify: `docs/methodology-recall-baseline.md` (the entity-x4/label-x3/phrase-+5 table is fiction; replace with the real scorer)
- Test: `tests/unit/mcp/recall-defaults.test.ts` (create)

**Interfaces:**
- Consumes: `recallSessionsHandler(deps, input)`, `recallFactsHandler(deps, input)` from `src/mcp/server.ts`; `FactRecallService.search` from the fact service.
- Produces: no new exports. Behavior change: session MCP defaults to `keyword`; fact recall (MCP and service) defaults to `hybrid`.

- [ ] **Step 1: Write the failing test** asserting the post-fix defaults.

```ts
// tests/unit/mcp/recall-defaults.test.ts
import { describe, it, expect, vi } from "vitest";
import { recallSessionsHandler, recallFactsHandler } from "@/mcp/server.js";

describe("MCP recall default modes", () => {
  it("recall_sessions defaults to keyword when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallSessionsHandler({ recall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: "keyword" }));
  });

  it("recall_facts defaults to hybrid when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallFactsHandler({ factRecall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
  });
});
```

- [ ] **Step 2: Run it, verify it fails** on the sessions case.

Run: `npx vitest run tests/unit/mcp/recall-defaults.test.ts`
Expected: FAIL — sessions handler currently passes `mode: "hybrid"`.

- [ ] **Step 3: Flip the session handler default to keyword.** In `recallSessionsHandler`, change the query `mode: input.mode ?? "hybrid"` to `?? "keyword"`, and the telemetry `mode: input.mode ?? "hybrid"` to `?? "keyword"`. Leave `recallFactsHandler` at `"hybrid"`.

- [ ] **Step 4: Flip the fact service default to hybrid.** In `fact-recall-service.ts:66`, change `const mode: RecallMode = input.mode ?? "keyword";` to `?? "hybrid";`.

- [ ] **Step 5: Update describe strings.** In `server.ts`, the `recall_sessions` tool/describe text (`~320`, `~566`) currently says `mode: "hybrid" (default ...)` / `Defaults to hybrid`. Change the sessions ones to read `Defaults to keyword (FTS5 BM25); hybrid and semantic are available.` Leave the `recall_facts` describe (`~382`, `~635`) as hybrid.

- [ ] **Step 6: Reconcile the methodology doc.** In `docs/methodology-recall-baseline.md`, replace the lines describing a fictional weighted scorer with the real one: three FTS5 BM25 legs (entity/label/body) fused, plus the metadata tiebreaker (#308) and `forceIncludeKeywordTop` Mode-A mitigation. State the verified numbers: keyword 72.5% -> 90% R@5 with the tiebreaker on the operator's production decision-query set; hybrid 65% (RRF regresses at scale). No home paths or client names.

- [ ] **Step 7: Run the test + golden + full suite + typecheck.**

Run: `npx vitest run tests/unit/mcp/recall-defaults.test.ts tests/integration/recall-golden.test.ts && npm test && npm run typecheck`
Expected: new test PASS; `recall-golden.test.ts` still PASS (it asserts keyword behavior, unaffected); full suite green; typecheck clean.

- [ ] **Step 8: Before/after measurement (the proof).** If the LongMemEval-S dataset and a sandboxed corpus are available locally, run `npm run bench:longmemeval -- --limit 200` for both modes and record session R@5/R@1. If the dataset is absent, record that and rely on the golden test + the documented production numbers, and note the gap explicitly. Never commit the private corpus.

- [ ] **Step 9: Commit.**

```bash
git add src/mcp/server.ts src/core/recall-facts/fact-recall-service.ts docs/methodology-recall-baseline.md tests/unit/mcp/recall-defaults.test.ts
git commit -m "fix(recall): align default modes to evidence (sessions=keyword, facts=hybrid)"
```

---

## Task 2: `nlm eval` subcommand + scheduled regression gate

**Files:**
- Create: `src/core/eval/run-eval.ts` (corpus-agnostic runner: takes a query set with expected ids, returns R@5/R@1/MRR per mode)
- Modify: `src/cli/nlm.ts` (register `nlm eval --queries <file> [--mode <m>] [--json]`)
- Modify: `package.json` (add `"eval:fact-recall": "tsx scripts/eval/fact-recall-eval.ts"`)
- Create: `tests/integration/fact-recall-gate.test.ts` (tolerant gate over a committed synthetic fixture, mirroring `recall-golden.test.ts`)
- Test: `tests/unit/core/eval/run-eval.test.ts`

**Interfaces:**
- Consumes: `RecallService.search` / `FactRecallService.search`.
- Produces: `runEval(deps, querySet, opts): Promise<EvalReport>` where `EvalReport = { mode: RecallMode; rAt1: number; rAt5: number; mrr: number; n: number; misses: Array<{ query: string; expected: string[]; got: string[] }> }`; `EvalQuery = { query: string; expectedIds: string[] }`.

- [ ] **Step 1: Write the failing test for `runEval`.**

```ts
// tests/unit/core/eval/run-eval.test.ts
import { describe, it, expect } from "vitest";
import { runEval } from "@core/eval/run-eval.js";

describe("runEval", () => {
  it("computes R@1, R@5 and MRR over a query set", async () => {
    const recall = {
      search: async ({ query }: { query: string }) => ({
        total: 2,
        results: query === "alpha" ? [{ id: "s1" }, { id: "s9" }] : [{ id: "s9" }, { id: "s2" }],
      }),
    };
    const report = await runEval(
      { recall } as never,
      [
        { query: "alpha", expectedIds: ["s1"] }, // gold at rank 1
        { query: "beta", expectedIds: ["s2"] },  // gold at rank 2
      ],
      { mode: "keyword", k: 5 },
    );
    expect(report.n).toBe(2);
    expect(report.rAt1).toBeCloseTo(0.5);
    expect(report.rAt5).toBeCloseTo(1.0);
    expect(report.mrr).toBeCloseTo((1 + 0.5) / 2);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `npx vitest run tests/unit/core/eval/run-eval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runEval`.**

```ts
// src/core/eval/run-eval.ts
import type { RecallMode } from "@shared/types.js";

export interface EvalQuery { readonly query: string; readonly expectedIds: ReadonlyArray<string>; }
export interface EvalReport {
  readonly mode: RecallMode; readonly n: number;
  readonly rAt1: number; readonly rAt5: number; readonly mrr: number;
  readonly misses: ReadonlyArray<{ query: string; expected: ReadonlyArray<string>; got: ReadonlyArray<string> }>;
}
interface Searcher { search(q: { query: string; mode: RecallMode; limit: number }): Promise<{ results: ReadonlyArray<{ id: string }> }>; }

export async function runEval(
  deps: { recall: Searcher },
  queries: ReadonlyArray<EvalQuery>,
  opts: { mode: RecallMode; k: number },
): Promise<EvalReport> {
  let hit1 = 0, hit5 = 0, rrSum = 0;
  const misses: EvalReport["misses"] = [];
  for (const q of queries) {
    const { results } = await deps.recall.search({ query: q.query, mode: opts.mode, limit: opts.k });
    const ids = results.map((r) => r.id);
    const rank = ids.findIndex((id) => q.expectedIds.includes(id)) + 1; // 0 => miss
    if (rank === 1) hit1++;
    if (rank >= 1 && rank <= 5) hit5++;
    if (rank >= 1) rrSum += 1 / rank;
    else misses.push({ query: q.query, expected: q.expectedIds, got: ids });
  }
  const n = queries.length || 1;
  return { mode: opts.mode, n: queries.length, rAt1: hit1 / n, rAt5: hit5 / n, mrr: rrSum / n, misses };
}
```

- [ ] **Step 4: Run the test, verify it passes.**

Run: `npx vitest run tests/unit/core/eval/run-eval.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the CLI subcommand.** In `src/cli/nlm.ts`, add a `nlm eval` command that reads an operator-supplied JSON query file (`[{query, expectedIds}]`), constructs the recall service from the live store, calls `runEval`, and prints a table (and JSON with `--json`). The query file is operator-supplied and never bundled in the repo.

```ts
// inside the commander setup in src/cli/nlm.ts
program
  .command("eval")
  .description("Run R@k/MRR over an operator-supplied query set (queries never bundled)")
  .requiredOption("--queries <file>", "JSON file: [{ query, expectedIds }]")
  .option("--mode <mode>", "keyword | semantic | hybrid", "keyword")
  .option("--json", "emit JSON instead of a table")
  .action(async (opts) => {
    const { readFile } = await import("node:fs/promises");
    const queries = JSON.parse(await readFile(opts.queries, "utf8"));
    const { runEval } = await import("@core/eval/run-eval.js");
    const deps = await buildRecallDeps(); // existing composition helper used by `nlm recall`
    const report = await runEval(deps, queries, { mode: opts.mode, k: 5 });
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`mode=${report.mode} n=${report.n} R@1=${(report.rAt1 * 100).toFixed(1)}% R@5=${(report.rAt5 * 100).toFixed(1)}% MRR=${report.mrr.toFixed(3)}`);
  });
```

Note: reuse the existing recall composition that `nlm recall` already builds; if it is inline, extract a small `buildRecallDeps()` helper in `nlm.ts` and reuse it from both.

- [ ] **Step 6: Add the package.json script.** Add `"eval:fact-recall": "tsx scripts/eval/fact-recall-eval.ts"` to `scripts`.

- [ ] **Step 7: Write the tolerant fact-recall gate** mirroring `tests/integration/recall-golden.test.ts`, over a small committed SYNTHETIC fact fixture (no client/home data). Assert R@5 stays at or above a conservative floor (set from the first green run, e.g. 0.8) so a real regression fails CI but noise does not.

- [ ] **Step 8: Run the gate + full suite + typecheck.**

Run: `npx vitest run tests/integration/fact-recall-gate.test.ts && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 9: Document the weekly schedule** in `docs/` (not auto-installed): `npm run bench:longmemeval -- --limit 500` + `npm run eval:fact-recall` writing JSON to `reports/`, mirroring how backups are documented. No host/infra specifics.

- [ ] **Step 10: Commit.**

```bash
git add src/core/eval/run-eval.ts src/cli/nlm.ts package.json scripts/eval/fact-recall-eval.ts tests/integration/fact-recall-gate.test.ts tests/unit/core/eval/run-eval.test.ts docs/
git commit -m "feat(eval): nlm eval subcommand + fact-recall regression gate"
```

---

## Task 3: Score floor + session keyword-primary banding + precision-under-distractor arm

**Files:**
- Modify: `src/hook/session-start-hook.ts:23` and `src/hook/prompt-recall-hook.ts:26` (`SCORE_THRESHOLD`)
- Modify: `src/core/recall/recall-service.ts` (replace RRF `mergeHybrid`, ~321-358, with keyword-primary banding)
- Modify: `src/core/recall-facts/fact-recall-service.ts` (`makeFilterPredicate`, ~245-256: add `retired_at`)
- Modify: `scripts/eval/fact-recall-eval.ts` (precision-under-distractor arm)
- Test: `tests/unit/core/recall/merge-hybrid-banding.test.ts`, `tests/unit/core/recall-facts/retired-filter.test.ts`

**Interfaces:**
- Consumes: `KeywordHit`, `SemanticHit`, `RecallHit` (existing in `recall-service.ts`).
- Produces: `mergeHybrid` keeps its signature; behavior changes from RRF to keyword-primary banding. `makeFilterPredicate` gains a `retired_at`/`retiredAt` exclusion.

- [ ] **Step 1: Failing test for keyword-primary banding** (keyword winner outranks a semantic-only hit; semantic-only backfills below the keyword band).

```ts
// tests/unit/core/recall/merge-hybrid-banding.test.ts
import { describe, it, expect } from "vitest";
import { mergeHybridForTest as mergeHybrid } from "@core/recall/recall-service.js";

const sess = (id: string) => ({ id, label: id, startedAt: "2026-01-01T00:00:00Z", summary: "" });

describe("session mergeHybrid keyword-primary banding", () => {
  it("ranks a strong keyword hit above a semantic-only hit", () => {
    const kw = [{ session: sess("k1"), score: 10, matchedIn: ["label"] as never }];
    const sem = [{ session: sess("s1"), similarity: 0.9 }];
    const rows = mergeHybrid(kw, sem);
    expect(rows[0]!.id).toBe("k1");
    expect(rows.find((r) => r.id === "s1")!.matchScore).toBeLessThan(rows[0]!.matchScore);
  });
});
```

Note: this requires exporting `mergeHybrid` for test (`export { mergeHybrid as mergeHybridForTest }` at the bottom of `recall-service.ts`, matching how the fact service is tested, or move it to a sibling module). Choose the lowest-churn option consistent with the file's existing test seams.

- [ ] **Step 2: Run it, verify it fails** (RRF currently fuses by rank, not banded).

Run: `npx vitest run tests/unit/core/recall/merge-hybrid-banding.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace RRF with keyword-primary banding** (the inverse of the fact lane's semantic-primary banding). Keyword hits occupy the upper band `[0.5, 1.0]` ranked by normalized BM25; semantic-only hits backfill `[0, 0.5)`. Preserve `keywordScore`/`semanticScore` as informational, and preserve the Ollama-down degradation (empty `semHits` -> pure keyword).

```ts
function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
): ReadonlyArray<RecallHit> {
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));
  const semMap = new Map<string, SemanticHit>(semHits.map((h) => [h.session.id, h]));
  const rows: RecallHit[] = [];
  const seen = new Set<string>();
  for (const kw of kwHits) {
    const sem = semMap.get(kw.session.id);
    rows.push({
      ...sessionHitFields(kw.session),
      matchScore: round4(0.5 + 0.5 * (kw.score / maxKw)),
      matchedIn: uniqueFields(kw.matchedIn, sem ? (["semantic"] as MatchField[]) : []),
      keywordScore: round4(kw.score / maxKw),
      semanticScore: sem ? round4(sem.similarity / maxSem) : 0,
    });
    seen.add(kw.session.id);
  }
  for (const sem of semHits) {
    if (seen.has(sem.session.id)) continue;
    rows.push({
      ...sessionHitFields(sem.session),
      matchScore: round4(0.5 * (sem.similarity / maxSem)),
      matchedIn: ["semantic"] as MatchField[],
      keywordScore: 0,
      semanticScore: round4(sem.similarity / maxSem),
    });
  }
  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}
```

Note: `forceIncludeKeywordTop` becomes redundant under keyword-primary banding (keyword rank-1 is already in the top band). Leave it in place for this task (it is a no-op when the keyword winner already leads); a follow-up can remove it once the banding is proven on the production set. Do not remove behavior in the same task that changes the merge.

- [ ] **Step 4: Run the banding test + golden + full suite.**

Run: `npx vitest run tests/unit/core/recall/merge-hybrid-banding.test.ts tests/integration/recall-golden.test.ts && npm test`
Expected: green. If `recall-golden.test.ts` asserts RRF-specific scores, update those assertions to the banded values (the golden ids must not change; only score fields may).

- [ ] **Step 5: Calibrate the score floor (#284).** Change `SCORE_THRESHOLD = 0` in both hook files to read an env override with a calibrated default:

```ts
const SCORE_THRESHOLD = Number(process.env["NLM_RECALL_SCORE_FLOOR"] ?? "0");
```

Set the default from the real surfaced-vs-cited BM25 distribution via `nlm precision --verbose` on the operator corpus. If that data is not yet available, keep the default at `0` (no behavior change) and ship only the env knob, recording that the calibrated value is pending data. Do not guess a floor.

- [ ] **Step 6: Failing test for the `retired_at` filter gap.**

```ts
// tests/unit/core/recall-facts/retired-filter.test.ts
import { describe, it, expect } from "vitest";
import { makeFilterPredicateForTest as makeFilterPredicate } from "@core/recall-facts/fact-recall-service.js";

describe("makeFilterPredicate", () => {
  it("excludes retired facts even when supersededBy is null", () => {
    const pred = makeFilterPredicate({});
    const retired = { id: "f1", supersededBy: null, retiredAt: "2026-01-01T00:00:00Z", confidence: 1, kind: "x", subject: "s", predicate: "p", value: "v" } as never;
    expect(pred(retired)).toBe(false);
  });
});
```

- [ ] **Step 7: Run it, verify it fails**, then add the `retired_at` exclusion to `makeFilterPredicate`:

```ts
// inside makeFilterPredicate, after the supersededBy check:
if ((f as { retiredAt?: string | null }).retiredAt != null) return false;
```

Use the actual field name on the `Fact` type (`retiredAt` if camelCased in the domain type; confirm against `@shared/types`). Export `makeFilterPredicate` for test as with `mergeHybrid`.

- [ ] **Step 8: Add the precision-under-distractor arm** to `scripts/eval/fact-recall-eval.ts`: inject superseded/retired facts as distractors and report precision@k alongside R@k. The distractor corpus must contain facts with `retiredAt` set (and `supersededBy` null) so the leak check is not vacuous.

- [ ] **Step 9: Run full suite + typecheck.**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 10: Commit.**

```bash
git add src/core/recall/recall-service.ts src/hook/session-start-hook.ts src/hook/prompt-recall-hook.ts src/core/recall-facts/fact-recall-service.ts scripts/eval/fact-recall-eval.ts tests/unit/core/recall/merge-hybrid-banding.test.ts tests/unit/core/recall-facts/retired-filter.test.ts
git commit -m "feat(recall): keyword-primary session banding, score floor knob, retired-fact filter + precision arm"
```

---

## Task 4: `re_derivation_rate` metric + `continues` edges

**Files:**
- Modify: `src/core/scheduler/scheduler.ts` (~211-282) and `src/core/storage/sqlite-tx-context.ts` / `src/core/storage/pg-tx-context.ts:140` (write `continues` edges, not only `supersedes`)
- Create: `src/core/metrics/re-derivation.ts` (the detector)
- Test: `tests/unit/core/metrics/re-derivation.test.ts`, plus an ingest test asserting `continues` edges are written

**Interfaces:**
- Consumes: `session_edges` rows (`from_session`, `to_session`, `kind` in `supersedes | replaces | continues`), session decisions/entities from the dataset layer.
- Produces: `computeReDerivationRate(deps, windowDays): Promise<{ rate: number; pairs: Array<{ a: string; b: string; sharedEntities: string[]; jaccard: number }> }>`.

- [ ] **Step 1: Failing test for the detector.** Two sessions sharing >=1 entity, with overlapping decisions (Jaccard above a threshold), no `continues` edge between them, and a time gap > 7 days, count as one re-derivation.

```ts
// tests/unit/core/metrics/re-derivation.test.ts
import { describe, it, expect } from "vitest";
import { computeReDerivationRate } from "@core/metrics/re-derivation.js";

describe("computeReDerivationRate", () => {
  it("counts same-topic decisions re-made across sessions with no continues edge", async () => {
    const deps = makeFakeDeps([
      { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector over qdrant"] },
      { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector over qdrant"] },
    ], /* edges */ []);
    const { rate, pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(1);
    expect(rate).toBeGreaterThan(0);
  });

  it("does NOT count when a continues edge links them", async () => {
    const deps = makeFakeDeps([
      { id: "a", startedAt: "2026-01-01", entities: ["pgvector"], decisions: ["use pgvector"] },
      { id: "b", startedAt: "2026-01-15", entities: ["pgvector"], decisions: ["use pgvector"] },
    ], [{ from_session: "b", to_session: "a", kind: "continues" }]);
    const { pairs } = await computeReDerivationRate(deps, 90);
    expect(pairs.length).toBe(0);
  });
});
// makeFakeDeps is a local helper returning the minimal store interface the detector reads.
```

- [ ] **Step 2: Run it, verify it fails.**

Run: `npx vitest run tests/unit/core/metrics/re-derivation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the detector.** Pairwise over sessions sharing an entity within the window; compute decision-text Jaccard (token-set over normalized decisions); count a pair as a re-derivation when Jaccard >= threshold (start 0.5), gap > 7d, and no `continues`/`supersedes` edge links them. `rate = reDerivedPairs / eligiblePairs`.

```ts
// src/core/metrics/re-derivation.ts
export interface ReDerivationDeps {
  listSessionsWithin(windowDays: number): Promise<ReadonlyArray<{ id: string; startedAt: string; entities: ReadonlyArray<string>; decisions: ReadonlyArray<string> }>>;
  listEdges(): Promise<ReadonlyArray<{ from_session: string; to_session: string; kind: string }>>;
}
const JACCARD_FLOOR = 0.5;
const GAP_DAYS = 7;

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const toks = (xs: ReadonlyArray<string>) => new Set(xs.join(" ").toLowerCase().split(/\W+/).filter(Boolean));
  const A = toks(a), B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export async function computeReDerivationRate(deps: ReDerivationDeps, windowDays: number) {
  const sessions = await deps.listSessionsWithin(windowDays);
  const edges = await deps.listEdges();
  const linked = new Set(edges.filter((e) => e.kind === "continues" || e.kind === "supersedes").map((e) => [e.from_session, e.to_session].sort().join("|")));
  const pairs: Array<{ a: string; b: string; sharedEntities: string[]; jaccard: number }> = [];
  let eligible = 0;
  for (let i = 0; i < sessions.length; i++) for (let j = i + 1; j < sessions.length; j++) {
    const s = sessions[i]!, t = sessions[j]!;
    const shared = s.entities.filter((e) => t.entities.includes(e));
    if (shared.length === 0) return;
    eligible++;
    const key = [s.id, t.id].sort().join("|");
    if (linked.has(key)) continue;
    const gap = Math.abs(new Date(t.startedAt).getTime() - new Date(s.startedAt).getTime()) / 86_400_000;
    if (gap <= GAP_DAYS) continue;
    const jac = jaccard(s.decisions, t.decisions);
    if (jac >= JACCARD_FLOOR) pairs.push({ a: s.id, b: t.id, sharedEntities: shared, jaccard: round2(jac) });
  }
  return { rate: eligible ? pairs.length / eligible : 0, pairs };
}
```

Fix the `return` inside the loop (it should be `continue`); shown here as a deliberate bug to catch in review — replace with `continue`. (Reviewer note: this is the one place to verify the control flow.)

- [ ] **Step 4: Run the test, verify it passes** (after fixing `continue`).

Run: `npx vitest run tests/unit/core/metrics/re-derivation.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `continues` edges in ingest.** Today the scheduler writes only `supersedes`/`replaces` (scheduler.ts:272, `*-tx-context.ts`). When a new session for the same primary entity-set follows a prior one without superseding it, write a `continues` edge. Add a failing ingest test first (assert a `continues` row appears), then implement the edge-write in the tx-context insert path mirroring the existing `supersedes` INSERT.

- [ ] **Step 6: Expose the weekly number.** Add a `nlm metrics re-derivation [--window 90]` CLI readout (and a Pulse data point if the UI api layer is touched). Keep it read-only.

- [ ] **Step 7: Full suite + typecheck.**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 8: Commit.**

```bash
git add src/core/metrics/re-derivation.ts src/core/scheduler/scheduler.ts src/core/storage/ src/cli/nlm.ts tests/unit/core/metrics/re-derivation.test.ts tests/
git commit -m "feat(metrics): re_derivation_rate detector + continues edges in ingest"
```

---

## Whole-branch review gate

After Task 4, run the full suite + typecheck once more, then request an independent review of the whole `feat/retrieval-quality-t1` diff focused on: (1) the defaults flip changes no explicit-mode caller; (2) the banding rewrite preserves Ollama-down degradation and golden ids; (3) `runEval`/gate never bundle the private corpus; (4) the re-derivation detector control flow (the `continue` fix) and the `continues`-edge write; (5) no home paths / client names / infra names in the diff. Do not push to the public remote without Edward's explicit go-ahead and a scrub pass.

## Self-review (against the spec)

- Spec lever 1 (defaults) -> Task 1. Lever 2 (score floor) + lever 3 (banding) + precision arm + retired_at -> Task 3. Lever 4 (eval gate / `nlm eval`) -> Task 2. Lever for `re_derivation_rate` -> Task 4. Steps 5-8 of the spec are explicitly out of scope (T2, gated).
- No placeholders: every code step shows code; the one intentional bug in Task 4 Step 3 is flagged for the reviewer.
- Types consistent: `EvalReport`/`EvalQuery` defined in Task 2 and used by the gate; `mergeHybrid` signature unchanged in Task 3; `computeReDerivationRate` signature defined and used in Task 4.
