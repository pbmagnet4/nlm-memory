# Code-exemplar producer — Phase 2 (passive recall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface the most relevant captured code exemplars *passively* — as a lean pointer in the recall block the UserPromptSubmit hook already injects — so an agent knows about prior beneficial coding choices without explicitly asking, with the full code pulled on demand via `recall_code`.

**Architecture:** Mirror the existing "related facts" injection. A new `pickRelatedExemplars(query, store, codeEmbedder, installScope)` embeds the query in CodeRankEmbed space and returns the top-k nearest exemplars as lean pointers. `RecallService.search()` attaches them to `RecallResult.relatedExemplars` (flag-gated, best-effort, wrapped in a short timeout so a slow/cold embed can never blow the hook's latency budget). They flow through the existing `/api/recall` → `recall-over-http` → `formatPointerBlock` channel, rendering one line per exemplar (task-context + outcome + repo + a `recall_code` hint — never the code body).

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, `CodeExemplarStore.searchByVector`, `OllamaCodeEmbedder` (CodeRankEmbed, `"query"` role), the existing recall/pointer-block/hook plumbing.

## Global Constraints

- Gated by `process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1"` (off by default) — when off, recall behaves exactly as today.
- **Best-effort + bounded:** exemplar recall must never throw out of `search()` and must never slow the hook unboundedly. The injection is wrapped in a timeout (`EXEMPLAR_RECALL_TIMEOUT_MS = 800`); on timeout or any error, exemplars are silently omitted and recall proceeds normally.
- **Lean injection, precision over recall:** at most `k = 2` exemplars, each one line (no code body). Only exemplars within a max distance are surfaced (`NLM_EXEMPLAR_RECALL_MAX_DISTANCE`, default `1.0` — CodeRankEmbed vectors are L2-normalised so distance ∈ [0,2]; **this default is a conservative starting point and needs calibration from real data**, tracked separately). Better to surface nothing than noise.
- Query is embedded with `role: "query"` (CodeRankEmbed query prefix); exemplars were embedded at ingest with `role: "document"`.
- ESM/NodeNext: `.js` import extensions; `@core/@ports/@shared` aliases.
- Public repo: no home paths/secrets in code or commits.
- TDD per task: failing test → run (fail) → implement → run (pass) → `npx tsc -p tsconfig.json --noEmit` → commit. Run `npx vitest run` before the final commit of each task.

---

### Task 1: `pickRelatedExemplars` + the shared types

**Files:**
- Modify: `src/shared/types.ts` (add `RelatedExemplar`; add `relatedExemplars?` to `RecallResult`; add `withRelatedExemplars?` to `RecallQuery`)
- Create: `src/core/recall/related-exemplars.ts`
- Test: `tests/unit/core/recall/related-exemplars.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // in shared/types.ts
  export interface RelatedExemplar {
    readonly id: string;
    readonly outcome: CodeExemplarOutcome;
    readonly lang: string | null;
    readonly repo: string;
    readonly taskContext: string;
    readonly distance: number;
  }
  // RecallResult gains: readonly relatedExemplars?: ReadonlyArray<RelatedExemplar>;
  // RecallQuery gains:  readonly withRelatedExemplars?: boolean;

  // in related-exemplars.ts
  export function pickRelatedExemplars(
    query: string,
    store: CodeExemplarStore,
    codeEmbedder: CodeEmbedder,
    installScope: string,
    opts?: { k?: number; maxDistance?: number },
  ): Promise<RelatedExemplar[]>;
  ```
- Consumes: `CodeExemplarStore.searchByVector` (`@ports/code-exemplar-store.js`), `CodeEmbedder.embed(text, "query")` (`@ports/code-embedder.js`), `CodeExemplarHit` / `CodeExemplarOutcome` (`@shared/types.js`).

- [ ] **Step 1: Add the types to `src/shared/types.ts`**

Add near the existing `CodeExemplarHit` (it already imports `CodeExemplarOutcome` in that file):
```ts
export interface RelatedExemplar {
  readonly id: string;
  readonly outcome: CodeExemplarOutcome;
  readonly lang: string | null;
  readonly repo: string;
  readonly taskContext: string;
  readonly distance: number;
}
```
In `RecallResult`, add after `relatedFacts`:
```ts
  readonly relatedExemplars?: ReadonlyArray<RelatedExemplar>;
```
In `RecallQuery`, add after `withRelatedFacts`:
```ts
  readonly withRelatedExemplars?: boolean;
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/core/recall/related-exemplars.test.ts
import { describe, expect, it } from "vitest";
import { pickRelatedExemplars } from "../../../../src/core/recall/related-exemplars.js";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../../../src/ports/code-embedder.js";
import type { CodeExemplarHit } from "../../../../src/shared/types.js";

function hit(over: Partial<CodeExemplarHit> & { id: string; distance: number }): CodeExemplarHit {
  return {
    code: "code", taskContext: "ctx", outcome: "pass", repo: "/r", model: "m",
    lang: "ts", survived: null, gitSha: null, ...over,
  };
}
function storeReturning(hits: CodeExemplarHit[]): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return hits; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
  };
}
const embedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };
const throwingEmbedder: CodeEmbedder = { async embed() { throw new Error("ollama down"); } };

describe("pickRelatedExemplars", () => {
  it("embeds the query and maps hits to lean RelatedExemplars", async () => {
    const store = storeReturning([
      hit({ id: "a", distance: 0.2, taskContext: "throttle helper", outcome: "pass", lang: "ts", repo: "/r" }),
    ]);
    const out = await pickRelatedExemplars("debounce a handler", store, embedder, "scope");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "a", outcome: "pass", lang: "ts", repo: "/r", taskContext: "throttle helper", distance: 0.2 });
  });

  it("drops hits beyond maxDistance", async () => {
    const store = storeReturning([
      hit({ id: "near", distance: 0.3 }),
      hit({ id: "far", distance: 1.5 }),
    ]);
    const out = await pickRelatedExemplars("q", store, embedder, "scope", { maxDistance: 1.0 });
    expect(out.map((e) => e.id)).toEqual(["near"]);
  });

  it("returns [] (best-effort) when the embedder throws", async () => {
    const store = storeReturning([hit({ id: "a", distance: 0.1 })]);
    const out = await pickRelatedExemplars("q", store, throwingEmbedder, "scope");
    expect(out).toEqual([]);
  });

  it("caps at k and requests k from the store", async () => {
    let askedK: number | undefined;
    const store: CodeExemplarStore = {
      ...storeReturning([hit({ id: "a", distance: 0.1 }), hit({ id: "b", distance: 0.2 })]),
      async searchByVector(_v, filter) { askedK = filter.k; return [hit({ id: "a", distance: 0.1 }), hit({ id: "b", distance: 0.2 })]; },
    };
    const out = await pickRelatedExemplars("q", store, embedder, "scope", { k: 1 });
    expect(askedK).toBe(1);
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/recall/related-exemplars.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/core/recall/related-exemplars.ts
/**
 * Passive code-exemplar recall: embed the user's task in CodeRankEmbed space
 * and return the nearest captured exemplars as lean pointers for the recall
 * block. Best-effort — any failure yields []. Precision-biased: only matches
 * within maxDistance are returned, capped at k, so the injected block stays
 * relevant and small (the full code is pulled on demand via recall_code).
 */
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { RelatedExemplar } from "@shared/types.js";

const DEFAULT_K = 2;
const DEFAULT_MAX_DISTANCE = Number(process.env["NLM_EXEMPLAR_RECALL_MAX_DISTANCE"] ?? "1.0");

export async function pickRelatedExemplars(
  query: string,
  store: CodeExemplarStore,
  codeEmbedder: CodeEmbedder,
  installScope: string,
  opts: { k?: number; maxDistance?: number } = {},
): Promise<RelatedExemplar[]> {
  const k = opts.k ?? DEFAULT_K;
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  try {
    const { vector } = await codeEmbedder.embed(query, "query");
    const hits = await store.searchByVector(vector, { installScope, k });
    return hits
      .filter((h) => h.distance <= maxDistance)
      .map((h) => ({
        id: h.id,
        outcome: h.outcome,
        lang: h.lang,
        repo: h.repo,
        taskContext: h.taskContext,
        distance: h.distance,
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/unit/core/recall/related-exemplars.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (4 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/core/recall/related-exemplars.ts tests/unit/core/recall/related-exemplars.test.ts
git commit -m "feat(recall): pickRelatedExemplars — passive code-exemplar lookup over CodeRankEmbed"
```

---

### Task 2: Inject into `RecallService.search()` + wire deps

**Files:**
- Modify: `src/core/recall/recall-service.ts` (deps + the timeout-wrapped injection step)
- Modify: `src/cli/nlm.ts` (pass `exemplarStore` + `codeEmbedder` + `installScope` to `new RecallService(...)`)
- Test: `tests/unit/core/recall/recall-exemplar-injection.test.ts`

**Interfaces:**
- Consumes: `pickRelatedExemplars` (Task 1).
- `RecallServiceDeps` gains: `readonly exemplarStore?: CodeExemplarStore; readonly codeEmbedder?: CodeEmbedder; readonly installScope?: string;`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/recall/recall-exemplar-injection.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../../../src/core/recall/recall-service.js";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../../../src/ports/code-embedder.js";
import type { CodeExemplarHit } from "../../../../src/shared/types.js";

const fakeStoreHit: CodeExemplarHit = {
  id: "ex1", code: "c", taskContext: "throttle util", outcome: "pass",
  repo: "/r", model: "m", lang: "ts", survived: null, gitSha: null, distance: 0.2,
};
function exemplarStore(): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return [fakeStoreHit]; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
  };
}
const codeEmbedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };

// Minimal store + llm so keyword recall returns an empty-but-valid result.
const store = {
  keywordSearch: async () => [],
  semanticSearch: async () => [],
  resolveSuccessors: async () => new Map(),
} as never;
const llm = { embed: async () => ({ vector: new Float32Array(768), model: "m" }) } as never;

describe("RecallService passive exemplar injection", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("attaches relatedExemplars when flag on + opted in", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle scroll handler", mode: "keyword", withRelatedExemplars: true });
    expect(res.relatedExemplars).toBeDefined();
    expect(res.relatedExemplars!.map((e) => e.id)).toEqual(["ex1"]);
  });

  it("omits relatedExemplars when the flag is off", async () => {
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle", mode: "keyword", withRelatedExemplars: true });
    expect(res.relatedExemplars).toBeUndefined();
  });

  it("omits relatedExemplars when not opted in", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle", mode: "keyword" });
    expect(res.relatedExemplars).toBeUndefined();
  });
});
```

> Implementer note: the `store`/`llm` fakes above are minimal. Open `src/core/recall/recall-service.ts` and `tests/` for an existing RecallService unit test, and reuse its established fake shapes for `SessionStore`/`LLMClient` if these minimal casts don't satisfy the keyword path. The behavior under test is only the exemplar-injection block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/recall/recall-exemplar-injection.test.ts`
Expected: FAIL — `relatedExemplars` never set.

- [ ] **Step 3: Add deps + the injection in `recall-service.ts`**

Add to `RecallServiceDeps` (after `factStore`):
```ts
  /** Passive code-exemplar recall: when all three are present + the flag is
   *  on, search() attaches relatedExemplars for callers that opt in. */
  readonly exemplarStore?: CodeExemplarStore;
  readonly codeEmbedder?: CodeEmbedder;
  readonly installScope?: string;
```
Add imports at the top of the file:
```ts
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import { pickRelatedExemplars } from "./related-exemplars.js";
```
Add a module-level constant near the other consts:
```ts
const EXEMPLAR_RECALL_TIMEOUT_MS = 800;
```
Immediately AFTER the related-facts block (the `if (input.withRelatedFacts === true ...) { ... }` ending at line ~225), add:
```ts
    // 6b. Passive code-exemplar recall. Flag-gated, opt-in, and wrapped in a
    //     timeout so a slow/cold CodeRankEmbed call can never blow the hook's
    //     latency budget — on timeout or error we simply omit exemplars.
    if (
      input.withRelatedExemplars === true &&
      this.deps.exemplarStore &&
      this.deps.codeEmbedder &&
      this.deps.installScope &&
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1" &&
      (semanticQuery || input.query)
    ) {
      const store = this.deps.exemplarStore;
      const embedder = this.deps.codeEmbedder;
      const scope = this.deps.installScope;
      const q = semanticQuery || input.query;
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("exemplar recall timeout")), EXEMPLAR_RECALL_TIMEOUT_MS),
      );
      try {
        const related = await Promise.race([pickRelatedExemplars(q, store, embedder, scope), timeout]);
        if (related.length > 0) result = { ...result, relatedExemplars: related };
      } catch {
        // timed out or failed — proceed without exemplars
      }
    }
```

- [ ] **Step 4: Wire deps in `nlm.ts`**

In `buildStack()`, update the `new RecallService({ ... })` call (the `start`/buildStack area where `scope`, `storage`, `ollamaUrl`, and `OllamaCodeEmbedder` are already in scope):
```ts
  const recall = new RecallService({
    store,
    llm: embedder,
    factStore: facts,
    exemplarStore: storage.exemplars,
    codeEmbedder: new OllamaCodeEmbedder({ baseUrl: ollamaUrl() }),
    installScope: scope,
  });
```

- [ ] **Step 5: Run test + typecheck + full suite**

Run: `npx vitest run tests/unit/core/recall/recall-exemplar-injection.test.ts && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: new test PASS; typecheck clean; full suite green (existing RecallService tests unaffected — exemplar injection only runs when opted in + flag on).

- [ ] **Step 6: Commit**

```bash
git add src/core/recall/recall-service.ts src/cli/nlm.ts tests/unit/core/recall/recall-exemplar-injection.test.ts
git commit -m "feat(recall): inject passive code exemplars into search(), timeout-guarded"
```

---

### Task 3: Render the exemplar section in the pointer block

**Files:**
- Modify: `src/core/hook/pointer-block.ts`
- Test: `tests/unit/core/hook/pointer-block.test.ts` (the file already exists — append the new `describe` block)

**Interfaces:**
- `formatPointerBlock(hits, facts, exemplars)` — third param `ReadonlyArray<PointerExemplar> = []`.
- Produces:
  ```ts
  export interface PointerExemplar {
    readonly outcome: string;
    readonly lang: string | null;
    readonly repo: string;
    readonly taskContext: string;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/hook/pointer-block.test.ts  (add to existing file, or create)
import { describe, expect, it } from "vitest";
import { formatPointerBlock } from "../../../../src/core/hook/pointer-block.js";

describe("formatPointerBlock — code exemplars section", () => {
  it("renders a Related code exemplars section after facts", () => {
    const out = formatPointerBlock(
      [],
      [],
      [{ outcome: "pass", lang: "ts", repo: "/repo/app", taskContext: "throttle the scroll handler" }],
    );
    expect(out).toContain("## Related code exemplars (nlm-memory)");
    expect(out).toContain("throttle the scroll handler");
    expect(out).toContain("pass");
    // footer teaches recall_code when exemplars are present
    expect(out).toContain("recall_code");
  });

  it("omits the section when there are no exemplars", () => {
    const out = formatPointerBlock([{ id: "s1", label: "L", startedAt: "2026-06-19T00:00:00Z" }], [], []);
    expect(out).not.toContain("Related code exemplars");
  });

  it("returns empty string when hits, facts, and exemplars are all empty", () => {
    expect(formatPointerBlock([], [], [])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/hook/pointer-block.test.ts`
Expected: FAIL — `formatPointerBlock` takes 2 args; no exemplar section.

- [ ] **Step 3: Implement**

In `src/core/hook/pointer-block.ts`, add the interface after `PointerFact`:
```ts
export interface PointerExemplar {
  readonly outcome: string;
  readonly lang: string | null;
  readonly repo: string;
  readonly taskContext: string;
}
```
Change the signature and the empty-guard, add the section, and teach `recall_code` in the footer when exemplars are present:
```ts
export function formatPointerBlock(
  hits: ReadonlyArray<PointerHit>,
  facts: ReadonlyArray<PointerFact> = [],
  exemplars: ReadonlyArray<PointerExemplar> = [],
): string {
  if (hits.length === 0 && facts.length === 0 && exemplars.length === 0) return "";
  const out: string[] = [];
  if (hits.length > 0) {
    out.push("## Possibly-relevant prior sessions (nlm-memory)");
    for (const h of hits) {
      const datePart = h.startedAt.slice(0, 10);
      if (h.summary) {
        out.push(`- ${h.id} · ${h.label} (${datePart}) — ${h.summary.slice(0, 120)}`);
      } else {
        out.push(`- ${h.id} · ${h.label} (${datePart})`);
      }
    }
  }
  if (facts.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Known facts about top entities");
    for (const f of facts) {
      const tag = f.corroborationCount > 1 ? ` [${f.corroborationCount} sessions]` : "";
      out.push(`- ${f.subject} ${f.predicate}: ${f.value}${tag}`);
    }
  }
  if (exemplars.length > 0) {
    if (out.length > 0) out.push("");
    out.push("## Related code exemplars (nlm-memory)");
    for (const e of exemplars) {
      const langPart = e.lang ? `${e.lang} · ` : "";
      out.push(`- [${e.outcome}] ${langPart}${e.repo} — ${e.taskContext.slice(0, 120)}`);
    }
  }
  const tools = exemplars.length > 0
    ? "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved), recall_code (pull the full code for a related exemplar)."
    : "NLM tools: recall_sessions (search), get_session (full transcript), recall_facts (prior decisions), get_fact_history (how a decision evolved).";
  out.push(tools);
  return out.join("\n");
}
```

- [ ] **Step 4: Run test + typecheck + full suite**

Run: `npx vitest run tests/unit/core/hook/pointer-block.test.ts && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS; typecheck clean; full suite green (existing 2-arg callers still compile — the third param defaults).

- [ ] **Step 5: Commit**

```bash
git add src/core/hook/pointer-block.ts tests/unit/core/hook/pointer-block.test.ts
git commit -m "feat(hook): render Related code exemplars section in the pointer block"
```

---

### Task 4: Plumb exemplars through the HTTP channel + both hook paths

Make the captured exemplars actually reach the rendered block: the `/api/recall` route must accept the opt-in and return `relatedExemplars` (it already returns the full `RecallResult` as JSON, so the field flows automatically once set); the over-HTTP client must extract them; the in-process hook handler must opt in and pass them to `formatPointerBlock`.

**Files:**
- Modify: `src/http/app.ts` (the `/api/recall` route: map a `withExemplars` query param → `withRelatedExemplars`; the in-process UserPromptSubmit hook handler: opt in + pass exemplars + update the empty-check)
- Modify: `src/hook/recall-over-http.ts` (request `&withExemplars=true`; parse `relatedExemplars`; return them; pass to `formatPointerBlock` at the call site that consumes `RecallOverHttpResult`)
- Test: `tests/unit/http/recall-exemplars-route.test.ts`

**Interfaces:**
- Consumes: `RecallResult.relatedExemplars` (Task 1), `formatPointerBlock(hits, facts, exemplars)` (Task 3).
- `RecallOverHttpResult` gains `readonly exemplars: ReadonlyArray<PointerExemplar>;`

- [ ] **Step 1: Write the failing test (route returns relatedExemplars when asked)**

```ts
// tests/unit/http/recall-exemplars-route.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { RecallResult } from "../../../src/shared/types.js";

function appWithRecall(captured: { query: unknown }) {
  const recall = {
    search: async (q: { withRelatedExemplars?: boolean }) => {
      captured.query = q;
      const r: RecallResult = {
        query: "", entity: null, kind: null, mode: "keyword", limit: 5, total: 0, results: [],
        relatedExemplars: q.withRelatedExemplars
          ? [{ id: "ex1", outcome: "pass", lang: "ts", repo: "/r", taskContext: "throttle", distance: 0.2 }]
          : undefined,
      };
      return r;
    },
  };
  return createApp({ recall, store: {} } as never);
}

describe("GET /api/recall — withExemplars", () => {
  it("passes withRelatedExemplars and returns relatedExemplars when requested", async () => {
    const captured = { query: undefined as unknown };
    const app = appWithRecall(captured);
    const res = await app.request("/api/recall?q=throttle&mode=keyword&withExemplars=true", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    const body = await res.json() as RecallResult;
    expect((captured.query as { withRelatedExemplars?: boolean }).withRelatedExemplars).toBe(true);
    expect(body.relatedExemplars?.map((e) => e.id)).toEqual(["ex1"]);
  });

  it("does not request exemplars without the param", async () => {
    const captured = { query: undefined as unknown };
    const app = appWithRecall(captured);
    await app.request("/api/recall?q=throttle&mode=keyword", { headers: { host: "localhost:3940" } });
    expect((captured.query as { withRelatedExemplars?: boolean }).withRelatedExemplars).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/http/recall-exemplars-route.test.ts`
Expected: FAIL — the route doesn't read `withExemplars` and never sets `withRelatedExemplars`.

- [ ] **Step 3: Update the `/api/recall` route in `app.ts`**

The route already maps `withFacts` → `withRelatedFacts` at **app.ts:605-630** (`const factsParam = c.req.query("withFacts")` → `withRelatedFacts` → `...(withRelatedFacts !== undefined ? { withRelatedFacts } : {})` spread into the `search({...})` object). Mirror it exactly: read the `withExemplars` param and set `withRelatedExemplars`:
```ts
    const withExemplars = c.req.query("withExemplars") === "true";
```
and include `...(withExemplars ? { withRelatedExemplars: true } : {})` in the `search({...})` call object, mirroring how `withFacts`/`withRelatedFacts` is already passed. The route already returns `c.json(result)`, so `relatedExemplars` flows out automatically.

- [ ] **Step 4: Update the in-process UserPromptSubmit hook handler in `app.ts`**

In the handler at the existing `deps.recall.search({ query: userMessage, mode: "keyword", limit: 5, withRelatedFacts: true })` call, add `withRelatedExemplars: true`. Update the empty-context check and the render call:
```ts
      if (
        selected.length === 0 &&
        (result.relatedFacts ?? []).length === 0 &&
        (result.relatedExemplars ?? []).length === 0
      ) {
        return c.json({ context: null });
      }
      // ...
      return c.json({
        context: formatPointerBlock(
          selected,
          result.relatedFacts ?? [],
          (result.relatedExemplars ?? []).map((e) => ({
            outcome: e.outcome, lang: e.lang, repo: e.repo, taskContext: e.taskContext,
          })),
        ),
      });
```

- [ ] **Step 5: Update `recall-over-http.ts`**

Request exemplars, parse them, return them. Change the URL to append `&withExemplars=true`. Extend `RecallBody` with:
```ts
      relatedExemplars?: ReadonlyArray<{
        outcome: string; lang: string | null; repo: string; taskContext: string;
      }>;
```
Add to the result:
```ts
    const exemplars = (body.relatedExemplars ?? []).map((e) => ({
      outcome: e.outcome, lang: e.lang, repo: e.repo, taskContext: e.taskContext,
    }));
    return { hits, facts, exemplars };
```
Update `RecallOverHttpResult` to include `readonly exemplars: ReadonlyArray<PointerExemplar>;` (import `PointerExemplar` from `@core/hook/pointer-block.js`), and update the two early `return { hits: [], facts: [] }` sites to `return { hits: [], facts: [], exemplars: [] }`.

Then update the consuming call site: **`src/hook/prompt-recall-hook.ts:103`** currently does `const block = formatPointerBlock(selected, fetched.facts);` — change it to `formatPointerBlock(selected, fetched.facts, fetched.exemplars)`. (Leave `src/hook/session-start-hook.ts:61` alone — it's the cold-start path with no task query to match against; its `formatPointerBlock(selected)` call still compiles because the new args default.) The typecheck in Step 6 will surface any other caller of `RecallOverHttpResult` that needs the new field.

- [ ] **Step 6: Run the route test + typecheck + full suite**

Run: `npx vitest run tests/unit/http/recall-exemplars-route.test.ts && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: PASS; typecheck clean (this surfaces every caller of `recallOverHttp`/`formatPointerBlock` that needs the third arg); full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/http/app.ts src/hook/recall-over-http.ts src/hook/prompt-recall-hook.ts tests/unit/http/recall-exemplars-route.test.ts
git commit -m "feat(hook): plumb passive code exemplars through /api/recall to the pointer block"
```

---

## Manual verification (end of Phase 2)

With a flag-on daemon (`NLM_CODE_EXEMPLARS_ENABLED=1`) that has captured exemplars, on the next coding prompt the injected recall block should include a `## Related code exemplars (nlm-memory)` section with a one-line pointer to a prior beneficial choice, and the footer should mention `recall_code`. Calling `recall_code` pulls the full chunk. When the flag is off, the block is unchanged from today.

## Self-review notes (coverage vs spec §E)

- §E "passive injection, lean pointer not code" → Tasks 1 (lean `RelatedExemplar`), 3 (one-line render).
- §E "CodeRankEmbed query-prefixed relevance" → Task 1 (`embed(query, "query")`).
- §E "rides the existing relatedFacts channel" → Tasks 2 (RecallResult), 4 (HTTP + both hook paths).
- §E "RecallService gains a codeEmbedder dep" → Task 2.
- Latency refinement (this plan): timeout-guarded injection + flag-gate + distance threshold + k=2.
- Out of scope (later): the distance-threshold calibration (file a follow-up task); Phase 3 supersedence.
