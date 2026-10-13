# Decision Model Bake-off (Clef vs d1-3B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, per NLM decision task, whether Liquid AI's d1-3B (3B, about 4 GB) can stand in for Cloudflare's Clef 27B (about 16 GB), by running both on the same audited gold sets.

**Architecture:** Extend the T533 eval harness (`scripts/eval/lib/clef-client.ts`, renamed to `decision-client.ts`) with a `backend` option so every existing eval runs against either model. d1 runs on the Studio under mlx-vlm and is reached through a new LiteLLM pass-through, the same way Clef is. One new eval covers workstream binding, the one candidate T533 never measured. No product code changes; adoption plans follow from the findings.

**Tech Stack:** TypeScript (ESM, Node 22), Vitest, `tsx`, LiteLLM gateway on the Pro (`NLM_CLASSIFIER_BASE_URL`), oMLX (`clef-oQ4e`), mlx-vlm decision server (`d1-3B-MLX-8bit`).

**Spec:** `docs/superpowers/plans/2026-10-10-clef-decision-panel.md` (hypotheses, constraints) and `docs/clef-decision-panel-findings.md` (Clef baselines this plan compares against).

## Global Constraints

- All T533 constraints apply verbatim: public repo, no session text, IDs or names in committed files; gold and output under `$NLM_EVAL_DATA_DIR` (default `~/.nlm/eval`); no em dashes; never print keys; concurrency at most 2; fail open; state capped with `capState`; tune on tune half, report holdout only; `qwen3.5:4b` and the Ollama gate path are not run.
- Model calls go through the LiteLLM gateway only: Clef at `POST {base}/clef/v1/systemone`, d1 at `POST {base}/d1/v1/decisions`. No direct Studio URLs in repo code.
- Do not load, unload or restart oMLX models. The d1 server is a separate mlx-vlm process started for the eval and stopped after it (Task 2), not a LaunchAgent. Making it permanent is a separate decision for Edward.
- Task tracking: nxttasks T640 (parent T639). Every commit carries a `Work-Id: T640` trailer.
- Tests: `npm run test:unit` and `npm run typecheck` pass before every commit.

## Review Focus

1. d1 reply fields differ from Clef's (`value` not `choice`/`score`, `probability` not `noul`, confidence under `metadata`). A missing field must throw, never become a default answer. Pinned in Task 1.
2. d1 may reject Clef-style `noul` criteria or object state. Task 2's smoke step sends the exact `triageQuestions()` panel and a workstream panel before any eval runs.
3. Workstream panels can carry a hundred or more options and duplicate labels. Options are keyed by index (`w0..wN`), never by label. Pinned in Task 3.
4. Per-row backend errors (timeout, 4xx on a large panel) must be counted and reported separately, not scored as wrong answers or dropped silently. Pinned in Task 3.
5. Latency is meaningless while the Studio serves other work (T533 saw 1 s clean vs 6.4 s busy). Each run records the oMLX active-request count before starting and reports min and median, not mean.

## File Structure

- Rename `scripts/eval/lib/clef-client.ts` to `scripts/eval/lib/decision-client.ts`: `askDecision`, `askDecisionOrNull`, `DecisionBackend`, d1 reply normalisation.
- Modify `scripts/eval/clef-triage.ts`, `clef-shadow.ts`, `clef-yield.ts`: import the renamed client, take `--backend=clef|d1`, cache answers per backend.
- Create `scripts/eval/lib/workstream-panel.ts`: `workstreamQuestion`, `pickWorkstream`, `scoreWorkstreams`.
- Create `scripts/eval/decision-workstream.ts`: workstream-binding eval on `gold-matcher.jsonl`.
- Modify `docs/clef-decision-panel-findings.md`: d1 comparison section.
- Rename `tests/unit/scripts/clef-client.test.ts` to `decision-client.test.ts`; create `tests/unit/scripts/workstream-panel.test.ts`.

---

### Task 1: Two-backend decision client

**Files:**
- Rename: `scripts/eval/lib/clef-client.ts` -> `scripts/eval/lib/decision-client.ts`
- Modify: `scripts/eval/clef-triage.ts`, `scripts/eval/clef-shadow.ts`, `scripts/eval/clef-yield.ts`
- Rename + extend: `tests/unit/scripts/clef-client.test.ts` -> `tests/unit/scripts/decision-client.test.ts`

**Interfaces:**
- Produces: `type DecisionBackend = "clef" | "d1"`; `DecisionOptions = ClefOptions & { backend?: DecisionBackend }`; `askDecision(state, questions, opts): Promise<{ answers: Record<string, ClefAnswer>; ms: number }>`; `askDecisionOrNull(...)`; `backendFromArgv(argv: string[]): DecisionBackend`. `ClefQuestion` and `ClefAnswer` keep their names and shapes: they are the normalised contract.

- [ ] **Step 1: Rename with git so history follows**

```bash
git mv scripts/eval/lib/clef-client.ts scripts/eval/lib/decision-client.ts
git mv tests/unit/scripts/clef-client.test.ts tests/unit/scripts/decision-client.test.ts
```

- [ ] **Step 2: Write the failing d1 tests** (append to `decision-client.test.ts`, and change its import to `askDecision, askDecisionOrNull, backendFromArgv` from `decision-client.js`; rename `askClef` to `askDecision` in the existing two tests)

```ts
describe("d1 backend", () => {
  const questions = {
    kind: { type: "choice", instructions: "k", criteria: { a: "A", b: "B" } },
    importance: { type: "score", instructions: "i", criteria: ["none", "minor", "big"] },
    decision: { type: "noul", instructions: "d" },
  } as const;

  it("posts to the d1 pass-through with string state and normalises answers", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ answers: {
        kind: { value: "b", probabilities: { a: 0.2, b: 0.8 }, metadata: { confidence: 0.8 } },
        importance: { value: 1.4, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, legend: { "0": "none" } },
        decision: { probability: 0.7 },
      } }), { status: 200 });
    }) as typeof fetch;
    const r = await askDecision({ session: "s" }, questions, { baseUrl: "http://gw", apiKey: "k", backend: "d1", fetchImpl });
    expect(seen?.url).toBe("http://gw/d1/v1/decisions");
    expect(seen?.body.state).toBe(JSON.stringify({ session: "s" }));
    expect(seen?.body.model).toBeUndefined();
    expect(r.answers.kind).toEqual({ type: "choice", choice: "b", confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } });
    expect(r.answers.importance).toEqual({ type: "score", score: 1.4, confidence: 0.5,
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, legend: { "0": "none" } });
    expect(r.answers.decision).toEqual({ type: "noul", noul: 0.7 });
  });

  it("throws when a d1 answer is missing its field", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ answers: {
      kind: { probabilities: { a: 1 } }, importance: { value: 1, probabilities: {}, legend: {} }, decision: { probability: 0.1 },
    } }), { status: 200 })) as typeof fetch;
    await expect(askDecision({}, questions, { baseUrl: "http://gw", apiKey: "k", backend: "d1", fetchImpl }))
      .rejects.toThrow(/kind/);
  });

  it("reads the backend from argv and defaults to clef", () => {
    expect(backendFromArgv(["node", "x", "--backend=d1"])).toBe("d1");
    expect(backendFromArgv(["node", "x"])).toBe("clef");
    expect(() => backendFromArgv(["node", "x", "--backend=gpt"])).toThrow(/backend/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/scripts/decision-client.test.ts`
Expected: FAIL (`askDecision` / `backendFromArgv` not exported).

- [ ] **Step 4: Implement** (replace the two functions in `decision-client.ts`; keep the `ClefQuestion`, `ClefAnswer`, `ClefOptions` type declarations unchanged above them)

```ts
export type DecisionBackend = "clef" | "d1";
export type DecisionOptions = ClefOptions & { readonly backend?: DecisionBackend };

type D1Answer = { value?: unknown; probability?: unknown; probabilities?: Record<string, number>;
  metadata?: { confidence?: unknown }; legend?: Record<string, string> };

function num(v: unknown, name: string): number {
  if (typeof v !== "number") throw new Error(`d1 answer ${name} is missing its value`);
  return v;
}

function fromD1(questions: Record<string, ClefQuestion>, raw: Record<string, D1Answer>): Record<string, ClefAnswer> {
  const out: Record<string, ClefAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = raw[name];
    if (!a) throw new Error(`d1 reply has no answer for ${name}`);
    if (q.type === "noul") {
      out[name] = { type: "noul", noul: num(a.probability, name) };
    } else if (q.type === "choice") {
      if (typeof a.value !== "string") throw new Error(`d1 answer ${name} is missing its value`);
      out[name] = { type: "choice", choice: a.value, confidence: num(a.metadata?.confidence, name), probabilities: a.probabilities ?? {} };
    } else {
      const probabilities = a.probabilities ?? {};
      out[name] = { type: "score", score: num(a.value, name), confidence: Math.max(0, ...Object.values(probabilities)),
        probabilities, legend: a.legend ?? {} };
    }
  }
  return out;
}

export async function askDecision(
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: DecisionOptions,
): Promise<{ answers: Record<string, ClefAnswer>; ms: number }> {
  const f = opts.fetchImpl ?? fetch;
  const d1 = opts.backend === "d1";
  const t0 = Date.now();
  const res = await f(`${opts.baseUrl}${d1 ? "/d1/v1/decisions" : "/clef/v1/systemone"}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(d1
      ? { state: typeof state === "string" ? state : JSON.stringify(state), questions }
      : { model: opts.model ?? "clef-oQ4e", state, questions }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`${d1 ? "d1" : "clef"} HTTP ${res.status}`);
  const json = (await res.json()) as { answers?: Record<string, unknown> };
  if (!json.answers) throw new Error(`${d1 ? "d1" : "clef"} reply has no answers`);
  const answers = d1 ? fromD1(questions, json.answers as Record<string, D1Answer>) : (json.answers as Record<string, ClefAnswer>);
  return { answers, ms: Date.now() - t0 };
}

export async function askDecisionOrNull(
  ...args: Parameters<typeof askDecision>
): Promise<Awaited<ReturnType<typeof askDecision>> | null> {
  try {
    return await askDecision(...args);
  } catch {
    return null;
  }
}

export function backendFromArgv(argv: string[]): DecisionBackend {
  const v = argv.find((a) => a.startsWith("--backend="))?.slice("--backend=".length) ?? "clef";
  if (v !== "clef" && v !== "d1") throw new Error(`unknown --backend ${v} (clef or d1)`);
  return v;
}
```

- [ ] **Step 5: Point the three scripts at the new client**

In each of `clef-triage.ts`, `clef-shadow.ts`, `clef-yield.ts`: change the import to `./lib/decision-client.js`, rename `askClef`/`askClefOrNull` call sites to `askDecision`/`askDecisionOrNull`, add `const backend = backendFromArgv(process.argv);`, add `backend` to the `opts` object, and change each answers-cache filename from `clef-<name>-answers.json` to `` `${backend}-<name>-answers.json` `` (the Clef cache name is unchanged, so existing caches still hit). In `clef-triage.ts` this is:

```ts
const backend = backendFromArgv(process.argv);
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]!, backend };
// ...
const answersPath = join(dataDir, `${backend}-triage-answers.json`);
// ...
console.log(`${backend} answers: ${cached.length} sessions, median ...`);
```

Update each script's header comment `Run:` line to show `[--backend=clef|d1]`.

- [ ] **Step 6: Verify**

Run: `npx vitest run tests/unit/scripts/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval/lib/decision-client.ts scripts/eval/clef-triage.ts scripts/eval/clef-shadow.ts scripts/eval/clef-yield.ts tests/unit/scripts/decision-client.test.ts
git commit -m "eval: decision client speaks Clef and d1, evals take --backend" -m "Work-Id: T640"
```

### Task 2: Serve d1 for the eval and route it through LiteLLM

Operations task (Studio, Pro gateway, Whtnxt Agent docs). No NLM repo code.

- [ ] **Step 1: Install mlx-vlm with d1 support in its own venv on the Studio** (the model card says d1 needs mlx-vlm newer than 0.7.6, from GitHub until the next release). Pin the commit you installed:

```bash
ssh echalupa@192.168.1.128 'python3 -m venv ~/.venvs/mlx-vlm-d1 && ~/.venvs/mlx-vlm-d1/bin/pip install -q -U git+https://github.com/Blaizzy/mlx-vlm.git && ~/.venvs/mlx-vlm-d1/bin/pip show mlx-vlm | head -2 && ~/.venvs/mlx-vlm-d1/bin/pip freeze | grep -i mlx-vlm'
```

- [ ] **Step 2: Start the decision server for the eval window** (reachable from the Pro over the LAN; the Pro reaches `192.168.1.128` directly, checked 2026-10-13). Record the PID so Step 6 can stop it:

```bash
ssh echalupa@192.168.1.128 'D=$(ls -d ~/.omlx/models/*/d1-3B-MLX-8bit); nohup ~/.venvs/mlx-vlm-d1/bin/python -m mlx_vlm server --decision-model "$D" --host 0.0.0.0 --port 8362 > ~/.venvs/mlx-vlm-d1/server.log 2>&1 & echo $! > ~/.venvs/mlx-vlm-d1/server.pid'
```

Expected: `curl -s http://192.168.1.128:8362/v1/decisions -H 'Content-Type: application/json' -d '{"state":"I was charged twice","questions":{"refund":{"type":"noul","instructions":"Is this a refund request?"}}}'` returns `answers.refund.probability` above 0.5.

- [ ] **Step 3: Add the LiteLLM pass-through** `/d1/v1/decisions` -> `http://192.168.1.128:8362/v1/decisions`, `auth: true`, the same way the Clef route was created (`POST /config/pass_through_endpoint` with the master key; see `.claude/reference/litellm.md` § Clef decision model pass-through). Read back with `GET /config/pass_through_endpoint` and record the new id.

- [ ] **Step 4: Smoke both panels through the gateway** with the NLM key, using `askDecision` so the normaliser is exercised end to end:

```bash
npx tsx -e '
import { readFileSync } from "node:fs"; import { homedir } from "node:os";
import { askDecision } from "./scripts/eval/lib/decision-client.js";
import { triageQuestions } from "./scripts/eval/lib/clef-panels.js";
const env = Object.fromEntries(readFileSync(homedir()+"/.nlm/.env","utf8").split("\n").filter(l=>l.includes("=")).map(l=>[l.split("=")[0], l.slice(l.indexOf("=")+1).trim()]));
const opts = { baseUrl: env.NLM_CLASSIFIER_BASE_URL.replace(/\/v1$/, ""), apiKey: env.NLM_CLASSIFIER_API_KEY, backend: "d1" as const };
const r = await askDecision({ session: "User asked for the weather. Assistant answered." }, triageQuestions(), opts);
console.log(r.ms, JSON.stringify(r.answers).slice(0, 400));'
```

Expected: every triage question answered, `importance.score` below 1. If d1 rejects `noul` criteria or object state, fix the request shape in `decision-client.ts` (with a test) before continuing. If the NLM scoped key cannot reach the route (the Clef route needed an unscoped key, see the Clef relay note in `config/services.yaml`), use the same key the T533 runs used and note it in the findings.

- [ ] **Step 5: Document** in the Whtnxt Agent repo (its own task worktree, `Work-Id: T640`): a "d1 decision model pass-through (eval only)" subsection under the Clef section of `.claude/reference/litellm.md` with the route, pass-through id, Studio port 8362, venv path, pinned mlx-vlm commit, and that the server is started by hand for evals and is not a LaunchAgent. Land with `nxtgit land`.

- [ ] **Step 6: After Tasks 3 and 4 finish, stop the server**: `ssh echalupa@192.168.1.128 'kill $(cat ~/.venvs/mlx-vlm-d1/server.pid)'` and confirm port 8362 is closed. Leave the pass-through in place (it returns 5xx while the server is down) and say so in the doc.

### Task 3: Workstream-binding panel and eval

**Files:**
- Create: `scripts/eval/lib/workstream-panel.ts`
- Create: `scripts/eval/decision-workstream.ts`
- Test: `tests/unit/scripts/workstream-panel.test.ts`

**Interfaces:**
- Consumes: `askDecision`, `backendFromArgv`, `ClefQuestion` (Task 1); `capState` from `clef-panels.ts`; `NAMING_CONTENT_CHARS` from `src/core/workstream/bind.ts`.
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
import type { ClefAnswer, ClefQuestion } from "./decision-client.js";

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

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/scripts/workstream-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `scripts/eval/decision-workstream.ts`**, reusing `tune-naming.ts`'s data loading (gold from `~/.nlm/eval/gold-matcher.jsonl`, active workstreams and session bodies from `~/.nlm/canonical.sqlite`, read-only). Per gold row: state `{ session: capState(\`${label}\n${body.slice(0, NAMING_CONTENT_CHARS)}\`) }`, one `workstreamQuestion(labels)` call, concurrency 2, answers cached to `$NLM_EVAL_DATA_DIR/workstream/${backend}-answers.json`, per-row errors recorded as `{ error: true }`. Print `scoreWorkstreams` at confidence cutoffs 0, 0.5, 0.7, 0.9, plus min and median latency and the active workstream count. Header comment: `Run: npx tsx scripts/eval/decision-workstream.ts [--backend=clef|d1]`.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run tests/unit/scripts/ && npm run typecheck`

```bash
git add scripts/eval/lib/workstream-panel.ts scripts/eval/decision-workstream.ts tests/unit/scripts/workstream-panel.test.ts
git commit -m "eval: workstream-binding decision panel and eval" -m "Work-Id: T640"
```

### Task 4: Run the bake-off and record it

- [ ] **Step 1: Production baseline for workstream binding**: `npx tsx scripts/eval/tune-naming.ts` (current classifier via env). Record accuracy and how many predictions were labels that matched no workstream (these become new workstreams in production).
- [ ] **Step 2: Triage (H2), both backends**: `npx tsx scripts/eval/clef-triage.ts --backend=clef` (cached, free) and `--backend=d1`. Record holdout AUC, the threshold chosen on tune, worthwhile skipped, all skipped.
- [ ] **Step 3: Yield at scale, d1**: `npx tsx scripts/eval/clef-yield.ts --backend=d1` at the threshold d1 chose on tune. Record skip rate, decisions lost, facts lost against Clef's 28.5% / 0.5% / 2.4%.
- [ ] **Step 4: Workstream binding, both backends**: `npx tsx scripts/eval/decision-workstream.ts --backend=clef` and `--backend=d1`.
- [ ] **Step 5: Latency and memory**: for each backend, min and median call time on a quiet Studio (check oMLX has no active requests first), and resident memory (`ps -o rss` for the mlx-vlm PID; Clef's ~16 GB from the oMLX checkpoint table).
- [ ] **Step 6: Write the findings**: add a "d1-3B vs Clef" section to `docs/clef-decision-panel-findings.md` with one table per task (aggregates only), and a per-task verdict using these rules fixed before the runs: d1 is adopted for a task when its holdout result is within 0.03 AUC (triage) or 3 points of accuracy (workstream) of Clef's and it is faster; otherwise Clef stays. Workstream binding is adopted at all only if the winner beats the production baseline on correct binds and produces fewer wrong binds.
- [ ] **Step 7: Commit, stop the d1 server (Task 2 Step 6), land**

```bash
git add docs/clef-decision-panel-findings.md docs/superpowers/plans/2026-10-13-decision-model-bakeoff.md
git commit -m "docs: d1-3B vs Clef bake-off findings" -m "Work-Id: T640"
nxtgit land --cwd /Users/echalupa/.nxtos/worktrees/nlm-memory-7f145dc6 --done
```

## After this plan

Adoption plans, each in its owning repo under T639, written from the findings: the NLM ingest triage gate (H2 integration, already justified for Clef), NLM workstream binding, the T533 H3 judge and H4 session-close runs on the winning model, then nxtos (claim adjudicator, engage scoring, observability judge), passive-map, and the nxtsocial skill gates.
