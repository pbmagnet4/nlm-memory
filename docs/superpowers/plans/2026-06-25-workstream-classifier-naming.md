# Workstream Binding by Classifier-Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind sessions to workstreams by having the classifier name the project (content signal), replacing the embedding matcher that ceilinged at 57% precision.

**Architecture:** A new `nameWorkstream(content, candidates)` LLM call asks the classifier which seeded workstream a session belongs to (or "none"). A pure `decideWorkstreamByName` maps the name to a seeded workstream via label + alias match, else abstains. `bind.ts` swaps its embedding decision for this; the historical backfill script does the same with `binding_source='backfill'`. The embedding matcher (`match.ts`, `build-match-inputs.ts`) is retired from the bind path and deleted.

**Tech Stack:** TypeScript, better-sqlite3, hexagonal ports/adapters, vitest, OpenAI-compatible classifier (DeepSeekClient → LM Studio qwen3.5-4b) and OllamaClient.

## Global Constraints

- TDD: failing test → run-it-fails → minimal impl → green. `npm run test` + `npm run typecheck` before every commit; `npm run build:server` for any file in the daemon graph (`bind.ts`, clients, ports).
- No em dashes in any committed string, prompt, or output (Edward's hard rule). Use ` - ` or restructure.
- Reversibility: backfill writes only `workstream_id` + `binding_source='backfill'`; NEVER creates a workstream.
- Public repo (nlm-memory): no home paths (`/Users/...`), IPs, or unreleased venture names in committed code/fixtures. Generic fixtures only. Never `git add .`; stage named files. Never stage `scripts/eval/judge-calibration.ts` or `scripts/eval/_r3e-*.ts`.
- Thinking-model budget: the openai classifier (qwen3.5) emits hidden reasoning; the naming call MUST pass a token budget large enough (reuse `classifyMaxTokens`, default 8192) or it returns empty content (`finish_reason=length`) and silently names "none" for everything.
- One source of truth (DRY): the name-match decision lives in exactly one pure function used by both forward bind and backfill.
- `NLM_WORKSTREAM_BIND` stays OFF the entire plan. The flip is a separate Edward-gated runbook step gated on the locked gold numbers, post-push.

---

### Task 1: `nameWorkstream` on the LLMClient port + ClassifierBox delegation

**Files:**
- Modify: `src/ports/llm-client.ts` (add method + types to the `LLMClient` interface)
- Modify: `src/llm/classifier-box.ts` (delegate to inner; default-throw on embed-only inner is fine)
- Test: `src/llm/classifier-box.test.ts` (create if absent, else append)

**Interfaces:**
- Produces: `interface WorkstreamCandidateHint { label: string; aliases: ReadonlyArray<string> }`; `LLMClient.nameWorkstream(content: string, candidates: ReadonlyArray<WorkstreamCandidateHint>): Promise<string | null>` — returns the chosen candidate `label` verbatim, or `null` for "none"/no-answer.

- [ ] **Step 1: Write the failing test** (append to `src/llm/classifier-box.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { ClassifierBox } from "./classifier-box.js";

describe("ClassifierBox.nameWorkstream", () => {
  it("delegates to the inner client and returns its answer", async () => {
    const box = new ClassifierBox({ provider: "openai", model: "qwen3.5-4b-mlx", baseUrl: "http://x/v1" });
    // @ts-expect-error - reach past the wrapper to stub the inner client for the test
    box["inner"] = { nameWorkstream: async () => "NLM" };
    const out = await box.nameWorkstream("some session text", [{ label: "NLM", aliases: ["nlm-memory"] }]);
    expect(out).toBe("NLM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/classifier-box.test.ts -t nameWorkstream`
Expected: FAIL — `nameWorkstream` not on `ClassifierBox` / not on `LLMClient`.

- [ ] **Step 3: Add the port types + method** (in `src/ports/llm-client.ts`, inside the `LLMClient` interface and above it for the type)

```ts
export interface WorkstreamCandidateHint {
  readonly label: string;
  readonly aliases: ReadonlyArray<string>;
}
```

Add to the `LLMClient` interface (next to `classify`):

```ts
  /** Name which candidate workstream this session belongs to, or null for "none".
   *  Returns the chosen candidate.label verbatim. Content is label+summary or a transcript. */
  nameWorkstream(content: string, candidates: ReadonlyArray<WorkstreamCandidateHint>): Promise<string | null>;
```

- [ ] **Step 4: Delegate in ClassifierBox** (`src/llm/classifier-box.ts`, next to `classify`)

```ts
  nameWorkstream(content: string, candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>): Promise<string | null> {
    return this.inner.nameWorkstream(content, candidates);
  }
```

(The `embed`-only clients — `OpenAIEmbedderClient` — will gain a throwing stub in their own files only if `typecheck` flags them as `LLMClient` implementors. The embedder is wired as `embed`-only and is NOT an `LLMClient` bind-path consumer, so prefer a narrow `Pick<LLMClient, "nameWorkstream">` dependency in the bind wiring (Task 5) over forcing every client to implement it. If typecheck demands a stub on a class typed as `LLMClient`, add `nameWorkstream(): Promise<string | null> { throw new Error("<client> does not support nameWorkstream"); }`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/llm/classifier-box.test.ts -t nameWorkstream && npm run typecheck`
Expected: PASS; typecheck clean (resolve any new-method stubs per Step 4 note).

- [ ] **Step 6: Commit**

```bash
git add src/ports/llm-client.ts src/llm/classifier-box.ts src/llm/classifier-box.test.ts
git commit -m "feat(workstream): nameWorkstream on LLMClient port + ClassifierBox delegation (#367)"
```

---

### Task 2: `nameWorkstream` in DeepSeekClient (production openai/LM Studio path)

**Files:**
- Modify: `src/llm/deepseek-client.ts`
- Test: `src/llm/deepseek-client.test.ts` (append)

**Interfaces:**
- Consumes: `WorkstreamCandidateHint` (Task 1). Uses the existing `fetchImpl`, `baseUrl`, `apiKey`, `classifyModel`, `classifyMaxTokens` fields.
- Produces: `DeepSeekClient.nameWorkstream(...)` matching the port signature.

- [ ] **Step 1: Write the failing test** (append to `src/llm/deepseek-client.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { DeepSeekClient } from "./deepseek-client.js";

function fakeFetch(content: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
}

describe("DeepSeekClient.nameWorkstream", () => {
  const cands = [{ label: "NLM", aliases: ["nlm-memory"] }, { label: "Acme", aliases: [] }];
  it("returns the matched candidate label from a chatty (thinking) response", async () => {
    const c = new DeepSeekClient({ baseUrl: "http://x/v1", apiKey: "local", classifyModel: "qwen3.5-4b-mlx", fetchImpl: fakeFetch("<reasoning...>\n\nNLM") });
    expect(await c.nameWorkstream("Finding insertion points for nlm-memory files\nsummary", cands)).toBe("NLM");
  });
  it("returns null when the model answers none", async () => {
    const c = new DeepSeekClient({ baseUrl: "http://x/v1", apiKey: "local", classifyModel: "qwen3.5-4b-mlx", fetchImpl: fakeFetch("none") });
    expect(await c.nameWorkstream("Zephyr persona work\nsummary", cands)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/deepseek-client.test.ts -t nameWorkstream`
Expected: FAIL — method not defined.

- [ ] **Step 3: Implement `nameWorkstream`** (in `DeepSeekClient`, mirror `classifyOnce`'s fetch but plain-text output)

```ts
async nameWorkstream(content: string, candidates: ReadonlyArray<import("@ports/llm-client.js").WorkstreamCandidateHint>): Promise<string | null> {
  if (candidates.length === 0) return null;
  const list = candidates
    .map((c) => (c.aliases.length ? `- ${c.label} (aka ${c.aliases.join(", ")})` : `- ${c.label}`))
    .join("\n");
  const sys =
    `You label a work session by which project it belongs to. Known projects:\n${list}\n` +
    `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none".`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), this.classifyTimeoutMs);
  try {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.classifyModel,
        temperature: 0,
        max_tokens: this.classifyMaxTokens, // covers hidden reasoning + the short answer
        messages: [{ role: "system", content: sys }, { role: "user", content }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null; // fail-soft: naming is best-effort, never throw into the bind path
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = (data.choices?.[0]?.message?.content ?? "").toLowerCase();
    // Robust parse: pick the longest candidate label that appears in the (possibly chatty) reply.
    let best: string | null = null, bestLen = 0;
    for (const c of candidates) if (out.includes(c.label.toLowerCase()) && c.label.length > bestLen) { best = c.label; bestLen = c.label.length; }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/deepseek-client.test.ts -t nameWorkstream`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/llm/deepseek-client.ts src/llm/deepseek-client.test.ts
git commit -m "feat(workstream): DeepSeekClient.nameWorkstream - project naming over OpenAI-compatible chat (#367)"
```

---

### Task 3: `nameWorkstream` in OllamaClient (parity, think-off for qwen3.5)

**Files:**
- Modify: `src/llm/ollama-client.ts`
- Test: `src/llm/ollama-client.test.ts` (append)

**Interfaces:**
- Produces: `OllamaClient.nameWorkstream(...)` matching the port. Same prompt + robust-parse contract as Task 2; routes through the Ollama `/api/chat` (or the client's existing chat path) with `think:false` when the model needs it.

- [ ] **Step 1: Write the failing test** (append to `src/llm/ollama-client.test.ts`, mirroring that file's existing fetch-mock helper)

```ts
import { describe, it, expect } from "vitest";
import { OllamaClient } from "./ollama-client.js";

describe("OllamaClient.nameWorkstream", () => {
  const cands = [{ label: "NLM", aliases: ["nlm-memory"] }];
  it("returns the matched label", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: { content: "NLM" } }), { status: 200 })) as unknown as typeof fetch;
    const c = new OllamaClient({ baseUrl: "http://x", classifyModel: "qwen3:4b-instruct", fetchImpl });
    expect(await c.nameWorkstream("nlm-memory work\nsummary", cands)).toBe("NLM");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/llm/ollama-client.test.ts -t nameWorkstream`
Expected: FAIL — method not defined. (If the constructor field names differ — `fetchImpl`, `classifyModel` — read the OllamaClient constructor first and match them exactly.)

- [ ] **Step 3: Implement `nameWorkstream`** mirroring the same system prompt + robust-parse as Task 2, using OllamaClient's existing chat request shape (`/api/chat`, `messages`, `stream:false`, and `think:false` when `classifierNeedsThinkDisabled(model)` from `classifier-box.js`). Parse `message.content` with the identical longest-label-substring match. Fail-soft to `null` on non-OK / throw.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/llm/ollama-client.test.ts -t nameWorkstream`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/ollama-client.ts src/llm/ollama-client.test.ts
git commit -m "feat(workstream): OllamaClient.nameWorkstream parity (#367)"
```

---

### Task 4: `decideWorkstreamByName` pure decision + alias loader

**Files:**
- Create: `src/core/workstream/name-match.ts`
- Test: `src/core/workstream/name-match.test.ts`

**Interfaces:**
- Consumes: `normalizeLabel` from `./model.js`; `Workstream` from `./model.js`.
- Produces:
  - `type NameDecision = { kind: "bind"; workstreamId: string } | { kind: "abstain" }`
  - `decideWorkstreamByName(named: string | null, workstreams: ReadonlyArray<Pick<Workstream, "id" | "label">>, aliasToLabel: ReadonlyMap<string, string>): NameDecision`
  - Resolution order: `null`/empty → abstain; exact normalized seeded-label match → bind; normalized alias→canonical-label then seeded-label match → bind; else abstain. Never creates.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { decideWorkstreamByName } from "./name-match.js";

const ws = [{ id: "ws_nlm", label: "NLM" }, { id: "ws_acme", label: "Acme" }];
const aliases = new Map([["nlm-memory", "NLM"]]);

describe("decideWorkstreamByName", () => {
  it("binds on exact seeded label (case-insensitive)", () => {
    expect(decideWorkstreamByName("nlm", ws, aliases)).toEqual({ kind: "bind", workstreamId: "ws_nlm" });
  });
  it("binds via alias map", () => {
    expect(decideWorkstreamByName("nlm-memory", ws, aliases)).toEqual({ kind: "bind", workstreamId: "ws_nlm" });
  });
  it("abstains on none/null/unknown", () => {
    expect(decideWorkstreamByName(null, ws, aliases)).toEqual({ kind: "abstain" });
    expect(decideWorkstreamByName("Zephyr", ws, aliases)).toEqual({ kind: "abstain" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workstream/name-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/workstream/name-match.ts
import { normalizeLabel, type Workstream } from "./model.js";

export type NameDecision = { kind: "bind"; workstreamId: string } | { kind: "abstain" };

export function decideWorkstreamByName(
  named: string | null,
  workstreams: ReadonlyArray<Pick<Workstream, "id" | "label">>,
  aliasToLabel: ReadonlyMap<string, string>,
): NameDecision {
  if (!named || !named.trim()) return { kind: "abstain" };
  const byLabel = new Map(workstreams.map((w) => [normalizeLabel(w.label), w.id]));
  const direct = byLabel.get(normalizeLabel(named));
  if (direct) return { kind: "bind", workstreamId: direct };
  const canonical = aliasToLabel.get(normalizeLabel(named));
  if (canonical) {
    const viaAlias = byLabel.get(normalizeLabel(canonical));
    if (viaAlias) return { kind: "bind", workstreamId: viaAlias };
  }
  return { kind: "abstain" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/workstream/name-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workstream/name-match.ts src/core/workstream/name-match.test.ts
git commit -m "feat(workstream): decideWorkstreamByName - name/alias match decision (#367)"
```

---

### Task 5: Rewire `bind.ts` to the classifier-naming decision

**Files:**
- Modify: `src/core/workstream/bind.ts`
- Test: `src/core/workstream/bind.test.ts` (modify the existing suite)

**Interfaces:**
- Consumes: `nameWorkstream` (Task 1, via `Pick<LLMClient, "nameWorkstream">`), `decideWorkstreamByName` (Task 4).
- Produces: `bindSessionToWorkstream(deps, input)` keeps its `BindResult | null` shape but `BindDeps` now needs `namer: Pick<LLMClient, "nameWorkstream">`, `workstreams: Pick<WorkstreamStore, "listAll" | "upsertEntities" | "touchLastSession">`, `sessions: Pick<SessionStore, "setWorkstreamBinding">`, `aliasToLabel: ReadonlyMap<string,string>`, optional `createOnNoMatch?: boolean` (default false → abstain). Drops `embedder`, `thresholds`, `weights`, `pickAmbiguous`, `semanticSearch`, `getWorkstreamIds`, `findByNormalizedLabel`/`getById`/`create` (unless `createOnNoMatch`).

**Details:** New flow — `named = await deps.namer.nameWorkstream(content, hints)` where `content = `${input.label}\n${input.summary}`` and `hints` are built from `await deps.workstreams.listAll()` (label + aliases reverse-mapped from `aliasToLabel`). `decision = decideWorkstreamByName(named, ws, deps.aliasToLabel)`. On `bind`: `setWorkstreamBinding(input.sessionId, decision.workstreamId, "classifier", null)` + `upsertEntities` + `touchLastSession`, return `{ workstreamId, created: false, confidence: null }`. On `abstain`: return `null` (leave unbound) unless `createOnNoMatch` is true (then keep the existing `createOrDedup` path). Whole body stays wrapped in the existing try/catch fail-soft.

- [ ] **Step 1: Rewrite the failing test** — replace the embedding-matcher setup in `bind.test.ts` with a fake namer. Example case:

```ts
it("binds via classifier naming", async () => {
  const set: Array<[string, string, string]> = [];
  const deps = {
    namer: { nameWorkstream: async () => "NLM" },
    workstreams: { listAll: async () => [{ id: "ws_nlm", label: "NLM" }], upsertEntities: async () => {}, touchLastSession: async () => {} },
    sessions: { setWorkstreamBinding: async (s: string, w: string, src: string) => { set.push([s, w, src]); } },
    aliasToLabel: new Map<string, string>(),
  } as any;
  const r = await bindSessionToWorkstream(deps, { sessionId: "s1", label: "nlm work", summary: "sum", entities: [], startedAt: "2026-01-01T00:00:00Z" });
  expect(r).toEqual({ workstreamId: "ws_nlm", created: false, confidence: null });
  expect(set).toEqual([["s1", "ws_nlm", "classifier"]]);
});

it("abstains (returns null, no binding) when classifier says none", async () => {
  const deps = {
    namer: { nameWorkstream: async () => null },
    workstreams: { listAll: async () => [{ id: "ws_nlm", label: "NLM" }], upsertEntities: async () => {}, touchLastSession: async () => {} },
    sessions: { setWorkstreamBinding: async () => { throw new Error("must not bind"); } },
    aliasToLabel: new Map<string, string>(),
  } as any;
  expect(await bindSessionToWorkstream(deps, { sessionId: "s2", label: "knxt", summary: "s", entities: [], startedAt: "2026-01-01T00:00:00Z" })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workstream/bind.test.ts`
Expected: FAIL — old `BindDeps` shape / embedding decision still wired.

- [ ] **Step 3: Rewrite `bind.ts`** per Details above. Remove the `buildMatchInputs`/`matchWorkstream`/`pickAmbiguous`/`createOrDedup`(default) imports and logic; keep the try/catch and the downstream `upsertEntities`/`touchLastSession`. Build `hints` as `ws.map(w => ({ label: w.label, aliases: aliasesFor(w.label, deps.aliasToLabel) }))`.

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run src/core/workstream/bind.test.ts && npm run typecheck`
Expected: PASS. Fix every caller the changed `BindDeps` breaks (the scheduler wiring) — update it to pass `namer` (the `ClassifierBox`), drop `embedder`/`thresholds`/`weights`/`pickAmbiguous`, and load `aliasToLabel` from `~/.nlm/work-topics.json` via the existing `parseWorkTopics` (reuse `scripts/seed-workstreams.ts`'s parser; if it is not exported, export it from a shared module — do not duplicate).

- [ ] **Step 5: Build the daemon graph**

Run: `npm run build:server`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/workstream/bind.ts src/core/workstream/bind.test.ts <changed scheduler/wiring files>
git commit -m "feat(workstream): bind via classifier naming, retire embedding decision from bind path (#367)"
```

---

### Task 6: Backfill rewrite — name-only historical binding

**Files:**
- Modify: `src/core/workstream/backfill-workstreams.ts` (core)
- Modify: `scripts/backfill-workstreams.ts` (script wiring)
- Test: `src/core/workstream/backfill-workstreams.test.ts`

**Interfaces:**
- Consumes: `nameWorkstream` (Task 1), `decideWorkstreamByName` (Task 4).
- Produces: `backfillWorkstreams(deps)` with `deps = { listSessions, nameSession (sessionId,content) => Promise<string|null>, decide (named) => NameDecision, setBinding(sessionId, workstreamId) => Promise<void>, log? }`. Binds only on `decision.kind === "bind"`; "abstain" leaves NULL. `BackfillResult { considered, bound, skipped }` unchanged.

- [ ] **Step 1: Write the failing test** — non-tautological: real `decideWorkstreamByName` over a fake namer.

```ts
import { describe, it, expect } from "vitest";
import { backfillWorkstreams } from "./backfill-workstreams.js";
import { decideWorkstreamByName } from "./name-match.js";

it("binds named sessions, abstains on none", async () => {
  const ws = [{ id: "ws_nlm", label: "NLM" }];
  const names = new Map([["s1", "NLM"], ["s2", null as string | null]]);
  const bound: Array<[string, string]> = [];
  const res = await backfillWorkstreams({
    listSessions: async () => [{ sessionId: "s1", content: "a" }, { sessionId: "s2", content: "b" }],
    nameSession: async (id: string) => names.get(id) ?? null,
    decide: (named: string | null) => decideWorkstreamByName(named, ws, new Map()),
    setBinding: async (s: string, w: string) => { bound.push([s, w]); },
  });
  expect(res).toEqual({ considered: 2, bound: 1, skipped: 1 });
  expect(bound).toEqual([["s1", "ws_nlm"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workstream/backfill-workstreams.test.ts`
Expected: FAIL — old `matchWorkstream`-based signature.

- [ ] **Step 3: Rewrite the core** to the name-only loop (drop `matchWorkstream` import):

```ts
export interface BackfillSession { readonly sessionId: string; readonly content: string; }
export interface BackfillDeps {
  readonly listSessions: () => Promise<ReadonlyArray<BackfillSession>>;
  readonly nameSession: (sessionId: string, content: string) => Promise<string | null>;
  readonly decide: (named: string | null) => { kind: "bind"; workstreamId: string } | { kind: "abstain" };
  readonly setBinding: (sessionId: string, workstreamId: string) => Promise<void>;
  readonly log?: (msg: string) => void;
}
export async function backfillWorkstreams(deps: BackfillDeps): Promise<BackfillResult> {
  const sessions = await deps.listSessions();
  let bound = 0, skipped = 0;
  for (const s of sessions) {
    const decision = deps.decide(await deps.nameSession(s.sessionId, s.content));
    if (decision.kind === "bind") { await deps.setBinding(s.sessionId, decision.workstreamId); bound++; deps.log?.(`[backfill] ${s.sessionId} -> ${decision.workstreamId}`); }
    else skipped++;
  }
  return { considered: sessions.length, bound, skipped };
}
```

- [ ] **Step 4: Rewire the script** (`scripts/backfill-workstreams.ts`): build the `ClassifierBox` (reuse the daemon's classifier construction, not a hand-rolled client), load workstreams + `aliasToLabel` (parseWorkTopics), `nameSession` = `box.nameWorkstream(content, hints)` with `content = label + "\n" + summary` (transcript read is a tuning lever, default label+summary), `decide` = `decideWorkstreamByName(named, ws, aliasToLabel)`, `setBinding` = `storage.sessions.setWorkstreamBinding(s, w, "backfill", null)` guarded by `--dry-run`. Keep the `--dry-run` print and `storage.close()` finally. Space-safe `fileURLToPath` entrypoint guard (already in the file).

- [ ] **Step 5: Run tests + typecheck + a dry-run smoke**

Run: `npx vitest run src/core/workstream/backfill-workstreams.test.ts && npm run typecheck && npx tsx scripts/backfill-workstreams.ts --dry-run` (LM Studio must be up; expect `considered=4276, bound 0` written-nothing under dry-run, no throw).
Expected: tests PASS; dry-run prints considered/bound/skipped, no DB write.

- [ ] **Step 6: Commit**

```bash
git add src/core/workstream/backfill-workstreams.ts src/core/workstream/backfill-workstreams.test.ts scripts/backfill-workstreams.ts
git commit -m "feat(workstream): name-only historical backfill (binding_source=backfill) (#367)"
```

---

### Task 7: Retire the embedding matcher

**Files:**
- Delete: `src/core/workstream/match.ts`, `src/core/workstream/match.test.ts`, `src/core/workstream/build-match-inputs.ts`, `src/core/workstream/build-match-inputs.test.ts`
- Modify: any remaining importers (`thresholds.ts` may become dead too — delete if no live consumer remains), `scripts/eval/tune-matcher.ts` + `scripts/eval/lib/matcher-gold.ts` (the embedding tuner is obsolete; delete or convert — see Step 3)

**Interfaces:**
- Produces: a build with zero references to `matchWorkstream`/`scoreCandidates`/`buildMatchInputs`.

- [ ] **Step 1: Find every importer**

Run: `grep -rn "matchWorkstream\|scoreCandidates\|buildMatchInputs\|jaccard\|DEFAULT_WEIGHTS\|MatchInputs\|MatchDecision" src/ scripts/ --include=*.ts | grep -v _r3e`
Expected: a finite list. Each must be removed or repointed.

- [ ] **Step 2: Delete the matcher modules + tests**

```bash
git rm src/core/workstream/match.ts src/core/workstream/match.test.ts src/core/workstream/build-match-inputs.ts src/core/workstream/build-match-inputs.test.ts
```

- [ ] **Step 3: Repoint/retire the eval tuner.** The gold harness (`scripts/eval/lib/matcher-gold.ts`, `tune-matcher.ts`) tuned the embedding scorer. Replace `tune-matcher.ts` with the naming validation (promote `scripts/eval/_r3e-classifier-naming.ts` into a committed `scripts/eval/tune-naming.ts` — scrub any home paths/IPs, generic only) OR delete `tune-matcher.ts` if the runbook (Task 8) covers tuning. Keep `matcher-gold.ts`'s `loadGold`/`scoreGold` if reused; drop `sweepThresholds`/`Prediction` if dead. Remove `MatchInputs`/`MatchDecision`/`MatchThresholds`/`MatchWeights` from `model.ts` only if no surviving file references them.

- [ ] **Step 4: Full gate**

Run: `npm run test && npm run typecheck && npm run build:server`
Expected: green. The known pre-existing `cli-work-digest` flake may appear — confirm it is unrelated (diff doesn't touch it).

- [ ] **Step 5: Hygiene scan before commit**

Run: `git diff --cached | grep -nE "/Users/|192\.168|<operator-username>|<unreleased-venture-or-client-names>" ; git status --short | grep judge-calibration` (scan the staged diff for home paths, IPs, and any private client/venture workstream labels before committing)
Expected: no matches in staged diff; `judge-calibration.ts` remains untracked (never staged).

- [ ] **Step 6: Commit**

```bash
git add -A src/core/workstream/ src/ports/llm-client.ts scripts/eval/
git commit -m "refactor(workstream): retire embedding matcher (match.ts/build-match-inputs) - classifier naming is the bind decision (#367)"
```

---

### Task 8 (operational, not code): Tune vs gold + flip runbook

Not a TDD task — an Edward-gated runbook executed by the controller post-merge/post-push.

- **T-A Tune:** run the naming validation against the LOCKED gold (`~/.nlm/eval/gold-matcher.jsonl`, reuse — do not relabel). Measure label+summary vs full-transcript content and alias/entity hints on/off. Target: hold precision high (≈0 wrong-project), push recall above the 29% floor. Record the chosen `content` strategy + prompt.
- **T-B Backfill:** `npx tsx scripts/backfill-workstreams.ts` (no `--dry-run`) on the live DB. Reversible: `UPDATE sessions SET workstream_id=NULL, binding_source=NULL WHERE binding_source='backfill'`.
- **T-C Verify:** `nlm work-digest` reads workstream labels on 2 sample days; spot-check binds against transcripts.
- **T-D Flip (Edward-gated, irreversible-ish, post-push):** set `NLM_WORKSTREAM_BIND=true`, restart daemon (`launchctl kickstart com.github.pbmagnet4.nlm-memory`). Gate strictly on T-A gold numbers, not a schedule.

---

## Self-Review

**Spec coverage:** §"the pieces" 1 (naming call) → Tasks 1-3; 2 (name-match decision) → Task 4; 3 (rewire bind.ts) → Task 5; 4 (backfill rewrite) → Task 6; 5 (retire embedding) → Task 7; tuning+gate → Task 8. Thinking-budget gotcha → Global Constraints + Task 2 Step 3. Reversibility/hygiene/no-em-dash → Global Constraints + Task 6/7. Open questions (separate call, transcript-vs-l+s, hints, false-binds, create-on-no-match) → resolved: separate `nameWorkstream` call (Task 1); content strategy is a Task 8 tuning lever defaulting to label+summary; `createOnNoMatch` defaults false (Task 5).

**Placeholder scan:** code blocks present for every code step; Task 3/Task 5-Step3 describe deltas with explicit field lists and reference the exact pattern to mirror (acceptable: they modify large existing files where reproducing the whole file would mislead). No "TODO"/"handle edge cases".

**Type consistency:** `WorkstreamCandidateHint {label, aliases}` (Task 1) used in Tasks 2/3/5. `nameWorkstream(content, candidates): Promise<string|null>` consistent across port + both clients + ClassifierBox. `NameDecision`/`decideWorkstreamByName(named, workstreams, aliasToLabel)` consistent Tasks 4/5/6. `binding_source` values `"classifier"` (forward) / `"backfill"` (historical) match the schema (additive TEXT, already in `BindingSource`).
