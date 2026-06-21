# Classifier JSON-Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop occasional malformed-JSON classifier output from hard-failing sessions — retry transient schema errors at the client, and tolerate an isolated bad chunk in hierarchical classification so one bad chunk can't sink a multi-chunk session.

**Architecture:** Two layers. (1) `OllamaClient.classify` (and the DeepSeek twin) retry on `ClassifierSchemaError`/`LLMUnreachableError` up to `classifyAttempts` (default 3) — the model frequently emits valid JSON on a re-roll, and this benefits ALL classification including the live daemon. (2) `classifyLarge` wraps each chunk's classify in try/catch: a chunk that still fails after the client's retries is skipped (counted), and the session is built from the surviving chunks; only an all-chunks-fail session throws.

**Tech Stack:** TypeScript (ESM/NodeNext, `@core`/`@ports`/`@shared` aliases, `.js` import suffixes), vitest, the existing `OllamaClient`/`DeepSeekClient` (injectable `fetchImpl`), `ClassifierSchemaError`/`LLMUnreachableError` from `@ports/llm-client.js` (re-exported via ollama-client), `classifyLarge` from Task #340.

## Global Constraints

- **Diagnosis that motivates this (verified 2026-06-21):** failures are `done_reason: "stop"` with *syntactically invalid* JSON (e.g. a stray-quote `..."" }]}`), NOT context truncation (`done_reason: "length"` never observed). A 65K "small" failure re-classified cleanly on a fresh call (transient); a 4.4MB/50-chunk giant failed only on chunk 0 while chunks 1-4 parsed fine. So: retry fixes transient + most bad chunks; per-chunk tolerance saves the giants from one stubborn chunk.
- `classifyAttempts` default **3**. Retry on `ClassifierSchemaError` AND `LLMUnreachableError` (the run also saw one transient "LLM unreachable"). No backoff delay needed (Ollama is local); each attempt gets its own AbortController/timeout.
- Do not change the prompt, the `CLASSIFIER_JSON_SCHEMA`, `num_ctx`, or chunk size — the fix is resilience, not generation tuning.
- `classifyLarge` must still throw when EVERY chunk fails (a genuinely unclassifiable session), but succeed when ≥1 chunk survives. The merge is unchanged otherwise (it already unions/dedupes).
- TDD per task; run `npm run typecheck` (BOTH `tsconfig.json` AND `tsconfig.test.json`) and `npx vitest run` before each commit.
- Public repo, no secrets.

---

### Task 1: Retry on schema error in the classifier clients

**Files:**
- Modify: `src/llm/ollama-client.ts` (`OllamaClientOptions` + `classify` retry loop)
- Modify: `src/llm/deepseek-client.ts` (matching option + retry loop)
- Test: `tests/unit/llm/ollama-client-retry.test.ts` (create)

**Interfaces:**
- Produces: `OllamaClientOptions` and `DeepSeekClientOptions` gain `readonly classifyAttempts?: number;` (default 3). `classify` behavior unchanged on success; on `ClassifierSchemaError`/`LLMUnreachableError` it retries up to `classifyAttempts` total attempts before rethrowing the last error.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/llm/ollama-client-retry.test.ts
import { describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../../../src/llm/ollama-client.js";
import { ClassifierSchemaError } from "../../../src/ports/llm-client.js";

// A valid classifier JSON payload (matches CLASSIFIER_JSON_SCHEMA required keys).
const VALID = JSON.stringify({
  label: "Test", summary: "s", entities: ["a"], decisions: [], open: [], confidence: 0.9,
});
function chatResponse(content: string) {
  return { ok: true, json: async () => ({ message: { content }, done_reason: "stop" }) } as unknown as Response;
}

describe("OllamaClient.classify retry", () => {
  it("retries on non-JSON content and succeeds on a later attempt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse("not json at all"))
      .mockResolvedValueOnce(chatResponse("also { broken"))
      .mockResolvedValueOnce(chatResponse(VALID));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    const out = await client.classify("transcript");
    expect(out.label).toBe("Test");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws ClassifierSchemaError after exhausting attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("never valid json"));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(ClassifierSchemaError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a clean success (one call)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(VALID));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    await client.classify("transcript");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/llm/ollama-client-retry.test.ts`
Expected: FAIL — `classifyAttempts` not honored; current code calls fetch once and throws on the first non-JSON.

- [ ] **Step 3: Add the option + retry loop in `ollama-client.ts`**

Add to `OllamaClientOptions` (near `think`):
```ts
  /** Total classify attempts before giving up on transient schema/unreachable errors. */
  readonly classifyAttempts?: number;
```
Add the private field + default in the constructor (near `this.numCtx`):
```ts
  private readonly classifyAttempts: number;
  // in constructor:
  this.classifyAttempts = opts.classifyAttempts ?? 3;
```
Refactor `classify`: rename the current body to a private `async classifyOnce(transcript, priorContext): Promise<ClassifyResult>` (the existing fetch+parse+validate+coerce, unchanged), and make `classify` the retry wrapper:
```ts
  async classify(transcript: string, priorContext: string = ""): Promise<ClassifyResult> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.classifyAttempts; attempt++) {
      try {
        return await this.classifyOnce(transcript, priorContext);
      } catch (e) {
        if (!(e instanceof ClassifierSchemaError || e instanceof LLMUnreachableError)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }
```
(`ClassifierSchemaError` is defined in this file; `LLMUnreachableError` is already imported. Keep `classifyOnce` private.)

- [ ] **Step 4: Mirror the retry in `deepseek-client.ts`**

Add `readonly classifyAttempts?: number;` to `DeepSeekClientOptions`, the private field + `?? 3` default, rename its current `classify` body to `classifyOnce`, and add the identical retry wrapper (retrying on `ClassifierSchemaError`/`LLMUnreachableError`). If DeepSeek throws differently-named errors, retry on the schema-error type it actually throws (read the file) and note it.

- [ ] **Step 5: Run the test + typecheck + full suite**

Run: `npx vitest run tests/unit/llm/ollama-client-retry.test.ts && npm run typecheck && npx vitest run`
Expected: retry tests PASS; typecheck clean (both configs); full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/llm/ollama-client.ts src/llm/deepseek-client.ts tests/unit/llm/ollama-client-retry.test.ts
git commit -m "feat(classifier): retry transient schema/unreachable errors (classifyAttempts, default 3)"
```

---

### Task 2: Per-chunk fault tolerance in `classifyLarge`

**Files:**
- Modify: `src/core/classifier/hierarchical-classify.ts` (`classifyLarge`)
- Modify: `tests/unit/classifier/hierarchical-classify.test.ts` (add tolerance cases)

**Interfaces:**
- Consumes: `LLMClient.classify` (now self-retrying after Task 1).
- Produces: `classifyLarge` unchanged signature; new behavior — a chunk whose `classify` rejects is skipped; the result is merged from surviving chunks; throws only when ALL chunks fail.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/classifier/hierarchical-classify.test.ts`:
```ts
  it("skips a chunk that fails and merges the survivors", async () => {
    // 2 chunks at 40K/1K from a 60K body. First classify throws, second succeeds.
    let call = 0;
    const clf = {
      classify: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("ollama returned non-JSON content");
        return { label: "B", summary: "sb", entities: ["Hono"], decisions: ["d2"], open: [], confidence: 0.8, facts: [] };
      }),
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    const out = await classifyLarge("x".repeat(60_000), clf);
    expect((clf.classify as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(out.entities).toEqual(["Hono"]);    // only the surviving chunk's content
    expect(out.decisions).toEqual(["d2"]);
    expect(out.label).toBe("B");
  });

  it("throws when every chunk fails", async () => {
    const clf = {
      classify: vi.fn(async () => { throw new Error("ollama returned non-JSON content"); }),
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    await expect(classifyLarge("y".repeat(60_000), clf)).rejects.toThrow();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/classifier/hierarchical-classify.test.ts`
Expected: FAIL — the first new test currently rejects (chunk-0 throw propagates out of `classifyLarge`).

- [ ] **Step 3: Add per-chunk tolerance in `classifyLarge`**

Replace the chunk loop (the `for (const chunk of chunks) results.push(await classifier.classify(chunk));`) with a tolerant version:
```ts
  const results: ClassifyResult[] = [];
  let failedChunks = 0;
  for (const chunk of chunks) {
    try {
      results.push(await classifier.classify(chunk));
    } catch {
      failedChunks++;
    }
  }
  if (results.length === 0) {
    throw new Error(`classifyLarge: all ${chunks.length} chunks failed classification`);
  }
```
The existing reduce (first-non-empty label, independent first-non-empty summary, union+dedupe entities/decisions/open, concat facts, min confidence) then runs over `results` unchanged. `failedChunks` is local — do not add it to the return type (the `ClassifyResult` shape is fixed).

- [ ] **Step 4: Run the tests + typecheck + full suite**

Run: `npx vitest run tests/unit/classifier/hierarchical-classify.test.ts && npm run typecheck && npx vitest run`
Expected: tolerance tests PASS; the prior classifyLarge tests still PASS; typecheck clean; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/core/classifier/hierarchical-classify.ts tests/unit/classifier/hierarchical-classify.test.ts
git commit -m "feat(classifier): tolerate isolated bad chunks in classifyLarge (skip + merge survivors)"
```

---

## Manual verification (post-merge)

After merge + daemon rebuild (`npm run build && nlm restart`):
1. `node dist/cli/nlm.js reclassify-oversized` — re-run on the residual ~11 never-ingested sessions. Expect most/all to ingest now (transient small ones recovered by retry; giants by per-chunk tolerance).
2. Verify the residual: `sqlite3 ~/.nlm/canonical.sqlite "SELECT COUNT(*) FROM adapter_state WHERE session_id IS NULL AND failure_count>=1;"` — should drop toward 0.

## Self-review notes (coverage vs goal)

- Transient non-JSON (the 65K "small" failures) → Task 1 client retry.
- One-bad-chunk-sinks-a-giant (the 4.4MB/50-chunk case, chunk 0 malformed) → Task 2 per-chunk tolerance.
- Live-daemon robustness (fewer sessions hitting the failure ceiling going forward) → Task 1 (retry is in the client, not just the recovery path).
- Out of scope (intentional): JSON-repair of malformed output (fragile; retry + skip already cover it) and any prompt/num_ctx/chunk-size change (diagnosis showed generation isn't truncating).
