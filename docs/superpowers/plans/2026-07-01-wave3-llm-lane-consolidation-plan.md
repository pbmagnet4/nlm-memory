# Wave 3: LLM-Lane Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One source of truth for the workstream-naming prompt and parse, the classifier factory, and the classify retry/parse chain, so the Task 8 naming-prompt tuning runbook edits exactly one file and the two LLM clients cannot silently diverge. Also breaks the ClassifierBox/ollama-client import cycle (M7).

**Architecture:** Small leaf modules under `src/llm/` (naming.ts, model-quirks.ts, client-shared.ts) consumed by both concrete clients; the nlm.ts buildClassifier fork is deleted in favor of the shared factory. No behavior change anywhere: every extraction must be byte-equivalent in effect, pinned by existing tests plus new unit tests on the extracted functions.

**Tech Stack:** TypeScript ESM, Vitest. No pg involvement; the full gate here is typecheck + `npm test` only.

## Global Constraints

- ZERO behavior change. The naming prompt text sent by each client must be byte-identical to today (deepseek keeps its trailing " /no_think", ollama does not have it). Any intentional divergence is a plan violation.
- No em dashes in ANY added text. No narration comments. No literal NUL bytes. No new dependencies.
- Full gate after every task: `npm run typecheck` clean + `npm test` green (tolerated: the cli-work-digest subprocess flake). Do NOT set NLM_PG_TEST_URL; pg files skip.
- Never commit anything under `.superpowers/`.
- Commit style: `refactor(llm): ...`, one commit per task.
- This wave runs concurrently with Wave 2b (pg files); touching anything under `src/core/storage/`, `src/core/actions/`, or `migrations/` is out of fence.

---

### Task 1: Shared naming module (M1)

The workstream-naming prompt and the longest-label parse are duplicated in `src/llm/deepseek-client.ts` (nameWorkstream, ~lines 244-288) and `src/llm/ollama-client.ts` (nameWorkstream, ~lines 266-310). The prompt is production-load-bearing for workstream binding and about to be tuned (Task 8 runbook); it must live in one file.

**Files:**
- Create: `src/llm/naming.ts`
- Modify: `src/llm/deepseek-client.ts`, `src/llm/ollama-client.ts` (nameWorkstream bodies consume the module)
- Test: `tests/unit/llm/naming.test.ts` (new)

**Interfaces:**
- Produces:

```typescript
import type { WorkstreamCandidateHint } from "@ports/llm-client.js";

export function buildNamingSystemPrompt(
  candidates: ReadonlyArray<WorkstreamCandidateHint>,
  opts?: { readonly noThinkSuffix?: boolean },
): string {
  const list = candidates.map((c) => `- ${c.label}`).join("\n");
  return (
    `You label a work session by which project it belongs to. Known projects:\n${list}\n` +
    `If it belongs to NONE of these, answer "none". Reply with ONLY the exact project name from the list, or "none".` +
    (opts?.noThinkSuffix ? " /no_think" : "")
  );
}

export function parseLongestLabel(
  out: string,
  candidates: ReadonlyArray<WorkstreamCandidateHint>,
): string | null {
  const lower = out.toLowerCase();
  let best: string | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    if (lower.includes(c.label.toLowerCase()) && c.label.length > bestLen) {
      best = c.label;
      bestLen = c.label.length;
    }
  }
  return best;
}
```

- [ ] **Step 1: Failing unit tests** in `tests/unit/llm/naming.test.ts`: prompt renders the exact current text for a two-candidate list WITH and WITHOUT the suffix (assert full string equality against the literal text currently in each client); parseLongestLabel picks the longest matching label when one label is a substring of another (candidates "NLM" and "NLM UI", reply mentions "nlm ui"); returns null on "none" reply and on no-match; is case-insensitive.

- [ ] **Step 2: RED, then create the module** exactly as specified above.

- [ ] **Step 3: Consume in both clients.** deepseek: `buildNamingSystemPrompt(candidates, { noThinkSuffix: true })`; ollama: `buildNamingSystemPrompt(candidates)`. Replace both inline longest-label loops with `parseLongestLabel(out, candidates)` (note ollama lowercases before the loop today and deepseek lowercases inline; the shared function takes the RAW string and lowercases internally, so pass the unlowered content and delete the local `.toLowerCase()`). Delete the now-unused local `list`/`sys` construction. Everything else in each nameWorkstream (transport, timeout, fail-soft catch) stays untouched.

- [ ] **Step 4: Green (naming tests + both client test files + full gate), commit**

```bash
git add src/llm/naming.ts src/llm/deepseek-client.ts src/llm/ollama-client.ts tests/unit/llm/naming.test.ts
git commit -m "refactor(llm): single source for workstream naming prompt and parse"
```

---

### Task 2: Break the ClassifierBox/ollama-client cycle (M7)

`ollama-client.ts:24` imports `classifierNeedsThinkDisabled` from `classifier-box.ts`; `classifier-box.ts:20` imports `OllamaClient` back. Runtime-safe today only because the predicate is a hoisted function declaration; converting it to a const arrow would TDZ-crash at boot.

**Files:**
- Create: `src/llm/model-quirks.ts`
- Modify: `src/llm/classifier-box.ts`, `src/llm/ollama-client.ts`
- Test: none new (the predicate's behavior is already pinned by classifier-box tests; this is a pure move)

- [ ] **Step 1: Create the leaf module** containing `classifierNeedsThinkDisabled` verbatim (with its doc comment). Grep for ALL importers of the symbol (`grep -rn "classifierNeedsThinkDisabled" src/ tests/ scripts/`) and repoint every one to `./model-quirks.js` (or the relative path from tests). Remove the definition from classifier-box.ts; do NOT leave a re-export.

- [ ] **Step 2: Verify the cycle is gone**: `grep -n "classifier-box" src/llm/ollama-client.ts` returns nothing. Full gate. Commit:

```bash
git add src/llm/model-quirks.ts src/llm/classifier-box.ts src/llm/ollama-client.ts
git commit -m "refactor(llm): move classifierNeedsThinkDisabled to a leaf module, breaking the box/client cycle"
```

(also `git add` any test/script files repointed in Step 1)

---

### Task 3: Delete the nlm.ts buildClassifier fork (M3)

`src/cli/nlm.ts:170-202` duplicates `src/llm/build-classifier.ts` with one live divergence: the fork autoloads env only when provider is not ollama, the shared factory autoloads unconditionally (correct; the conditional version silently binds the wrong provider on any call path that has not already autoloaded).

**Files:**
- Modify: `src/cli/nlm.ts` (delete the local function, import the shared one)
- Modify: `src/llm/build-classifier.ts` (absorb the production-rationale comment)

- [ ] **Step 1: Move the comment.** The nlm.ts fork carries the production-classifier rationale block (qwen3.5:4b eval numbers, provider routing intent, ~lines 171-181). Merge its content into build-classifier.ts's header comment (do not lose the eval provenance; deduplicate sentences that both already have).

- [ ] **Step 2: Reconcile ollamaUrl.** The fork passes `ollamaUrl: ollamaUrl()` (nlm.ts local helper); the shared factory reads `process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434"`. Read the nlm.ts `ollamaUrl()` helper: if it is exactly that env-or-default read, no action; if it does more, port the difference into the shared factory so daemon behavior is unchanged. State the finding in your report.

- [ ] **Step 3: Delete nlm.ts:170-202**, add `import { buildClassifier } from "../llm/build-classifier.js";` (adjust to the file's alias style), confirm all nlm.ts call sites still typecheck. Grep nlm.ts for any other duplicated factory remnants (`buildClassifier` should now resolve only to the import).

- [ ] **Step 4: Full gate, commit**

```bash
git add src/cli/nlm.ts src/llm/build-classifier.ts
git commit -m "refactor(llm): delete nlm.ts buildClassifier fork; shared factory is the single source"
```

---

### Task 4: Shared classify retry and parse chain

Both clients duplicate: the retry-on-transient loop (classify, 3 attempts), the parse/validate chain (stripJsonFences, JSON.parse, validateClassifierJson, coerceClassifyResult with ClassifierSchemaError on each failure mode), and the `rewriteTimeoutMs()` env helper.

**Files:**
- Create: `src/llm/client-shared.ts`
- Modify: `src/llm/deepseek-client.ts`, `src/llm/ollama-client.ts`
- Test: `tests/unit/llm/client-shared.test.ts` (new)

**Interfaces:**
- Produces:

```typescript
import type { ClassifyResult } from "@ports/llm-client.js";
import { ClassifierSchemaError, LLMUnreachableError } from "@ports/llm-client.js";
import {
  coerceClassifyResult,
  stripJsonFences,
  validateClassifierJson,
} from "@core/classifier/prompt.js";

export async function classifyWithRetry(
  attempts: number,
  once: () => Promise<ClassifyResult>,
): Promise<ClassifyResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await once();
    } catch (e) {
      if (!(e instanceof ClassifierSchemaError || e instanceof LLMUnreachableError)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export function parseClassifierContent(rawContent: string, providerLabel: string): ClassifyResult {
  const content = stripJsonFences(rawContent.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ClassifierSchemaError(`${providerLabel} returned non-JSON content`);
  }
  if (!validateClassifierJson(parsed)) {
    throw new ClassifierSchemaError(`${providerLabel} response missing required keys`);
  }
  return coerceClassifyResult(parsed);
}

const DEFAULT_REWRITE_TIMEOUT_MS = 5_000;
export function rewriteTimeoutMs(): number {
  const raw = process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  if (!raw) return DEFAULT_REWRITE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REWRITE_TIMEOUT_MS;
}
```

- [ ] **Step 1: Failing unit tests** for parseClassifierContent (fenced JSON accepted, non-JSON throws ClassifierSchemaError with the provider label in the message, missing-keys throws, valid JSON coerces) and classifyWithRetry (returns first success; retries exactly N times on ClassifierSchemaError then throws the last; does NOT retry on a plain Error).

- [ ] **Step 2: RED, create the module, consume in both clients.** Each client's `classify` becomes `classifyWithRetry(this.classifyAttempts, () => this.classifyOnce(...))`; each classifyOnce ends with `return parseClassifierContent(rawContent, "deepseek" | "ollama")` (note: the current code trims BEFORE stripping fences; the shared function trims inside, so delete the local `.trim()` and verify the error message strings stay exactly as today, since tests may pin them). Both local `rewriteTimeoutMs` copies delete in favor of the import.

- [ ] **Step 3: Full gate (both client unit test files named explicitly in your run), commit**

```bash
git add src/llm/client-shared.ts src/llm/deepseek-client.ts src/llm/ollama-client.ts tests/unit/llm/client-shared.test.ts
git commit -m "refactor(llm): shared classify retry, parse chain, and rewrite timeout"
```

---

## Out of scope

The full provider-taxonomy unification (ClassifierProvider vs ProviderKind vs HTTP whitelists in app.ts; the anthropic/openrouter dead-end registry kinds) is deliberately deferred: it touches the HTTP settings surface and the providers registry and deserves its own plan once a real second cloud provider is wanted. This wave is complete when the Task 8 naming-prompt tuning can edit exactly one file (`src/llm/naming.ts`).
