# Clef Decision Panel Evaluation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure where Clef (a typed-decision model served by oMLX) can gate or replace generative LLM calls in NLM and session-close, and decide adoption against thresholds fixed before the runs.

**Architecture:** A small TypeScript client for the gateway's `/clef/v1/systemone` pass-through, panel definitions (typed questions asked together in one call), and one eval script per hypothesis under `scripts/eval/`. Gold data and results stay in `$NLM_EVAL_DATA_DIR` (default `~/.nlm/eval`), never in the repo. No product code changes here; adoption is a separate plan written from the findings memo (Task 9).

**Tech Stack:** TypeScript (ESM, Node 22), Vitest, `tsx` for scripts, LiteLLM gateway at `NLM_CLASSIFIER_BASE_URL`, oMLX model `clef-oQ4e`.

**Spec:** the Hypotheses section of this document. Evidence so far lives in the 2026-10-10 session notes: Gemma's weak decision precision was a reference-list artifact, so Clef has nothing to fix there, `score` questions separated trivial from substantive sessions better than `noul`, six questions cost one read (1.07 s vs 4.77 s), and a zero-shot spike on the recall-gate gold looked comparable to the shipped gate.

## Hypotheses

| ID | Where Clef might help | Today | Zero-shot spike (n small, untuned) |
|---|---|---|---|
| H1 | Pre-injection recall gate (`src/hook/recall-gate.ts`), hot path on every prompt | `qwen3.5:4b` via Ollama. Measured on these same 77 rows (design spec 2026-06-23): conservative point keeps 96% of informed and skips 25% of off-topic; balanced point keeps 67% and skips 60% | 77 gold rows (24 informed): threshold 0.2 keeps 100% and skips 17%; threshold 0.3 keeps 92% and skips 32%; 0.43 s per call |
| H2 | Ingest triage panel: session kind (`choice`), importance (`score` 0 to 3), flags (`noul`), then skip or route the generative classifier call | Gemma 12B at 12 s (trivial) to 44 s (substantive) per session; self-reported confidence missed 1 of 4 trivial sessions | 20 synthetic sessions: `score` gap 0.6 on a 0 to 3 scale vs 0.08 for `noul` on 0 to 1 |
| H3 | Cheap faithfulness judge for `classifier-eval.ts` (is this decision or entity supported by the transcript) | Large-LLM judge in `scripts/eval/judge.ts` | 40 of 40 foreign decisions rejected, 31 of 32 genuine extras accepted |
| H4 | session-close: task status (`choice`: Done, In Progress, Blocked, unchanged) and capture triage (`choice`: synthesis, operational action, skip) | Generative scan in `session-close/scripts/scan.py` | not tested |

Two limits on H1 are known up front. The gold label says whether the response used the context, not whether the context was on topic, so some "unused" rows are relevant and the achievable skip rate is capped. And the design spec puts the gate's total payoff at about 18% fewer injected tokens and precision 31% to 37%, so H1 is a modest win even if Clef is better.

Falsified and not pursued: using Clef to filter Gemma's "false" decisions. The fixture eval scores decision precision by word overlap with 1 or 2 reference decisions, so most "unmatched" decisions were real.

## Global Constraints

- This repo is public (Apache 2.0). No real session text, prompts, session IDs, or people's names in any committed file. All gold data and run output live under `$NLM_EVAL_DATA_DIR` (default `~/.nlm/eval`).
- No em dashes in any repo text (hard repo rule, fixtures included).
- Call Clef only through the gateway pass-through `POST {NLM_CLASSIFIER_BASE_URL}/clef/v1/systemone` with model `clef-oQ4e`, bearer key from `~/.nlm/.env` (`NLM_CLASSIFIER_API_KEY`). Never print the key.
- Do not load, unload, or restart any model on the Studio. Clef is already resident. Concurrency at most 2.
- Fail open: any Clef error, timeout, or malformed reply must never cause a skip or a drop.
- Clef silently drops the tail of long state (a marker at about 20k tokens was found, at about 30k it was missed). Cap state at `MAX_TRANSCRIPT_CHARS` (15,000) using `truncateTranscript` from `src/core/classifier/prompt.ts`.
- Tune on the tune half only. Report numbers from the holdout half only. The split is a fixed hash of the row id (Task 2).
- No fine-tuning and no Cloudflare RL service in this plan. Decide that separately from the memo.
- Every label, audit and spot check is done by the session's frontier model reading the material. Nothing is handed to the operator as a manual step.
- Test files follow the repo convention `tests/unit/scripts/`.
- Task tracking: nxttasks T533 (property nlm-memory, project Recall). Every commit carries a `Work-Id: T533` trailer.

## Review Focus

1. Clef unreachable or slow: the gate and triage paths must keep or run the generative call. Pinned by the fail-open test in Task 1.
2. State longer than the served window loses its tail with no error. Pinned by the cap test in Task 2 and the live canary check in Task 2.
3. Label leakage: Clef is post-trained from Qwen3.8, so Qwen-family labelers are correlated with it. Only labels audited by a different model family or by hand count as gold (Task 5).
4. Tiny classes (24 informed rows, 4 trivial sessions) make point estimates look better than they are. Every rate is printed with a Wilson interval and any class under 30 rows is flagged as indicative only (Task 2 tests).
5. Several candidates asked in one call must not influence each other. Pinned by the shuffle-invariance run in Task 3.

## File Structure

- Create `scripts/eval/lib/clef-client.ts`: request and response types, `askClef`, `askClefOrNull`.
- Create `scripts/eval/lib/clef-stats.ts`: `splitOf`, `sweep`, `wilson`, `brier`.
- Create `scripts/eval/lib/clef-panels.ts`: question builders for H1 and H2, `capState`.
- Create `scripts/eval/clef-recall-gate.ts`: H1 experiment.
- Create `scripts/eval/clef-triage.ts`: H2 experiment and calibration.
- Create `scripts/eval/clef-judge-agreement.ts`: H3 experiment.
- Create `scripts/eval/clef-session-close.ts`: H4 experiment.
- Create `tests/unit/scripts/clef-client.test.ts`, `tests/unit/scripts/clef-stats.test.ts`, `tests/unit/scripts/clef-panels.test.ts`.
- Create `docs/clef-decision-panel-findings.md`: the memo (Task 9).

---

### Task 1: Clef client with fail-open

**Files:**
- Create: `scripts/eval/lib/clef-client.ts`
- Test: `tests/unit/scripts/clef-client.test.ts`

**Interfaces:**
- Produces: `askClef(state: unknown, questions: Record<string, ClefQuestion>, opts: ClefOptions): Promise<{ answers: Record<string, ClefAnswer>; ms: number }>` (throws on HTTP error, timeout, or reply missing `answers`) and `askClefOrNull(...)` with the same arguments returning `null` instead of throwing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/scripts/clef-client.test.ts
import { describe, it, expect } from "vitest";
import { askClef, askClefOrNull } from "../../../scripts/eval/lib/clef-client.js";

const ok = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

describe("clef client", () => {
  it("posts state and questions with bearer auth and returns answers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as typeof fetch;
    const r = await askClef({ text: "hi" }, { q: { type: "noul", instructions: "Is it?" } },
      { baseUrl: "http://gw:4000", apiKey: "k", fetchImpl });
    expect(seen?.url).toBe("http://gw:4000/clef/v1/systemone");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(seen?.init.body as string);
    expect(body.model).toBe("clef-oQ4e");
    expect(body.state).toEqual({ text: "hi" });
    expect(r.answers.q).toEqual({ type: "noul", noul: 0.9 });
  });

  it("throws on HTTP error and askClefOrNull fails open", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const args = [{}, { q: { type: "noul", instructions: "x" } }, { baseUrl: "http://gw", apiKey: "k", fetchImpl }] as const;
    await expect(askClef(...args)).rejects.toThrow(/500/);
    expect(await askClefOrNull(...args)).toBeNull();
  });

  it("treats a reply without answers as an error", async () => {
    const args = [{}, { q: { type: "noul", instructions: "x" } },
      { baseUrl: "http://gw", apiKey: "k", fetchImpl: ok({ model: "m" }) }] as const;
    expect(await askClefOrNull(...args)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/clef-client.test.ts`
Expected: FAIL, module `clef-client.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/lib/clef-client.ts
export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };

export interface ClefOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export async function askClef(
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: ClefOptions,
): Promise<{ answers: Record<string, ClefAnswer>; ms: number }> {
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  const res = await f(`${opts.baseUrl}/clef/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model: opts.model ?? "clef-oQ4e", state, questions }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`clef HTTP ${res.status}`);
  const json = (await res.json()) as { answers?: Record<string, ClefAnswer> };
  if (!json.answers) throw new Error("clef reply has no answers");
  return { answers: json.answers, ms: Date.now() - t0 };
}

export async function askClefOrNull(
  ...args: Parameters<typeof askClef>
): Promise<Awaited<ReturnType<typeof askClef>> | null> {
  try {
    return await askClef(...args);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/clef-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/clef-client.ts tests/unit/scripts/clef-client.test.ts
git commit -m "eval: add fail-open Clef client

Work-Id: T533"
```

---

### Task 2: Stats helpers, panels, and the truncation canary

**Files:**
- Create: `scripts/eval/lib/clef-stats.ts`, `scripts/eval/lib/clef-panels.ts`
- Test: `tests/unit/scripts/clef-stats.test.ts`, `tests/unit/scripts/clef-panels.test.ts`

**Interfaces:**
- Consumes: `ClefQuestion` from Task 1; `truncateTranscript`, `MAX_TRANSCRIPT_CHARS` from `src/core/classifier/prompt.ts`.
- Produces: `splitOf(id: string): "tune" | "holdout"`; `sweep(rows: {score:number; positive:boolean}[], thresholds: number[]): {threshold:number; positiveKept:number; negativeSkipped:number}[]` (a row is kept when `score >= threshold`; `positive` means must keep); `wilson(k: number, n: number): [number, number]`; `brier(rows: {p:number; y:boolean}[]): number`; `auc(rows: {score:number; positive:boolean}[]): number` (probability a random positive outscores a random negative, ties count half, NaN when a class is empty); `capState(text: string): string`; `recallGateQuestions(variant: "noul" | "noulCriteria" | "score"): Record<string, ClefQuestion>` (single question id `q`); `triageQuestions(): Record<string, ClefQuestion>` with ids `kind`, `importance`, `decision`, `abandoned`, `failure`, `unfinished`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/scripts/clef-stats.test.ts
import { describe, it, expect } from "vitest";
import { splitOf, sweep, wilson, brier, auc } from "../../../scripts/eval/lib/clef-stats.js";

describe("clef stats", () => {
  it("splits deterministically and roughly evenly", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `row-${i}`);
    const tune = ids.filter((i) => splitOf(i) === "tune").length;
    expect(splitOf("row-1")).toBe(splitOf("row-1"));
    expect(tune).toBeGreaterThan(160);
    expect(tune).toBeLessThan(240);
  });

  it("sweeps thresholds as keep rate on positives and skip rate on negatives", () => {
    const rows = [
      { score: 0.9, positive: true }, { score: 0.4, positive: true },
      { score: 0.6, positive: false }, { score: 0.1, positive: false },
    ];
    expect(sweep(rows, [0.5])).toEqual([{ threshold: 0.5, positiveKept: 0.5, negativeSkipped: 0.5 }]);
  });

  it("wilson interval brackets the point estimate and widens for small n", () => {
    const [lo, hi] = wilson(24, 24);
    expect(hi).toBeCloseTo(1, 5);
    expect(lo).toBeLessThan(0.9);
    const [lo2] = wilson(240, 240);
    expect(lo2).toBeGreaterThan(lo);
  });

  it("auc is 1 for perfect separation and 0.5 for ties", () => {
    expect(auc([{ score: 0.9, positive: true }, { score: 0.1, positive: false }])).toBe(1);
    expect(auc([{ score: 0.5, positive: true }, { score: 0.5, positive: false }])).toBe(0.5);
    expect(Number.isNaN(auc([{ score: 0.5, positive: true }]))).toBe(true);
  });

  it("brier is zero for perfect and 0.25 for coin flips", () => {
    expect(brier([{ p: 1, y: true }, { p: 0, y: false }])).toBe(0);
    expect(brier([{ p: 0.5, y: true }, { p: 0.5, y: false }])).toBe(0.25);
  });
});
```

```ts
// tests/unit/scripts/clef-panels.test.ts
import { describe, it, expect } from "vitest";
import { capState, recallGateQuestions, triageQuestions } from "../../../scripts/eval/lib/clef-panels.js";
import { MAX_TRANSCRIPT_CHARS } from "../../../src/core/classifier/prompt.js";

describe("clef panels", () => {
  it("caps state at the classifier transcript cap and keeps head and tail", () => {
    const long = `HEAD ${"x".repeat(100_000)} TAIL`;
    const out = capState(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 200);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  it("builds one question per recall-gate variant", () => {
    expect(recallGateQuestions("noul")["q"]?.type).toBe("noul");
    expect(recallGateQuestions("noulCriteria")["q"]).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
    const s = recallGateQuestions("score")["q"];
    expect(s?.type).toBe("score");
    expect(s?.type === "score" ? s.criteria.length : 0).toBe(4);
  });

  it("triage panel asks six typed questions in one call", () => {
    const q = triageQuestions();
    expect(Object.keys(q).sort()).toEqual(["abandoned", "decision", "failure", "importance", "kind", "unfinished"]);
    expect(q["kind"]?.type).toBe("choice");
    expect(q["importance"]?.type).toBe("score");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/scripts/clef-stats.test.ts tests/unit/scripts/clef-panels.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/eval/lib/clef-stats.ts
import { createHash } from "node:crypto";

export function splitOf(id: string): "tune" | "holdout" {
  const first = createHash("sha256").update(id).digest()[0] ?? 0;
  return first % 2 === 0 ? "tune" : "holdout";
}

export function sweep(
  rows: ReadonlyArray<{ score: number; positive: boolean }>,
  thresholds: ReadonlyArray<number>,
): { threshold: number; positiveKept: number; negativeSkipped: number }[] {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  return thresholds.map((threshold) => ({
    threshold,
    positiveKept: pos.length === 0 ? 1 : pos.filter((r) => r.score >= threshold).length / pos.length,
    negativeSkipped: neg.length === 0 ? 0 : neg.filter((r) => r.score < threshold).length / neg.length,
  }));
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

export function auc(rows: ReadonlyArray<{ score: number; positive: boolean }>): number {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function brier(rows: ReadonlyArray<{ p: number; y: boolean }>): number {
  return rows.reduce((s, r) => s + (r.p - (r.y ? 1 : 0)) ** 2, 0) / rows.length;
}
```

```ts
// scripts/eval/lib/clef-panels.ts
import { truncateTranscript, MAX_TRANSCRIPT_CHARS } from "../../../src/core/classifier/prompt.js";
import type { ClefQuestion } from "./clef-client.js";

export function capState(text: string): string {
  return truncateTranscript(text, MAX_TRANSCRIPT_CHARS);
}

const GATE_INSTRUCTIONS =
  "Would the prior-session context help the assistant respond to the user's prompt? Answer yes only if the context is about the same project, system or topic the prompt concerns, or contains facts the response would need. Answer no if the context is about an unrelated topic.";

export function recallGateQuestions(variant: "noul" | "noulCriteria" | "score"): Record<string, ClefQuestion> {
  if (variant === "noul") return { q: { type: "noul", instructions: GATE_INSTRUCTIONS } };
  if (variant === "noulCriteria") {
    return {
      q: {
        type: "noul",
        instructions: GATE_INSTRUCTIONS,
        criteria: {
          true: "The prior-session context concerns the same project, system or topic as the prompt, or has facts needed to answer it.",
          false: "The prior-session context is about an unrelated topic and would be noise.",
        },
      },
    };
  }
  return {
    q: {
      type: "score",
      instructions: "How useful is the prior-session context for responding to the user's prompt?",
      criteria: [
        "Unrelated topic, pure noise",
        "Same general area but nothing the response needs",
        "Related project or system with some useful background",
        "Directly needed facts or decisions for this prompt",
      ],
    },
  };
}

export function triageQuestions(): Record<string, ClefQuestion> {
  const flag = (instructions: string): ClefQuestion => ({ type: "noul", instructions });
  return {
    kind: {
      type: "choice",
      instructions: "What kind of session is this?",
      criteria: {
        coding: "Writing, fixing or refactoring code",
        ops: "Infrastructure, deployment, configuration or debugging a running system",
        research: "Research, writing, analysis or planning",
        meeting: "Meeting notes or coordination",
        trivial: "A quick lookup, greeting or one-off question with no project work",
      },
    },
    importance: {
      type: "score",
      instructions: "How much durable project value does this session contain?",
      criteria: [
        "None: greeting, trivia or chit-chat; no project, no decision",
        "Minor: routine activity with no lasting decision",
        "Substantive: real project work with at least one concrete decision",
        "Major: significant decisions, failures or lessons that should guide future work",
      ],
    },
    decision: flag("Did the user or agent make a concrete decision in this session?"),
    abandoned: flag("Was an approach tried and then abandoned in this session?"),
    failure: flag("Did something fail in a way worth remembering?"),
    unfinished: flag("Is work left unfinished at the end of the session?"),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/scripts/clef-stats.test.ts tests/unit/scripts/clef-panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the live truncation canary and record the cutoff**

```bash
cat > /tmp/clef-canary.mts <<'EOF'
import { readFileSync } from "node:fs";
import { askClef } from "/ABS/PATH/TO/WORKTREE/scripts/eval/lib/clef-client.js";
const env = Object.fromEntries(readFileSync(`${process.env.HOME}/.nlm/.env`, "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const fill = "The weather was mild and the notes were filed under archive. ";
for (const kchars of [40, 60, 80, 100, 120]) {
  const text = fill.repeat(Math.ceil((kchars * 1000) / fill.length)) + " CANARY: the team decided to adopt zebra-db.";
  const r = await askClef({ text }, { q: { type: "noul", instructions: "Does the text say the team decided to adopt zebra-db?" } },
    { baseUrl: env.NLM_CLASSIFIER_BASE_URL!, apiKey: env.NLM_CLASSIFIER_API_KEY! });
  console.log(kchars, "k chars ->", (r.answers.q as { noul: number }).noul.toFixed(2));
}
EOF
npx tsx /tmp/clef-canary.mts
```

Replace `/ABS/PATH/TO/WORKTREE` with the absolute worktree path before running. Expected: scores near 0.9 up to some size, then near 0. Record the last size that finds the canary in the memo (Task 9). It must be above 15,000 chars; if it is not, lower the cap in `capState` before any later task.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval/lib/clef-stats.ts scripts/eval/lib/clef-panels.ts tests/unit/scripts/clef-stats.test.ts tests/unit/scripts/clef-panels.test.ts
git commit -m "eval: add Clef stats helpers and panels

Work-Id: T533"
```

---

### Task 3: H1 recall-gate experiment on the existing gold

**Files:**
- Create: `scripts/eval/clef-recall-gate.ts`

**Interfaces:**
- Consumes: `askClef`, `recallGateQuestions`, `capState`, `splitOf`, `sweep`, `wilson`.
- Input: `$NLM_EVAL_DATA_DIR/gold-usefulness.jsonl` (rows `{ key, prompt, context, gold: "used" | "partial" | "unused" }`, 77 rows today). Positive means `gold !== "unused"`.
- Output: `$NLM_EVAL_DATA_DIR/clef-recall-gate-<variant>.json` and a printed table.

- [ ] **Step 1: Write the script**

```ts
// scripts/eval/clef-recall-gate.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askClef } from "./lib/clef-client.js";
import { capState, recallGateQuestions } from "./lib/clef-panels.js";
import { auc, splitOf, sweep, wilson } from "./lib/clef-stats.js";

const dataDir = (process.env["NLM_EVAL_DATA_DIR"] ?? join(homedir(), ".nlm", "eval")).replace(/^~/, homedir());
const env = Object.fromEntries(readFileSync(join(homedir(), ".nlm", ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]! };
const variant = (process.argv[2] ?? "noul") as "noul" | "noulCriteria" | "score";
const THRESHOLDS = variant === "score" ? [0.5, 1, 1.5, 2, 2.5] : [0.05, 0.1, 0.2, 0.3, 0.5, 0.7];

interface Row { key: string; prompt: string; context: string; gold: "used" | "partial" | "unused" }
const rows = readFileSync(join(dataDir, "gold-usefulness.jsonl"), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as Row);

const scored: { id: string; score: number; positive: boolean; ms: number }[] = [];
for (const r of rows) {
  const { answers, ms } = await askClef(
    { user_prompt: capState(r.prompt), prior_session_context: capState(r.context) },
    recallGateQuestions(variant), opts);
  const a = answers["q"]!;
  scored.push({ id: r.key, score: a.type === "noul" ? a.noul : a.type === "score" ? a.score : NaN, positive: r.gold !== "unused", ms });
}
writeFileSync(join(dataDir, `clef-recall-gate-${variant}.json`), JSON.stringify(scored));

for (const half of ["tune", "holdout"] as const) {
  const part = scored.filter((s) => splitOf(s.id) === half);
  const pos = part.filter((s) => s.positive).length;
  console.log(`\n${variant} ${half}: ${part.length} rows, ${pos} informed${pos < 30 ? " (indicative only, under 30)" : ""}, AUC ${auc(part).toFixed(3)}`);
  for (const t of sweep(part, THRESHOLDS)) {
    const kept = Math.round(t.positiveKept * pos);
    const [lo] = wilson(kept, pos);
    console.log(`  thr ${t.threshold}: informed kept ${(t.positiveKept * 100).toFixed(0)}% (lower ${(lo * 100).toFixed(0)}%), off-topic skipped ${(t.negativeSkipped * 100).toFixed(0)}%`);
  }
}
const ms = scored.map((s) => s.ms).sort((a, b) => a - b);
console.log(`\nlatency p50 ${ms[Math.floor(ms.length / 2)]} ms, p95 ${ms[Math.floor(ms.length * 0.95)]} ms`);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.scripts.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run all three variants**

```bash
for v in noul noulCriteria score; do npx tsx scripts/eval/clef-recall-gate.ts $v; done
```

Expected: three tables. Choose the threshold from the **tune** rows only (best off-topic skip rate with informed kept at or above 96%), then read that threshold's **holdout** line. Write both into the memo.

- [ ] **Step 4: Paired baseline from the shipped gate on the same rows**

The shipped gate's published numbers come from these same 77 rows, but rerun it so both models are compared on the same tune and holdout halves. `qwen3.5:4b` is installed in local Ollama.

Run: `npx tsx scripts/eval/gate-feasibility.ts --model=qwen3.5:4b`
Record its conservative and balanced operating points on the holdout half, and compare the two operating curves (Clef's sweep against those two points) rather than one number. The spike suggested Clef holds 88% informed kept while skipping 57%; the shipped gate's curve implies roughly 35% at that retention. That rests on 3 informed rows, so it is a lead, not a result.

- [ ] **Step 5: Shuffle-invariance check for batched candidates**

Append to `scripts/eval/clef-recall-gate.ts`:

```ts
if (process.argv[3] === "batch") {
  const questionsFor = (n: number): Record<string, ClefQuestion> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`,
      { type: "noul", instructions: `Is candidate c${i} relevant to the user's prompt?` } as ClefQuestion]));
  let maxDiff = 0;
  let singleMs = 0;
  let batchMs = 0;
  for (let i = 0; i + 5 <= rows.length; i += 5) {
    const group = rows.slice(i, i + 5);
    const ask = async (g: Row[]) => {
      const state = { user_prompt: capState(g[0]!.prompt), candidates: Object.fromEntries(g.map((r, k) => [`c${k}`, capState(r.context)])) };
      return askClef(state, questionsFor(g.length), opts);
    };
    const fwd = await ask(group);
    const rev = await ask([...group].reverse());
    batchMs += fwd.ms;
    group.forEach((_, k) => {
      const a = fwd.answers[`c${k}`]!;
      const b = rev.answers[`c${group.length - 1 - k}`]!;
      if (a.type === "noul" && b.type === "noul") maxDiff = Math.max(maxDiff, Math.abs(a.noul - b.noul));
    });
    for (const r of group) singleMs += (await askClef({ user_prompt: capState(r.prompt), prior_session_context: capState(r.context) }, recallGateQuestions("noul"), opts)).ms;
  }
  console.log(`batch: max order difference ${maxDiff.toFixed(3)}, batched ${batchMs} ms vs ${singleMs} ms single`);
}
```

Add `import type { ClefQuestion } from "./lib/clef-client.js";` at the top. Run `npx tsx scripts/eval/clef-recall-gate.ts noul batch`. Acceptance: maximum difference under 0.05 and the batched time at most half of the single-call time. If either fails, H1 must use one call per candidate.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval/clef-recall-gate.ts
git commit -m "eval: H1 recall-gate experiment for Clef

Work-Id: T533"
```

---

### Task 4: Grow the recall-gate gold before trusting H1

The gold has 24 informed rows, so any rate has a wide interval. This task stops H1 from being decided on noise.

**Files:**
- Read first: `scripts/eval/hook-usefulness.ts`, `scripts/eval/lib/usefulness-judge.ts`, `docs/eval-signals.md`
- Output: `$NLM_EVAL_DATA_DIR/gold-usefulness-v2.jsonl` (outside the repo)

- [ ] **Step 1: Read how `gold-usefulness.jsonl` was built** (headers of the two scripts above) and write down the exact command that produces more `(prompt, context, response, gold)` rows from real hook injections. Also settle provenance: 64 of the 77 current rows have no `labeler` field (13 say `frontier-claude-opus`), while the docs call the whole set frontier-labeled. Check the commit that expanded it (`git log -S"gold-usefulness"`) and record who labeled the 64. If a Qwen-family model did, relabel those rows with the frontier model before using them as gold (Review Focus 3).
- [ ] **Step 2: Produce rows until there are at least 150 total with at least 60 informed.** Label with the existing frontier-labeler path; do not label with a Qwen-family model (Review Focus 3).
- [ ] **Step 3: Audit 30 rows by hand** against the response text. Record agreement with the labeler. If agreement is under 85%, stop and report; the gold is not trustworthy enough.
- [ ] **Step 4: Rerun Task 3 on the new file** by pointing the script at `gold-usefulness-v2.jsonl` (change the filename constant, one line) and record the holdout numbers in the memo.
- [ ] **Step 5: Stop condition.** If 60 informed rows cannot be reached, report H1 as "indicative only" and do not recommend adoption.

---

### Task 5: H2 ingest triage panel on real sessions

**Files:**
- Create: `scripts/eval/clef-triage.ts`
- Read first: `scripts/eval/build-classifier-gold.ts` (reuse its seeded stratified selection and its read-only copy of the database; do not read the live database in place)
- Output: `$NLM_EVAL_DATA_DIR/triage-gold.json` and `triage-results.json`

**Interfaces:**
- Consumes: `askClef`, `triageQuestions`, `capState`, `splitOf`, `sweep`, `wilson`, `brier`.
- Gold row: `{ id, runtime, body, audited: { importance: 0 | 1 | 2 | 3, kind: string, worthClassifying: boolean } }`.

- [ ] **Step 1: Select 120 real sessions** with `npx tsx scripts/eval/build-classifier-gold.ts --n=120 --out=$NLM_EVAL_DATA_DIR/triage` (stratified by runtime and length, seeded; flags use the `--key=value` form). Output stays in the data dir.
- [ ] **Step 2: Label with a first pass from a non-Qwen model**, then the frontier model audits at least 40 rows by reading them, including every row where the two disagree. Only audited rows enter the gold. Record labeler-vs-audit agreement; if it is under 85%, relabel before going on.
- [ ] **Step 3: Write `clef-triage.ts`.** For each gold row call `askClef({ session: capState(body) }, triageQuestions(), opts)` once. Save every answer. Report on the holdout half: importance accuracy within one level, `kind` accuracy, and for the gate `worthClassifying = importance >= 2`: use `sweep` on the importance score, then print `positiveKept` with a Wilson lower bound, the share of sessions skipped, and the seconds saved per 100 sessions using the measured Gemma latencies (12 s trivial, 44 s other, from the 2026-10-09 baseline run).
- [ ] **Step 4: Calibration comparison.** Run the production classifier on the same sessions (call `chatOnce` from `scripts/eval/lib/chat-client.ts` with `CLASSIFIER_SYSTEM_PROMPT` and `buildUserPrompt(capState(body), "")`, parse with `stripJsonFences` and `coerceClassifyResult` from `src/core/classifier/prompt.ts`, as the production path does) and compare `brier()` of its self-reported `confidence` against Clef's `importance` score (rescaled to 0..1) as predictors of `worthClassifying`. Print both.
- [ ] **Step 5: Run and commit**

```bash
npx tsx scripts/eval/clef-triage.ts
git add scripts/eval/clef-triage.ts
git commit -m "eval: H2 triage panel and calibration for Clef

Work-Id: T533"
```

---

### Task 6: H3 Clef as the extraction judge

**Files:**
- Create: `scripts/eval/clef-judge-agreement.ts`
- Read first: `scripts/eval/judge.ts` (verdict cache keyed by model and prompt), `scripts/eval/extraction-scoring.ts`

- [ ] **Step 1: Rebuild pairs.** The verdict cache stores only `(sha256 key, model, reply)`, so pairs cannot be read back from it. Instead rerun the classification step of `classifier-eval.ts` on the gold bodies (its `ClassifierCache` makes repeats free), build each `(transcript, decision)` judge prompt exactly as that script does (`DECISION_PRECISION_SYSTEM` plus its user prompt builder), and look up the verdict with `JudgeCache` under the same key. Keep pairs that hit. Need at least 100 hits; if fewer, run the judge on the misses once and note the cost.
- [ ] **Step 2: For each pair ask Clef** `noul`: "Is this statement supported by the transcript as a decision made in it?" (use the tuned wording from the 2026-10-10 notes: a chosen approach, tool, design or action taken, not something only discussed or from another session). One call per pair.
- [ ] **Step 3: Report on the holdout half** the agreement with the existing verdict, the confusion matrix, and the time per verdict. Agreement with a judge is not accuracy, and the existing judge is likely Qwen-family like Clef. So the frontier model also reads every disagreement against the transcript and records which side was right. Adopt only if agreement is at least 90% (threshold below) and Clef is right on at least half of the audited disagreements.
- [ ] **Step 4: Commit**

```bash
git add scripts/eval/clef-judge-agreement.ts
git commit -m "eval: H3 Clef judge agreement run

Work-Id: T533"
```

---

### Task 7: H4 session-close panel

Past session-close outcomes cannot be joined to sessions: in the vault log only 25 of 925 session-close lines carry a session id, and only 2 of those resolve to an NLM session. Labels therefore come from an audit, not from history.

**Files:**
- Create: `scripts/eval/clef-session-close.ts`
- Read first: `~/.config/nxt/skills/skills.d/session-close/references/capture-rubric.md`, `scripts/scan.py` (its output contract: `will_capture`, `task_resolution`, `considered_but_skipping`)

- [ ] **Step 1: Build 40 cases** from recent real sessions. Each case: transcript (capped), the open tasks as they stood at session start (`nxttasks list` only shows now, so reconstruct from `nxttasks history <id> --json` using the session's start time), and an audited answer for each task (`Done`, `In Progress`, `Blocked`, `unchanged`) and each candidate capture item (`synthesis`, `operational`, `skip`), judged by the frontier model reading the transcript. Candidate items come from the existing scanner's output so the comparison is on the same items.
- [ ] **Step 2: Ask Clef one call per case** with a `choice` question per open task and per candidate item, criteria taken verbatim from the rubric text.
- [ ] **Step 3: Report on the holdout half:** task-status agreement, capture-triage recall for audited `synthesis` and `operational` items, and call time against the scanner's time for the same case.
- [ ] **Step 4: Commit**

```bash
git add scripts/eval/clef-session-close.ts
git commit -m "eval: H4 session-close panel for Clef

Work-Id: T533"
```

---

### Task 8: Efficiency accounting

**Files:**
- Modify: none (numbers go in the memo)

- [ ] **Step 1: Count volume.** `sqlite3 ~/.nlm/canonical.sqlite "select date(started_at), count(*) from sessions where started_at > date('now','-30 day') group by 1"` gives sessions per day; hook injections per day come from the hook log (`docs/hooks.md` names it).
- [ ] **Step 2: Compute per day** the seconds of generative classifier time avoided (H2 skip rate times sessions times measured latency), the prompt tokens of injected context avoided (H1 skip rate times injections times mean candidate size), and the Clef time added (calls times 0.4 to 1.2 s).
- [ ] **Step 3: Check Studio headroom.** Clef is resident at about 16 GB. List what else is loaded (`curl -s 127.0.0.1:8349/v1/models` on the Studio) and note whether Gemma could be unloaded if H2 and H3 adopt.

---

### Task 9: Findings memo and decision

**Files:**
- Create: `docs/clef-decision-panel-findings.md`

- [ ] **Step 1: Write the memo** with one section per hypothesis: holdout numbers with Wilson intervals, latency, the canary cutoff from Task 2, the efficiency numbers from Task 8, and a verdict of adopt, do not adopt, or indicative only.
- [ ] **Step 2: Apply the thresholds below** exactly as written. They are proposals; confirm or change them before Task 3 runs, not after.

| Hypothesis | Adopt only if, on the holdout half |
|---|---|
| H1 recall gate | informed kept is at least 96% and off-topic skipped is at least 40%, at p95 latency under 1.5 s through the hook path, and Task 4 reached 60 informed rows |
| H2 triage | zero audited-substantive sessions skipped and at least 20% of sessions skipped; calibration Brier no worse than the classifier's own confidence |
| H3 judge | agreement with the existing judge at least 90% on at least 100 pairs, and Clef right on at least half of the audited disagreements |
| H4 session-close | task-status agreement at least 90% and capture-triage recall at least 95% |

- [ ] **Step 3: For each adopted hypothesis, list the integration steps** (hook change, shadow mode first, fail-open, rollback) as a separate follow-up plan. Do not implement in this plan.
- [ ] **Step 4: Run the repo gate and land**

```bash
npm run typecheck && npx vitest run tests/unit/scripts/clef-client.test.ts tests/unit/scripts/clef-stats.test.ts tests/unit/scripts/clef-panels.test.ts
git add docs/clef-decision-panel-findings.md
git commit -m "docs: Clef decision panel findings

Work-Id: T533"
nxtgit land --cwd /Users/echalupa/.nxtos/worktrees/nlm-memory-a158d07b
```

## Self-Review

- **Spec coverage:** H1 is Tasks 3 and 4, H2 is Task 5, H3 is Task 6, H4 is Task 7, efficiency is Task 8, the decision is Task 9. The falsified filter idea is recorded and not planned.
- **Placeholders:** the only substituted value is the worktree path in the Task 2 canary, called out in that step. Tasks 4 to 7 depend on data that must be built from real sessions, so those steps name the command or file to read first instead of inventing it.
- **Type consistency:** `ClefQuestion`, `ClefAnswer`, `askClef`, `splitOf`, `sweep`, `wilson`, `brier`, `capState`, `recallGateQuestions`, `triageQuestions` use the same names and shapes in every task.
- **Review Focus:** 1 is the fail-open test (Task 1), 2 is the cap test and canary (Task 2), 3 is the audit rule (Task 5), 4 is the Wilson and under-30 flag (Tasks 2 and 3), 5 is the shuffle check (Task 3 Step 4).
