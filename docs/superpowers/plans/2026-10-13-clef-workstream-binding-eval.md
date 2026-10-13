# Clef Workstream-Binding Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether one Clef `choice` call binds a session to the right workstream better than the production namer, which writes a free-text label that is substring-matched and, under `NLM_SCOPE_STAMP=1`, creates a new workstream whenever it matches nothing.

**Architecture:** One panel helper and one eval script on top of the T533 harness (`scripts/eval/lib/clef-client.ts`). Gold is the existing 50-row `gold-matcher.jsonl`; the baseline is the existing `tune-naming.ts`. No product code changes; adoption is a separate plan written from the result.

**Tech Stack:** TypeScript (ESM, Node 22), Vitest, `tsx`, LiteLLM gateway pass-through `/clef/v1/systemone`, oMLX `clef-oQ4e`.

**Spec:** `docs/superpowers/plans/2026-10-10-clef-decision-panel.md` (constraints, harness) and `docs/clef-decision-panel-findings.md` (prior Clef results). Clef is the decision model for this work; the d1-3B comparison was considered and dropped (Edward, 2026-10-13).

## Global Constraints

- All T533 constraints apply verbatim: public repo, no session text, IDs or names in committed files; gold and output under `$NLM_EVAL_DATA_DIR` (default `~/.nlm/eval`); no em dashes; never print keys; concurrency at most 2; state capped with `capState`; `qwen3.5:4b` and the Ollama gate path are not run; do not load, unload or restart Studio models.
- Clef only through the gateway pass-through, key from `~/.nlm/.env`.
- Task tracking: nxttasks T640 (parent T639). Every commit carries a `Work-Id: T640` trailer.
- `npm run test:unit` and `npm run typecheck` pass before every commit.

## Review Focus

1. Duplicate workstream labels: options are keyed by index (`w0..wN`), never by label. Pinned in Task 1.
2. A choice outside the option set must throw, not bind. Pinned in Task 1.
3. Per-row errors (timeout, 4xx on a panel with many options) are counted apart from wrong answers. Pinned in Task 1.
4. 50 rows is small: every rate is printed with a Wilson interval (`wilson` from `clef-stats.ts`) and the result is indicative only.
5. Many options in one `choice`: record the active workstream count and per-row latency so a size limit shows up as errors or slow rows, not silent misses.

## File Structure

- Create `scripts/eval/lib/workstream-panel.ts`: `workstreamQuestion`, `pickWorkstream`, `scoreWorkstreams`.
- Create `scripts/eval/clef-workstream.ts`: the eval.
- Create `tests/unit/scripts/workstream-panel.test.ts`.
- Modify `docs/clef-decision-panel-findings.md`: workstream-binding section.

---

### Task 1: Workstream panel helpers

**Files:**
- Create: `scripts/eval/lib/workstream-panel.ts`
- Test: `tests/unit/scripts/workstream-panel.test.ts`

**Interfaces:**
- Consumes: `ClefAnswer`, `ClefQuestion` from `scripts/eval/lib/clef-client.ts`.
- Produces: `workstreamQuestion(labels: string[]): ClefQuestion`; `pickWorkstream(answer: ClefAnswer, ids: string[], minConfidence: number): string | null`; `scoreWorkstreams(rows: { gold: string; pred: string | null; error?: boolean }[]): { n: number; errors: number; correct: number; wrong: number; abstained: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { workstreamQuestion, pickWorkstream, scoreWorkstreams } from "../../../scripts/eval/lib/workstream-panel.js";

describe("workstream panel", () => {
  it("keys options by index so duplicate labels stay distinct, plus none", () => {
    const q = workstreamQuestion(["NLM recall", "NLM recall", "Jobs bot"]);
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria)).toEqual(["w0", "w1", "w2", "none"]);
    expect(q.criteria.w1).toBe("NLM recall");
  });

  it("maps a confident choice to its id and abstains on none or low confidence", () => {
    const ids = ["ws_a", "ws_b"];
    const ans = (choice: string, confidence: number) => ({ type: "choice" as const, choice, confidence, probabilities: {} });
    expect(pickWorkstream(ans("w1", 0.9), ids, 0.5)).toBe("ws_b");
    expect(pickWorkstream(ans("none", 0.9), ids, 0.5)).toBeNull();
    expect(pickWorkstream(ans("w0", 0.3), ids, 0.5)).toBeNull();
    expect(() => pickWorkstream(ans("w7", 0.9), ids, 0.5)).toThrow(/w7/);
  });

  it("counts errors apart from wrong answers", () => {
    expect(scoreWorkstreams([
      { gold: "a", pred: "a" }, { gold: "a", pred: "b" }, { gold: "a", pred: null }, { gold: "a", pred: null, error: true },
    ])).toEqual({ n: 4, errors: 1, correct: 1, wrong: 1, abstained: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/scripts/workstream-panel.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `scripts/eval/lib/workstream-panel.ts`**

```ts
import type { ClefAnswer, ClefQuestion } from "./clef-client.js";

export function workstreamQuestion(labels: string[]): ClefQuestion {
  const criteria: Record<string, string> = {};
  labels.forEach((label, i) => { criteria[`w${i}`] = label; });
  criteria["none"] = "None of these: the session belongs to a workstream not listed";
  return { type: "choice", instructions: "Which existing workstream does this session belong to?", criteria };
}

export function pickWorkstream(answer: ClefAnswer, ids: string[], minConfidence: number): string | null {
  if (answer.type !== "choice") throw new Error(`expected a choice answer, got ${answer.type}`);
  if (answer.choice === "none" || answer.confidence < minConfidence) return null;
  const i = Number(answer.choice.slice(1));
  if (!answer.choice.startsWith("w") || !Number.isInteger(i) || !ids[i]) throw new Error(`choice ${answer.choice} is not an option`);
  return ids[i]!;
}

export function scoreWorkstreams(rows: { gold: string; pred: string | null; error?: boolean }[]) {
  let errors = 0, correct = 0, wrong = 0, abstained = 0;
  for (const r of rows) {
    if (r.error) errors++;
    else if (r.pred === null) abstained++;
    else if (r.pred === r.gold) correct++;
    else wrong++;
  }
  return { n: rows.length, errors, correct, wrong, abstained };
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/unit/scripts/workstream-panel.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add scripts/eval/lib/workstream-panel.ts tests/unit/scripts/workstream-panel.test.ts
git commit -m "eval: Clef workstream-binding panel helpers" -m "Work-Id: T640"
```

### Task 2: The eval script

**Files:**
- Create: `scripts/eval/clef-workstream.ts`

**Interfaces:**
- Consumes: `askClef` (clef-client), `capState` (clef-panels), `wilson` (clef-stats), Task 1 helpers, `NAMING_CONTENT_CHARS` (`src/core/workstream/bind.ts`).

- [ ] **Step 1: Write the script.** Load gold, workstreams and bodies exactly as `scripts/eval/tune-naming.ts` does (gold `~/.nlm/eval/gold-matcher.jsonl`; `SELECT id, label FROM workstreams WHERE status = 'active'` and session bodies from `~/.nlm/canonical.sqlite`, opened read-only; env from `~/.nlm/.env` as in `clef-triage.ts`). Per gold row, state `{ session: capState(`${label}\n${(body || summary).slice(0, NAMING_CONTENT_CHARS)}`) }` and one `workstreamQuestion(labels)` call, concurrency 2, `askClef` errors caught per row and stored as `{ error: true }`. Cache raw answers to `$NLM_EVAL_DATA_DIR/workstream/clef-answers.json` so reruns are free. Print, for cutoffs 0, 0.5, 0.7, 0.9: `scoreWorkstreams` and the correct rate with its Wilson interval; then active workstream count, min and median latency. Header comment ends with `Run: npx tsx scripts/eval/clef-workstream.ts`.

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add scripts/eval/clef-workstream.ts
git commit -m "eval: Clef workstream-binding eval on the matcher gold" -m "Work-Id: T640"
```

### Task 3: Run, record, decide

- [ ] **Step 1: Baseline**: `npx tsx scripts/eval/tune-naming.ts`. Record correct binds, wrong binds, abstains, and how many names matched no workstream (production would create a new workstream for each).
- [ ] **Step 2: Clef**: `npx tsx scripts/eval/clef-workstream.ts` on a quiet Studio (no active oMLX requests).
- [ ] **Step 3: Findings**: add a "Workstream binding" section to `docs/clef-decision-panel-findings.md` (aggregates only). Verdict rule fixed before the run: adopt Clef binding when, at some cutoff, it has more correct binds and no more wrong binds than the baseline, and its abstains (which would fall back to the namer) are under half the rows. Name the cutoff.
- [ ] **Step 4: Commit and land**

```bash
git add docs/clef-decision-panel-findings.md
git commit -m "docs: Clef workstream-binding findings" -m "Work-Id: T640"
nxtgit land --cwd /Users/echalupa/.nxtos/worktrees/nlm-memory-7f145dc6 --done
```

## After this plan

Adoption plans under T639, each in its owning repo: the NLM ingest triage gate (H2 integration, already justified by the findings memo), NLM workstream binding if Task 3 passes, the T533 H3 judge and H4 session-close runs, then nxtos (claim adjudicator, engage scoring, observability judge), passive-map, and the nxtsocial skill gates.
