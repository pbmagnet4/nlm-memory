# Scheduler Oversized-Session Wiring Implementation Plan (#341)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live ingest scheduler classify oversized session bodies via the hierarchical `classifyAdaptive` path (so future large sessions auto-chunk on first ingest instead of getting head-only extraction or failing), by moving the classify timeout from a session-wide budget to a per-chunk one.

**Architecture:** The scheduler currently wraps `classifier.classify(chunk.text)` in `withTimeout(..., classifyTimeoutMs)` — a session-wide budget a multi-chunk classify would blow. Extract `withTimeout`/`TimeoutError` (today private in `scheduler.ts`) into a shared util; give `classifyAdaptive`/`classifyLarge` an optional `perCallTimeoutMs` that bounds EACH chunk's classify (a timed-out chunk is tolerated by the per-chunk try/catch added in the JSON-resilience work); then the scheduler calls `classifyAdaptive(chunk.text, classifier, { perCallTimeoutMs })` and drops its outer `withTimeout`.

**Tech Stack:** TypeScript (ESM/NodeNext, `@core`/`@ports`/`@shared` aliases, `.js` import suffixes), vitest, the `ScanScheduler` (`src/core/scheduler/scheduler.ts`), `classifyAdaptive`/`classifyLarge` (`src/core/classifier/hierarchical-classify.ts`), `LLMClient`.

## Global Constraints

- **Per-chunk timeout, not session-wide.** `perCallTimeoutMs` bounds each individual `classify` call. A giant of N chunks may take up to N×budget total — that is intended (completeness over scan latency; giants are rare). The scheduler's source value is its existing `classifyTimeoutMs` (default `DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000`).
- **Backward-compatible.** `classifyAdaptive(text, classifier)` and `classifyLarge(text, classifier)` called WITHOUT `perCallTimeoutMs` must behave exactly as today (no timeout wrapping) — `reclassifyOversized` (the recovery command) calls them without a timeout and must be unaffected.
- **Single-pass timeout still surfaces to the scheduler.** For a body ≤ `SINGLE_PASS_CHAR_BUDGET` (40_000), a timeout must propagate out of `classifyAdaptive` as `TimeoutError` so the scheduler's existing catch records the failure and its `e instanceof TimeoutError` "timed out" reason/ceiling logic still works. (Only inside `classifyLarge` is a per-chunk timeout swallowed/tolerated.)
- **Do not change** the reduce, per-chunk tolerance, client retry, chunk size, prompt, schema, or `num_ctx`.
- **The extraction is a pure refactor:** `withTimeout`/`TimeoutError` move to the shared util with identical behavior; the full suite proves the scheduler is unchanged by the move.
- TDD per task; `npm run typecheck` (BOTH `tsconfig.json` AND `tsconfig.test.json`) + `npx vitest run` before each commit. Public repo, no secrets.

---

### Task 1: Shared `withTimeout` util + per-chunk timeout in `classifyAdaptive`/`classifyLarge`

**Files:**
- Create: `src/core/util/with-timeout.ts`
- Modify: `src/core/scheduler/scheduler.ts` (remove the local `withTimeout`/`TimeoutError`, import from the util — behavior identical)
- Modify: `src/core/classifier/hierarchical-classify.ts` (`classifyAdaptive`/`classifyLarge` gain `opts.perCallTimeoutMs`)
- Test: `tests/unit/util/with-timeout.test.ts` (create), and add cases to `tests/unit/classifier/hierarchical-classify.test.ts`

**Interfaces:**
- Produces: `export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>` and `export class TimeoutError extends Error {}` in `@core/util/with-timeout.js`.
- `classifyAdaptive(text, classifier, opts?: { perCallTimeoutMs?: number })` and `classifyLarge(text, classifier, opts?: { perCallTimeoutMs?: number })` — when `perCallTimeoutMs` is set, each `classify` call is wrapped in `withTimeout`.

- [ ] **Step 1: Write the failing util test**

```ts
// tests/unit/util/with-timeout.test.ts
import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "../../../src/core/util/with-timeout.js";

describe("withTimeout", () => {
  it("resolves a fast promise", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
  it("rejects with TimeoutError when the promise is too slow", async () => {
    const slow = new Promise((r) => setTimeout(() => r("late"), 1000));
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/util/with-timeout.test.ts`
Expected: FAIL — module `@core/util/with-timeout.js` does not exist.

- [ ] **Step 3: Create the util by moving the code from `scheduler.ts`**

`src/core/util/with-timeout.ts` (copy the existing private definitions verbatim, add `export`):
```ts
/** Reject a promise if it does not settle within `ms`. Shared by the scheduler
 *  (per-session classify) and the hierarchical classifier (per-chunk classify). */
export class TimeoutError extends Error {}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Update `scheduler.ts` to import from the util (remove the local defs)**

In `src/core/scheduler/scheduler.ts`: delete the local `class TimeoutError extends Error {}` and the local `async function withTimeout<T>(...)` (near the bottom), and add to the imports:
```ts
import { TimeoutError, withTimeout } from "@core/util/with-timeout.js";
```
Nothing else in `scheduler.ts` changes in this task — the `withTimeout(...)` call site and the `e instanceof TimeoutError` check now reference the imported symbols. (The behavioral swap to `classifyAdaptive` is Task 2.)

- [ ] **Step 5: Add `perCallTimeoutMs` to `classifyAdaptive`/`classifyLarge`**

In `src/core/classifier/hierarchical-classify.ts`, import the util:
```ts
import { withTimeout } from "@core/util/with-timeout.js";
```
Add an options type and thread it through:
```ts
export interface ClassifyAdaptiveOptions {
  /** When set, each individual chunk classify is bounded by this many ms. */
  readonly perCallTimeoutMs?: number;
}
```
In `classifyLarge`, wrap each chunk's classify (keep the existing try/catch tolerance — a timeout is just another tolerated failure):
```ts
export async function classifyLarge(
  text: string,
  classifier: LLMClient,
  opts: ClassifyAdaptiveOptions = {},
): Promise<ClassifyResult> {
  const chunks = chunkSessionText({ body: text }, { maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP });
  if (chunks.length === 0) {
    return { label: "", summary: "", entities: [], decisions: [], open: [], confidence: 0, facts: [] };
  }
  const results: ClassifyResult[] = [];
  for (const chunk of chunks) {
    try {
      const p = classifier.classify(chunk);
      results.push(opts.perCallTimeoutMs ? await withTimeout(p, opts.perCallTimeoutMs) : await p);
    } catch {
      // Tolerate a chunk that fails (incl. per-chunk timeout): skip it and
      // classify from survivors. If every chunk fails, the guard below throws.
    }
  }
  if (results.length === 0) {
    throw new Error(`classifyLarge: all ${chunks.length} chunks failed classification`);
  }
  // ... existing reduce unchanged ...
}
```
In `classifyAdaptive`, thread opts and bound the single-pass call too (its timeout must PROPAGATE, not be swallowed):
```ts
export async function classifyAdaptive(
  text: string,
  classifier: LLMClient,
  opts: ClassifyAdaptiveOptions = {},
): Promise<ClassifyResult> {
  if (text.length <= SINGLE_PASS_CHAR_BUDGET) {
    const p = classifier.classify(text);
    return opts.perCallTimeoutMs ? withTimeout(p, opts.perCallTimeoutMs) : p;
  }
  return classifyLarge(text, classifier, opts);
}
```
(Keep the existing reduce body in `classifyLarge` exactly as-is — only the chunk loop and signature change.)

- [ ] **Step 6: Add the classifier timeout tests**

Add to `tests/unit/classifier/hierarchical-classify.test.ts`:
```ts
  it("tolerates a chunk that times out and merges the survivors", async () => {
    let call = 0;
    const clf = {
      classify: vi.fn(async (t: string) => {
        call++;
        if (call === 1) return await new Promise<never>(() => {}); // hangs forever → times out
        return { label: "B", summary: "s", entities: ["Hono"], decisions: [], open: [], confidence: 0.9, facts: [] };
      }),
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    const out = await classifyLarge("x".repeat(60_000), clf, { perCallTimeoutMs: 30 });
    expect(out.entities).toEqual(["Hono"]); // survivor only; the hung chunk was skipped
  });

  it("classifyAdaptive single-pass rejects when the single call times out", async () => {
    const clf = {
      classify: vi.fn(() => new Promise<never>(() => {})), // hangs
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    await expect(classifyAdaptive("short body", clf, { perCallTimeoutMs: 30 })).rejects.toBeInstanceOf(
      (await import("../../../src/core/util/with-timeout.js")).TimeoutError,
    );
  });
```

- [ ] **Step 7: Run tests + typecheck + full suite**

Run: `npx vitest run tests/unit/util/with-timeout.test.ts tests/unit/classifier/hierarchical-classify.test.ts && npm run typecheck && npx vitest run`
Expected: new tests PASS; prior classifyLarge/classifyAdaptive tests still PASS; the scheduler suite still PASS (proves the util extraction changed nothing); typecheck clean both configs.

- [ ] **Step 8: Commit**

```bash
git add src/core/util/with-timeout.ts src/core/scheduler/scheduler.ts src/core/classifier/hierarchical-classify.ts tests/unit/util/with-timeout.test.ts tests/unit/classifier/hierarchical-classify.test.ts
git commit -m "feat(classifier): per-chunk classify timeout option + shared withTimeout util"
```

---

### Task 2: Scheduler uses `classifyAdaptive` (auto-chunk oversized sessions)

**Files:**
- Modify: `src/core/scheduler/scheduler.ts` (the classify call site)
- Test: an oversized-ingest case in the existing scheduler test file (find it: `tests/**/scheduler*.test.ts`)

**Interfaces:**
- Consumes: `classifyAdaptive(text, classifier, { perCallTimeoutMs })` (Task 1).

- [ ] **Step 1: Read the existing scheduler test(s)**

Locate `tests/**/scheduler*.test.ts`. Learn how a `ScanScheduler` is constructed in tests (the fake/real adapter that yields a `SessionChunk`, the fake classifier, the in-memory store, and how `runOnce`/`tick` is invoked and asserted). The new test mirrors that setup.

- [ ] **Step 2: Write the failing oversized-ingest test**

Add a test that drives the scheduler with an adapter yielding a chunk whose `text` is oversized (`> 40_000` chars, e.g. `"x".repeat(90_000)`) and a fake classifier that returns a valid `ClassifyResult` per call. Assert the session is ingested (a `sessions` row exists with the expected label/entities) — i.e. the scheduler classified the oversized body successfully (which only works if it routes through `classifyAdaptive`/`classifyLarge`, since a real single 90K pass would be one call but the test's point is that the scheduler no longer imposes a session-wide timeout and uses the adaptive path). Mirror the existing scheduler test's construction and assertion style; reuse its fakes. Also keep/observe an existing normal-size case to confirm small sessions still ingest.

- [ ] **Step 3: Run to verify the new test's intent**

Run: `npx vitest run tests/<the scheduler test file>.ts`
Expected: with the unchanged scheduler still calling `classifier.classify` directly this passes trivially for a single-call fake; the REAL verification is Step 5 (the swap) keeping it green while enabling chunking. If you can express the test so it fails before the swap (e.g. by asserting the classifier was invoked per-chunk for an oversized body via a call-count > 1 with a spy), prefer that — it makes the swap test-meaningful.

- [ ] **Step 4: Swap the classify call in `scheduler.ts`**

Replace (around the current `withTimeout(this.opts.classifier.classify(chunk.text), this.opts.classifyTimeoutMs)`):
```ts
        let classification;
        try {
          classification = await classifyAdaptive(chunk.text, this.opts.classifier, {
            perCallTimeoutMs: this.opts.classifyTimeoutMs,
          });
        } catch (e) {
          // ... existing catch body unchanged (records failure; e instanceof TimeoutError still
          //     fires for a single-pass timeout that propagates out of classifyAdaptive) ...
        }
```
Add the import:
```ts
import { classifyAdaptive } from "@core/classifier/hierarchical-classify.js";
```
Leave the catch block, the confidence-floor check, and everything downstream unchanged. (`TimeoutError` is already imported from the util after Task 1.)

- [ ] **Step 5: Run the scheduler test + typecheck + full suite**

Run: `npx vitest run tests/<the scheduler test file>.ts && npm run typecheck && npx vitest run`
Expected: oversized-ingest test PASS; normal-size ingest still PASS; full suite green; typecheck clean both configs.

- [ ] **Step 6: Commit**

```bash
git add src/core/scheduler/scheduler.ts tests/<the scheduler test file>.ts
git commit -m "feat(scheduler): classify via classifyAdaptive so oversized sessions auto-chunk on ingest"
```

---

## Manual verification (post-merge)

After merge + daemon rebuild (`npm run build && nlm restart`): a newly-captured large session (> ~40K-char body) should now ingest with full-coverage extraction on the daemon's normal scan, with no entry accumulating in `adapter_state` at `session_id IS NULL`. Spot-check `nlm` recall for a recent large session's later-in-transcript entities.

## Self-review notes (coverage vs goal)

- Per-chunk timeout replaces session-wide → Task 1 (`perCallTimeoutMs`, shared `withTimeout`).
- Scheduler auto-chunks oversized on ingest → Task 2 (`classifyAdaptive` swap).
- Backward-compat for `reclassifyOversized` (no timeout arg) → Task 1 (option defaulted off).
- Single-pass timeout still records a scheduler failure → Task 1 (propagates `TimeoutError`) + Task 2 (catch unchanged).
- Out of scope: capping chunk count per giant session (a giant can make one scan tick long; acceptable, giants rare) — revisit only if scan latency becomes a problem.
