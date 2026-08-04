# Stage A Detector Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sampling, blind-labeling, and weighted-scoring harness that measures the re-derivation detector against hand-checked ground truth, so Stages B–D stop being built on an unvalidated feature.

**Architecture:** Four pure libraries under `scripts/eval/lib/` (features, allocation sampling, chat client, scoring) carry all the logic and all the tests. Three thin CLI scripts under `scripts/eval/` do I/O only: `re-derivation-sample.ts` freezes a frame and draws 303 pairs, `re-derivation-label.ts` runs a blind judge over them, `re-derivation-calibrate.ts` sweeps seven feature dimensions against the labels and emits the report. Artifacts pass between stages as files on disk, so any stage can be re-run without repeating the one before it.

**Tech Stack:** TypeScript, `tsx` for script execution, `vitest` for tests, `better-sqlite3` against `~/.nlm/canonical.sqlite` (read-only), the repo's bundled/OpenAI embedder via `buildEmbedder()`, and an OpenAI-compatible chat endpoint for the judge.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-04-stage-a-detector-calibration-design.md`. Its pre-registration section is binding; any deviation must be disclosed in the final report rather than silently applied.
- **Corpus access is strictly read-only.** Open SQLite with `{ readonly: true }`. This harness never writes to `~/.nlm/canonical.sqlite`.
- **The frame is frozen once.** `re-derivation-sample.ts` resolves the 90-day window to literal ISO timestamps and writes them to `frame.json`. Every later stage reads that file. No later stage may call `datetime('now', ...)`.
- **Seed is `20260804`,** derived per-purpose through `deriveSeed`/`makeRng` from `scripts/eval/lib/recall-impact-replay-lib.ts`. Never `Math.random()`.
- **Do not use `stratifiedSample`** from `recall-impact-replay-lib.ts`. It allocates proportional to stratum share; this harness deliberately oversamples rare strata and needs the fixed allocator built in Task 2.
- **Judge settings are fixed:** `google/gemma-4-26b-a4b-qat`, `temperature: 0`, `max_tokens: 400`, `reasoning_effort: "none"`.
- **The judge is blind.** Its prompt may never contain a Jaccard value, a cosine value, a stratum name, a subagent flag, or the incumbent detector's verdict.
- **Typecheck gates everything:** `scripts/` is covered by `tsconfig.scripts.json`. Run `npm run typecheck` before every commit.
- **No em dashes in any emitted report prose.** Hyphens or commas.
- Artifacts live in `reports/re-derivation/`. Intermediate JSON/JSONL in that directory is committed, so a re-run is auditable against the original.

---

### Task 1: Pure pair-feature computation

**Files:**
- Create: `scripts/eval/lib/re-derivation-features.ts`
- Test: `tests/unit/scripts/re-derivation-features.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STOPWORDS`, `tokenize(texts, stripStopwords)`, `jaccardSets(a, b)`, `cosine(a, b)`, `maxPairJaccard(aDecisions, bDecisions, stripStopwords)`, `maxPairCosine(aVecs, bVecs)`, `pairFeatures(a, b, opts)`, and the types `SessionDecisions` and `PairFeatures`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  cosine,
  jaccardSets,
  maxPairJaccard,
  pairFeatures,
  tokenize,
  type SessionDecisions,
} from "../../../scripts/eval/lib/re-derivation-features.js";

describe("tokenize", () => {
  it("matches the incumbent detector's tokenizer when not stripping", () => {
    expect([...tokenize(["Set Sonnet 4.6 as the default"], false)].sort()).toEqual(
      ["4", "6", "as", "default", "set", "sonnet", "the"],
    );
  });

  it("drops stopwords when stripping", () => {
    expect([...tokenize(["Set Sonnet 4.6 as the default"], true)].sort()).toEqual(
      ["4", "6", "default", "set", "sonnet"],
    );
  });

  it("pools every decision into one set", () => {
    expect(tokenize(["alpha beta", "beta gamma"], false)).toEqual(
      new Set(["alpha", "beta", "gamma"]),
    );
  });

  it("returns an empty set for empty input", () => {
    expect(tokenize([], false).size).toBe(0);
    expect(tokenize(["   ---   "], false).size).toBe(0);
  });
});

describe("jaccardSets", () => {
  it("is 1 for identical non-empty sets", () => {
    expect(jaccardSets(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(1);
  });

  it("is 0 when either side is empty, never NaN", () => {
    expect(jaccardSets(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccardSets(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSets(new Set(), new Set())).toBe(0);
  });

  it("computes intersection over union", () => {
    expect(jaccardSets(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
});

describe("maxPairJaccard", () => {
  it("finds the best single decision-to-decision match, not the pooled overlap", () => {
    const a = ["totally unrelated filler about docker", "use pgvector over qdrant"];
    const b = ["use pgvector over qdrant"];
    expect(maxPairJaccard(a, b, true)).toBe(1);
  });

  it("is 0 when either side has no decisions", () => {
    expect(maxPairJaccard([], ["anything"], true)).toBe(0);
  });

  it("reports which decision indices matched", () => {
    const a = ["alpha only", "beta gamma delta"];
    const b = ["zeta", "beta gamma delta"];
    expect(maxPairJaccard(a, b, true, true)).toEqual({ score: 1, aIndex: 1, bIndex: 1 });
  });
});

describe("cosine", () => {
  it("is 1 for parallel vectors and 0 for orthogonal ones", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 3]))).toBeCloseTo(0);
  });

  it("is 0 for a zero vector rather than NaN", () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe("pairFeatures", () => {
  const a: SessionDecisions = {
    id: "cc_sub_a1",
    startedAt: "2026-06-24T20:17:43.897Z",
    decisions: ["Task 6 approved"],
    entities: ["nlm-memory"],
  };
  const b: SessionDecisions = {
    id: "cc_sub_b2",
    startedAt: "2026-07-02T20:23:58.742Z",
    decisions: ["Approved Task 6"],
    entities: ["nlm-memory", "workstreams"],
  };

  it("reproduces the incumbent detector's verdict on the Task 6 pair", () => {
    const f = pairFeatures(a, b, {});
    expect(f.rawPooledJaccard).toBe(1);
    expect(f.gapDays).toBeGreaterThan(7);
    expect(f.sharedEntityCount).toBe(1);
  });

  it("flags both sides as subagent sessions", () => {
    expect(pairFeatures(a, b, {}).subagentSides).toBe(2);
  });

  it("counts decisions and tokens per side", () => {
    const f = pairFeatures(a, b, {});
    expect(f.minDecisionCount).toBe(1);
    expect(f.minStrippedTokens).toBe(2);
  });

  it("orders the pair earlier-first regardless of argument order", () => {
    expect(pairFeatures(b, a, {}).aId).toBe("cc_sub_a1");
  });

  it("leaves cosine null when no vectors are supplied", () => {
    expect(pairFeatures(a, b, {}).maxPairCosine).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/re-derivation-features.test.ts`
Expected: FAIL — cannot resolve `scripts/eval/lib/re-derivation-features.js`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Pure feature computation for a candidate re-derivation pair (Stage A).
 *
 * `tokenize(texts, false)` is deliberately byte-identical to the incumbent
 * detector's tokenizer in src/core/metrics/re-derivation.ts, so the
 * calibration can score the shipped configuration as one point in the sweep
 * rather than an approximation of it. Every other feature here exists because
 * the 2026-08-04 ground-truth check found the incumbent confounded with
 * decision-set size and floated off zero by function words.
 *
 * No I/O. All corpus reads live in re-derivation-sample.ts.
 */

export interface SessionDecisions {
  readonly id: string;
  readonly startedAt: string;
  readonly decisions: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
}

export interface PairFeatures {
  readonly aId: string;
  readonly bId: string;
  readonly gapDays: number;
  readonly sharedEntityCount: number;
  readonly rawPooledJaccard: number;
  readonly strippedPooledJaccard: number;
  readonly rawMaxPairJaccard: number;
  readonly strippedMaxPairJaccard: number;
  readonly maxPairCosine: number | null;
  readonly minDecisionCount: number;
  readonly minRawTokens: number;
  readonly minStrippedTokens: number;
  readonly subagentSides: number;
  readonly linked: boolean;
}

/** Standard English function words. Not tuned per-corpus: a corpus-fitted list
 *  would not transfer to another install, the same portability argument that
 *  drove median-relative floors in floor-calibration.ts. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the and or but if then to of in on at for with by from as is are was were be been
being it its this that these those we i you they he she them us our your their my not no do does did
so than too very can will just should now here there what which who whom when where why how all any
both each few more most other some such only own same s t don use using used into over under
again further once about against between during before after above below up down out off`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD = /\W+/;
const MS_PER_DAY = 86_400_000;

export function tokenize(
  texts: ReadonlyArray<string>,
  stripStopwords: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const w of texts.join(" ").toLowerCase().split(WORD)) {
    if (!w) continue;
    if (stripStopwords && STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface BestMatch {
  readonly score: number;
  readonly aIndex: number;
  readonly bIndex: number;
}

export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
): number;
export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
  withIndices: true,
): BestMatch;
export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
  withIndices?: true,
): number | BestMatch {
  const aTok = aDecisions.map((d) => tokenize([d], stripStopwords));
  const bTok = bDecisions.map((d) => tokenize([d], stripStopwords));
  let best: BestMatch = { score: 0, aIndex: -1, bIndex: -1 };
  for (let i = 0; i < aTok.length; i++) {
    for (let j = 0; j < bTok.length; j++) {
      const s = jaccardSets(aTok[i]!, bTok[j]!);
      if (s > best.score) best = { score: s, aIndex: i, bIndex: j };
    }
  }
  return withIndices ? best : best.score;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function maxPairCosine(
  aVecs: ReadonlyArray<Float32Array>,
  bVecs: ReadonlyArray<Float32Array>,
): number {
  let best = 0;
  for (const v of aVecs) for (const w of bVecs) best = Math.max(best, cosine(v, w));
  return best;
}

export interface PairFeatureOptions {
  readonly aVectors?: ReadonlyArray<Float32Array>;
  readonly bVectors?: ReadonlyArray<Float32Array>;
  readonly linked?: boolean;
}

function isSubagent(id: string): boolean {
  return id.startsWith("cc_sub_");
}

export function pairFeatures(
  x: SessionDecisions,
  y: SessionDecisions,
  opts: PairFeatureOptions,
): PairFeatures {
  const flip = new Date(y.startedAt).getTime() < new Date(x.startedAt).getTime();
  const a = flip ? y : x;
  const b = flip ? x : y;
  const aVecs = (flip ? opts.bVectors : opts.aVectors) ?? [];
  const bVecs = (flip ? opts.aVectors : opts.bVectors) ?? [];

  const aRaw = tokenize(a.decisions, false);
  const bRaw = tokenize(b.decisions, false);
  const aStr = tokenize(a.decisions, true);
  const bStr = tokenize(b.decisions, true);
  const bEnt = new Set(b.entities);

  return {
    aId: a.id,
    bId: b.id,
    gapDays:
      Math.abs(new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()) / MS_PER_DAY,
    sharedEntityCount: a.entities.filter((e) => bEnt.has(e)).length,
    rawPooledJaccard: jaccardSets(aRaw, bRaw),
    strippedPooledJaccard: jaccardSets(aStr, bStr),
    rawMaxPairJaccard: maxPairJaccard(a.decisions, b.decisions, false),
    strippedMaxPairJaccard: maxPairJaccard(a.decisions, b.decisions, true),
    maxPairCosine: aVecs.length && bVecs.length ? maxPairCosine(aVecs, bVecs) : null,
    minDecisionCount: Math.min(a.decisions.length, b.decisions.length),
    minRawTokens: Math.min(aRaw.size, bRaw.size),
    minStrippedTokens: Math.min(aStr.size, bStr.size),
    subagentSides: Number(isSubagent(a.id)) + Number(isSubagent(b.id)),
    linked: opts.linked ?? false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/re-derivation-features.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Verify the tokenizer really matches the incumbent**

Run:
```bash
npx tsx -e '
import { tokenize } from "./scripts/eval/lib/re-derivation-features.js";
const texts = ["Set Sonnet 4.6 as the default model for new sessions", "Task 6 approved"];
const incumbent = new Set(texts.join(" ").toLowerCase().split(/\W+/).filter(Boolean));
const ours = tokenize(texts, false);
const same = incumbent.size === ours.size && [...incumbent].every((t) => ours.has(t));
console.log(same ? "MATCH" : "DIVERGED", incumbent.size, ours.size);
'
```
Expected: `MATCH`. If it diverges, the sweep cannot score the shipped configuration and Task 1 is not done.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval/lib/re-derivation-features.ts tests/unit/scripts/re-derivation-features.test.ts
git commit -m "feat(eval): pure pair features for re-derivation calibration"
```

---

### Task 2: Fixed-allocation stratified sampler

**Files:**
- Create: `scripts/eval/lib/re-derivation-sampling.ts`
- Test: `tests/unit/scripts/re-derivation-sampling.test.ts`

**Interfaces:**
- Consumes: `deriveSeed`, `makeRng`, `seededShuffle` from `scripts/eval/lib/recall-impact-replay-lib.js`.
- Produces: `allocatedSample(rows, keyOf, quotas, seed)` returning `{ selected, drawn, shortfalls }`, and `balancedQuota(rows, subKeyOf, n, seed)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  allocatedSample,
  balancedQuota,
} from "../../../scripts/eval/lib/re-derivation-sampling.js";

interface Row {
  readonly id: number;
  readonly stratum: string;
  readonly size: string;
}

const rows: ReadonlyArray<Row> = Array.from({ length: 300 }, (_, i) => ({
  id: i,
  stratum: i < 10 ? "A1" : i < 60 ? "A2" : "A3",
  size: ["small", "mid", "large"][i % 3]!,
}));

describe("allocatedSample", () => {
  it("honours the exact per-stratum quota rather than proportional share", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 5, A2: 20, A3: 20 }, 1);
    expect(r.drawn).toEqual({ A1: 5, A2: 20, A3: 20 });
    expect(r.selected).toHaveLength(45);
  });

  it("takes the whole stratum and records a shortfall when the quota exceeds it", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 50, A2: 5, A3: 5 }, 1);
    expect(r.drawn["A1"]).toBe(10);
    expect(r.shortfalls).toEqual([{ stratum: "A1", wanted: 50, available: 10 }]);
  });

  it("ignores strata with no quota", () => {
    const r = allocatedSample(rows, (x) => x.stratum, { A1: 5 }, 1);
    expect(r.selected.every((x) => x.stratum === "A1")).toBe(true);
  });

  it("is deterministic for a given seed and order-independent of input shuffling", () => {
    const a = allocatedSample(rows, (x) => x.stratum, { A2: 10 }, 42);
    const b = allocatedSample(rows, (x) => x.stratum, { A2: 10 }, 42);
    expect(a.selected.map((x) => x.id)).toEqual(b.selected.map((x) => x.id));
  });

  it("changes selection when the seed changes", () => {
    const a = allocatedSample(rows, (x) => x.stratum, { A3: 10 }, 1);
    const b = allocatedSample(rows, (x) => x.stratum, { A3: 10 }, 2);
    expect(a.selected.map((x) => x.id)).not.toEqual(b.selected.map((x) => x.id));
  });
});

describe("balancedQuota", () => {
  it("splits n as evenly as possible across the sub-key values present", () => {
    const q = balancedQuota(rows, (x) => x.size, 30);
    expect(Object.values(q).reduce((s, v) => s + v, 0)).toBe(30);
    expect(Object.values(q).every((v) => v === 10)).toBe(true);
  });

  it("redistributes when a sub-key is too small to fill its share", () => {
    const skewed = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: i, stratum: "A", size: "small" })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, stratum: "A", size: "large" })),
    ];
    const q = balancedQuota(skewed, (x) => x.size, 12);
    expect(q["small"]).toBe(2);
    expect(q["large"]).toBe(10);
  });

  it("never allocates more than n in total", () => {
    const q = balancedQuota(rows, (x) => x.size, 7);
    expect(Object.values(q).reduce((s, v) => s + v, 0)).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/re-derivation-sampling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Disproportionate stratified sampling for Stage A.
 *
 * recall-impact-replay-lib's stratifiedSample allocates PROPORTIONAL to each
 * stratum's share of the pool. Stage A needs the opposite: rare strata (53
 * pairs at J' >= 0.35) are sampled near-exhaustively while the 257k-pair band
 * is sampled thinly, and the population sizes are carried separately so
 * scoring can weight back. Reusing the proportional sampler here would collapse
 * the whole design into "sample the big bands."
 *
 * The PRNG is the repo's audited one, not a second implementation.
 */

import { deriveSeed, makeRng, seededShuffle } from "./recall-impact-replay-lib.js";

export interface Shortfall {
  readonly stratum: string;
  readonly wanted: number;
  readonly available: number;
}

export interface AllocatedSampleResult<T> {
  readonly selected: ReadonlyArray<T>;
  readonly drawn: Readonly<Record<string, number>>;
  readonly shortfalls: ReadonlyArray<Shortfall>;
}

export function allocatedSample<T>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
  quotas: Readonly<Record<string, number>>,
  seed: number,
): AllocatedSampleResult<T> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    if (!(k in quotas)) continue;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }

  const selected: T[] = [];
  const drawn: Record<string, number> = {};
  const shortfalls: Shortfall[] = [];

  for (const k of Object.keys(quotas).sort()) {
    const pool = groups.get(k) ?? [];
    const want = quotas[k]!;
    const take = Math.min(want, pool.length);
    if (want > pool.length) {
      shortfalls.push({ stratum: k, wanted: want, available: pool.length });
    }
    const shuffled = seededShuffle(pool, makeRng(deriveSeed(seed, k)));
    selected.push(...shuffled.slice(0, take));
    drawn[k] = take;
  }

  return { selected, drawn, shortfalls };
}

/**
 * Splits `n` as evenly as possible across the distinct values of `subKeyOf`,
 * capping each at what is actually available and redistributing the remainder
 * to the sub-keys that still have room. This is what keeps the high-J' strata
 * from resolving to pure short-subagent boilerplate: without it, the sample
 * reproduces the size confound instead of measuring it.
 */
export function balancedQuota<T>(
  rows: ReadonlyArray<T>,
  subKeyOf: (row: T) => string,
  n: number,
): Record<string, number> {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const k = subKeyOf(row);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const keys = [...sizes.keys()].sort();
  const quota: Record<string, number> = {};
  for (const k of keys) quota[k] = 0;

  let remaining = Math.min(n, rows.length);
  while (remaining > 0) {
    const open = keys.filter((k) => quota[k]! < sizes.get(k)!);
    if (open.length === 0) break;
    const before = remaining;
    for (const k of open) {
      if (remaining === 0) break;
      quota[k]! += 1;
      remaining -= 1;
    }
    if (remaining === before) break;
  }
  return quota;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/re-derivation-sampling.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/re-derivation-sampling.ts tests/unit/scripts/re-derivation-sampling.test.ts
git commit -m "feat(eval): fixed-allocation stratified sampler with size balancing"
```

---

### Task 3: Extract the shared chat client

**Files:**
- Create: `scripts/eval/lib/chat-client.ts`
- Modify: `scripts/eval/recall-impact-replay.ts` (replace its inline chat call with an import)
- Test: `tests/unit/scripts/chat-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `chatOnce(opts, system, user)` and `type ChatOptions = { baseUrl, model, apiKey?, temperature, maxTokens, reasoningEffort?, timeoutMs? }`.

**Why this task exists:** `scripts/eval/judge.ts`'s `streamChatOnce` sends only `model`, `messages`, `temperature`, and `stream`. It sends neither `max_tokens` nor `reasoning_effort`, so a reasoning model burns its whole budget on hidden tokens and returns empty content. The settings documented in `reports/replay-eval/2026-07-22-recall-impact.md` come from the inline call in `recall-impact-replay.ts:195`. Stage A must use that path, and having two chat implementations in one eval directory is how the wrong one gets picked next time.

- [ ] **Step 1: Read the existing implementation before extracting**

Run: `sed -n '170,240p' scripts/eval/recall-impact-replay.ts`

Note the exact request body, retry behaviour, and reasoning-token handling. The extraction must preserve all three; the published 0.881 result came from this code path.

- [ ] **Step 2: Write the failing test**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatOnce } from "../../../scripts/eval/lib/chat-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(capture: { body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      capture.body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "VERDICT" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("chatOnce", () => {
  it("sends max_tokens and temperature", async () => {
    const cap: { body?: any } = {};
    stubFetch(cap);
    await chatOnce(
      { baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 400 },
      "sys",
      "usr",
    );
    expect(cap.body.max_tokens).toBe(400);
    expect(cap.body.temperature).toBe(0);
    expect(cap.body.model).toBe("m");
  });

  it("omits reasoning_effort when unset and includes it when set", async () => {
    const cap: { body?: any } = {};
    stubFetch(cap);
    await chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u");
    expect("reasoning_effort" in cap.body).toBe(false);

    await chatOnce(
      { baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10, reasoningEffort: "none" },
      "s",
      "u",
    );
    expect(cap.body.reasoning_effort).toBe("none");
  });

  it("returns the assistant content", async () => {
    stubFetch({});
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).resolves.toBe("VERDICT");
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).rejects.toThrow(/500/);
  });

  it("throws when the model returns empty content, rather than returning a silent blank", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
            status: 200,
          }),
      ),
    );
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).rejects.toThrow(/empty/i);
  });

  it("normalises a trailing slash on baseUrl", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        });
      }),
    );
    await chatOnce({ baseUrl: "http://x/v1/", model: "m", temperature: 0, maxTokens: 1 }, "s", "u");
    expect(calls[0]).toBe("http://x/v1/chat/completions");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/chat-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Port the body from `recall-impact-replay.ts` verbatim, changing only its shape into an exported function. Preserve the empty-content guard: a reasoning model that spends its budget on hidden tokens returns a 200 with blank content, and treating that as a verdict silently corrupts a run.

```typescript
/**
 * One OpenAI-compatible chat call, shared by the replay eval and the Stage A
 * judge. Extracted from recall-impact-replay.ts, which is the only eval path
 * that ever sent max_tokens and reasoning_effort; judge.ts's streamChatOnce
 * sends neither, so a reasoning model there burns its budget on hidden tokens
 * and returns a 200 with empty content.
 */

export interface ChatOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly reasoningEffort?: string;
  readonly timeoutMs?: number;
}

export async function chatOnce(
  opts: ChatOptions,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`chat HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      throw new Error(
        "chat returned empty content (a reasoning model may have spent max_tokens on hidden tokens)",
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/chat-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewire `recall-impact-replay.ts` to import it**

Replace its inline chat function with `import { chatOnce } from "./lib/chat-client.js";` and delete the now-dead local implementation. Keep every call site's arguments identical.

- [ ] **Step 7: Verify nothing regressed**

Run: `npx vitest run tests/unit/scripts/ && npm run typecheck`
Expected: PASS, typecheck clean. If `recall-impact-replay.ts` had retry behaviour the extraction dropped, restore it inside `chatOnce` and add a test before proceeding.

- [ ] **Step 8: Commit**

```bash
git add scripts/eval/lib/chat-client.ts scripts/eval/recall-impact-replay.ts tests/unit/scripts/chat-client.test.ts
git commit -m "refactor(eval): extract shared chat client with max_tokens and reasoning_effort"
```

---

### Task 4: Frame builder and sampler CLI

**Files:**
- Create: `scripts/eval/re-derivation-sample.ts`
- Modify: `package.json` (add `"eval:rederiv-sample": "tsx scripts/eval/re-derivation-sample.ts"`)

**Interfaces:**
- Consumes: `pairFeatures`, `tokenize` (Task 1); `allocatedSample`, `balancedQuota` (Task 2); `buildEmbedder()` from `src/llm/build-embedder.js`.
- Produces: two files in `reports/re-derivation/` — `frame.json` (window bounds, stratum populations, config) and `sample.jsonl` (one row per sampled pair with its full feature vector, stratum, and the evidence the judge will see).

**This task has no unit test.** It is I/O orchestration over a live corpus; its logic lives in the tested libraries from Tasks 1 and 2. Its correctness gate is Step 5's reproduction check.

- [ ] **Step 1: Write the script**

Structure, in order:

1. `openCorpus()` — `new Database(process.env["NLM_DB"] ?? join(homedir(), ".nlm/canonical.sqlite"), { readonly: true })`.
2. `resolveWindow(db, days)` — run `SELECT datetime('now', '-90 days') AS lo, datetime('now') AS hi` **once**, keep both strings, and use those literals in every later query. Nothing downstream may call `datetime('now')` again.
3. Load sessions in `[lo, hi)`, their `session_entities`, their `kind='decision'` markers, and all `continues`/`supersedes` edges.
4. Build the frame: both sides decision-bearing, at least one shared entity, `gapDays > 7`, unlinked. Build the three probe pools per the spec.
5. Embed decision text: for every in-window decision-bearing session, `await embedder.embed(text, "document")` per decision marker, concurrency 4, with a progress line every 250 markers. Cache to `reports/re-derivation/decision-vectors.jsonl` keyed by `sha256(model + ":" + text)` so a re-run is free.
6. Compute the session-pooled decision embedding (component-wise mean of that session's decision vectors, L2-normalised) as the auxiliary variable for the cosine-ranked strata.
7. Assign strata by stopword-stripped pooled Jaccard per the spec table; carve P3 as the top 1% by pooled cosine within `J' = 0` **before** A5 is formed, so the two do not overlap.
8. **Sort the pair list into a stable order before sampling** — `pairs.sort((p, q) => p.pairId.localeCompare(q.pairId))`. `allocatedSample` seeds its shuffle but shuffles the pool as handed to it, so enumerating pairs out of a `Set` without sorting first produces a different sample on a re-run despite the same seed. This is the difference between a reproducible pre-registered sample and one that only looks reproducible.
9. Within each stratum, compute size terciles over `minStrippedTokens` and draw with `balancedQuota(rows, sizeTercile, n)` then `allocatedSample(rows, stratumOf, quotas, deriveSeed(20260804, "sample"))`.
9. Write `frame.json` and `sample.jsonl`.

`frame.json` shape:

```json
{
  "generatedAt": "2026-08-04T00:00:00.000Z",
  "window": { "lo": "2026-05-06 14:22:01", "hi": "2026-08-04 14:22:01", "days": 90 },
  "corpus": { "sessions": 7478, "decisionBearing": 3052 },
  "detectorEligible": 1916500,
  "decisionlessSidePairs": 1276021,
  "frameSize": 468917,
  "strata": {
    "A1": { "definition": "J' >= 0.35", "population": 53, "quota": 53 },
    "A5": { "definition": "J' = 0 minus P3", "population": 176892, "quota": 30 },
    "P2": { "definition": "zero shared entities, top decile cosine", "population": 401581, "quota": 30 }
  },
  "seed": 20260804,
  "embedModel": "text-embedding-nomic-embed-text-v1.5",
  "shortfalls": []
}
```

Each `sample.jsonl` row:

```json
{
  "pairId": "cc_sub_a1|cc_sub_b2",
  "stratum": "A1",
  "sizeTercile": "small",
  "features": { "rawPooledJaccard": 1.0, "strippedPooledJaccard": 1.0, "maxPairCosine": 0.97, "gapDays": 8.0, "minDecisionCount": 1, "minStrippedTokens": 2, "subagentSides": 2, "sharedEntityCount": 1 },
  "a": { "id": "cc_sub_a1", "label": "Review of nlm-memory workstream filter implementation", "startedAt": "2026-06-24T20:17:43.897Z", "decisions": ["Task 6 approved"], "excerpt": "..." },
  "b": { "id": "cc_sub_b2", "label": "Review of Task 6 for nlm-memory", "startedAt": "2026-07-02T20:23:58.742Z", "decisions": ["Approved Task 6"], "excerpt": "..." }
}
```

`excerpt` is the first 1,500 characters of `sessions.summary`, falling back to `sessions.body`. It is what lets the judge tell a genuine re-derivation from a ritual.

- [ ] **Step 2: Add the npm script**

```json
"eval:rederiv-sample": "tsx scripts/eval/re-derivation-sample.ts"
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run it**

Run: `npm run eval:rederiv-sample`
Expected: `frame.json` and `sample.jsonl` written; `sample.jsonl` has 303 lines unless a shortfall is recorded in `frame.json`.

- [ ] **Step 5: Verify the frame reproduces the spec's measured counts**

Run:
```bash
python3 - <<'PY'
import json
f = json.load(open("reports/re-derivation/frame.json"))
print("frame:", f["frameSize"], "expect ~468,917 +/- corpus growth")
print("decisionless:", f["decisionlessSidePairs"], "expect ~1,276,021")
print("A1 pop:", f["strata"]["A1"]["population"], "expect ~53")
tot = sum(s["quota"] for s in f["strata"].values())
print("total quota:", tot, "expect 303")
print("shortfalls:", f["shortfalls"])
PY
wc -l reports/re-derivation/sample.jsonl
```

Expected: frame size within a few hundred of 468,917 (the corpus ingests continuously), A1 population near 53, total quota 303. **A frame size that differs by more than ~2% means the frame definition drifted from the spec — stop and reconcile before labeling.**

- [ ] **Step 6: Eyeball ten sampled rows for judge-readability**

Run: `head -3 reports/re-derivation/sample.jsonl | python3 -m json.tool`

Confirm each row carries both sides' decisions and a non-empty excerpt. A row with an empty excerpt gives the judge nothing to distinguish ritual from re-derivation and must be fixed here, not worked around in the judge prompt.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval/re-derivation-sample.ts package.json reports/re-derivation/frame.json reports/re-derivation/sample.jsonl
git commit -m "feat(eval): Stage A frame builder and stratified pair sampler"
```

---

### Task 5: Blind judge runner

**Files:**
- Create: `scripts/eval/lib/re-derivation-rubric.ts`
- Create: `scripts/eval/re-derivation-label.ts`
- Modify: `package.json` (add `"eval:rederiv-label": "tsx scripts/eval/re-derivation-label.ts"`)
- Test: `tests/unit/scripts/re-derivation-rubric.test.ts`

**Interfaces:**
- Consumes: `chatOnce` (Task 3); `sample.jsonl` (Task 4).
- Produces: `RUBRIC_SYSTEM`, `buildJudgePrompt(row)`, `parseVerdict(raw)`, and the type `Verdict = { label: "GENUINE" | "REVISIT" | "RITUAL" | "SAME_TOPIC_DIFFERENT_DECISION" | "DUPLICATE"; confidence: number; reason: string }`. Writes `labels.jsonl` and `spot-check.md`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  parseVerdict,
  RUBRIC_SYSTEM,
} from "../../../scripts/eval/lib/re-derivation-rubric.js";

const row = {
  pairId: "x|y",
  stratum: "A1",
  sizeTercile: "small",
  features: { rawPooledJaccard: 1, strippedPooledJaccard: 1, maxPairCosine: 0.97, subagentSides: 2 },
  a: { id: "x", label: "Review of workstream filter", startedAt: "2026-06-24T20:17:43.897Z", decisions: ["Task 6 approved"], excerpt: "reviewed task 6" },
  b: { id: "y", label: "Review of Task 6", startedAt: "2026-07-02T20:23:58.742Z", decisions: ["Approved Task 6"], excerpt: "reviewed task 6 again" },
} as const;

describe("buildJudgePrompt", () => {
  const prompt = buildJudgePrompt(row as never);

  it("leaks no detector feature to the judge", () => {
    for (const banned of ["accard", "cosine", "stratum", "A1", "subagent", "0.97", "sizeTercile"]) {
      expect(prompt.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("includes both sides' dates, labels and decisions", () => {
    expect(prompt).toContain("2026-06-24");
    expect(prompt).toContain("Task 6 approved");
    expect(prompt).toContain("Approved Task 6");
  });

  it("presents the earlier session first", () => {
    expect(prompt.indexOf("2026-06-24")).toBeLessThan(prompt.indexOf("2026-07-02"));
  });
});

describe("RUBRIC_SYSTEM", () => {
  it("names every label the parser accepts", () => {
    for (const l of ["GENUINE", "REVISIT", "RITUAL", "SAME_TOPIC_DIFFERENT_DECISION", "DUPLICATE"]) {
      expect(RUBRIC_SYSTEM).toContain(l);
    }
  });
});

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"label":"GENUINE","confidence":0.8,"reason":"same call re-made"}')).toEqual({
      label: "GENUINE",
      confidence: 0.8,
      reason: "same call re-made",
    });
  });

  it("tolerates a fenced code block", () => {
    expect(parseVerdict('```json\n{"label":"RITUAL","confidence":0.9,"reason":"r"}\n```')?.label).toBe(
      "RITUAL",
    );
  });

  it("returns null on an unknown label rather than coercing it", () => {
    expect(parseVerdict('{"label":"MAYBE","confidence":1,"reason":"r"}')).toBeNull();
  });

  it("returns null on unparseable output", () => {
    expect(parseVerdict("I think this is a re-derivation.")).toBeNull();
  });

  it("clamps confidence into [0,1]", () => {
    expect(parseVerdict('{"label":"GENUINE","confidence":5,"reason":"r"}')?.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/re-derivation-rubric.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the rubric module**

`RUBRIC_SYSTEM` must define all five labels with the distinctions ground truth showed matter:

```
You are labelling whether a later AI working session RE-DERIVED a decision that
an earlier session had already settled.

Reply with JSON only: {"label": <LABEL>, "confidence": <0..1>, "reason": "<one sentence>"}

LABELS:
- GENUINE: the later session works out an answer the earlier session had already
  settled, with no sign it knew about the earlier one. This is the only positive.
- REVISIT: the later session knowingly changes, refines, or overturns the earlier
  decision. Knowing you are changing a prior call is not re-deriving it.
- RITUAL: both sessions perform the same recurring routine on different subjects.
  "Task 6 approved" and "Approved Task 2" are the same ritual, not the same decision.
- SAME_TOPIC_DIFFERENT_DECISION: same subject area, genuinely different question settled.
- DUPLICATE: the two sessions look like the same session recorded twice.

Judge the CONTENT of the decisions and what the excerpts show the sessions doing.
Short, formulaic decision text is weak evidence of anything; prefer RITUAL over
GENUINE when the only thing the two decisions share is boilerplate phrasing.
```

`buildJudgePrompt` renders both sides as date, label, decisions, excerpt. It must not interpolate any field from `features`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/re-derivation-rubric.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Write the runner**

`re-derivation-label.ts`:
- Reads `sample.jsonl`.
- Calls `chatOnce` with `NLM_EVAL_JUDGE_BASE_URL`, model `google/gemma-4-26b-a4b-qat`, `temperature: 0`, `maxTokens: 400`, `reasoningEffort: "none"`.
- Caches each verdict on disk under `reports/re-derivation/judge-cache/<sha256(model+":"+prompt)>.json`, so re-runs cost nothing and an interrupted run resumes.
- Counts and reports: total, parse failures, call failures. A parse failure is recorded as `label: null` and **excluded** from scoring, never coerced to a negative.
- Re-judges 30 rows (seed `deriveSeed(20260804, "consistency")`) with `qwen/qwen3.6-35b-a3b` and reports agreement.
- Writes `labels.jsonl` (`pairId`, `verdict`, `secondVerdict` where applicable).
- Writes `spot-check.md`: 20 rows, 10 judge-GENUINE and 10 judge-non-GENUINE, seed `deriveSeed(20260804, "spotcheck")`, rendered exactly as the judge saw them with a blank `Your label: ______` line and **no judge verdict shown**.

- [ ] **Step 6: Smoke-test on three rows before the full run**

Run: `npx tsx scripts/eval/re-derivation-label.ts --limit 3`
Expected: three verdicts, zero parse failures. If any row returns empty content, `reasoning_effort` is not reaching the endpoint — fix that before spending a full run.

- [ ] **Step 7: Full run**

Run: `npm run eval:rederiv-label`
Expected: `labels.jsonl` with 303 rows, parse failures reported. **If parse failures exceed 5%, stop and fix the rubric before scoring** — a judge that cannot follow the output format is not following the rubric either.

- [ ] **Step 8: Commit**

```bash
git add scripts/eval/lib/re-derivation-rubric.ts scripts/eval/re-derivation-label.ts package.json tests/unit/scripts/re-derivation-rubric.test.ts reports/re-derivation/labels.jsonl reports/re-derivation/spot-check.md
git commit -m "feat(eval): blind five-way judge for re-derivation labelling"
```

---

### Task 6: Weighted scoring library

**Files:**
- Create: `scripts/eval/lib/re-derivation-scoring.ts`
- Test: `tests/unit/scripts/re-derivation-scoring.test.ts`

**Interfaces:**
- Consumes: `PairFeatures` (Task 1).
- Produces: `predicate(config)` returning `(f: PairFeatures) => boolean`, `scoreConfig(labeled, frame, config)` returning `{ precision, recall, f1, weightedTP, weightedFP, weightedFN, precisionCI, recallCI }`, `wilson(successes, n)`, and `paretoFront(results)`.

**Why the weighting must be tested:** strata are sampled at rates differing by four orders of magnitude (53 of 53 in A1; 30 of 176,892 in A5). Precision computed on the raw sample would be dominated by A1 and read far higher than the truth. Every count must be scaled by `population / drawn` before any ratio is taken.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  paretoFront,
  scoreConfig,
  wilson,
} from "../../../scripts/eval/lib/re-derivation-scoring.js";

const frame = {
  A1: { population: 100, drawn: 100 },
  A5: { population: 100_000, drawn: 10 },
};

function row(stratum: string, jac: number, genuine: boolean) {
  return {
    stratum,
    genuine,
    features: {
      strippedPooledJaccard: jac,
      rawPooledJaccard: jac,
      strippedMaxPairJaccard: jac,
      rawMaxPairJaccard: jac,
      maxPairCosine: 0,
      gapDays: 30,
      sharedEntityCount: 1,
      minDecisionCount: 3,
      minStrippedTokens: 30,
      subagentSides: 0,
      linked: false,
    },
  } as never;
}

describe("scoreConfig", () => {
  it("weights each stratum by population over drawn, not by raw sample counts", () => {
    // A1: 100/100 sampled, all genuine, all above the floor -> weight 1 each.
    // A5: 10/100000 sampled, 1 genuine below the floor -> weight 10000.
    const labeled = [
      ...Array.from({ length: 100 }, () => row("A1", 0.9, true)),
      row("A5", 0.0, true),
      ...Array.from({ length: 9 }, () => row("A5", 0.0, false)),
    ];
    const r = scoreConfig(labeled, frame, { signal: "strippedPooled", floor: 0.5 });
    expect(r.weightedTP).toBe(100);
    expect(r.weightedFN).toBe(10_000);
    expect(r.precision).toBe(1);
    expect(r.recall).toBeCloseTo(100 / 10_100, 6);
  });

  it("would report a wildly wrong recall if counts were unweighted", () => {
    const labeled = [
      ...Array.from({ length: 100 }, () => row("A1", 0.9, true)),
      row("A5", 0.0, true),
    ];
    const r = scoreConfig(labeled, frame, { signal: "strippedPooled", floor: 0.5 });
    expect(r.recall).toBeLessThan(0.02);
  });

  it("returns precision 0 when nothing fires, rather than NaN", () => {
    const r = scoreConfig([row("A1", 0.1, true)], frame, {
      signal: "strippedPooled",
      floor: 0.9,
    });
    expect(r.precision).toBe(0);
    expect(Number.isNaN(r.f1)).toBe(false);
  });

  it("honours the minimum-decision-tokens dimension", () => {
    const short = row("A1", 1, false);
    (short as any).features.minStrippedTokens = 2;
    const r = scoreConfig([short], frame, {
      signal: "strippedPooled",
      floor: 0.5,
      minTokens: 10,
    });
    expect(r.weightedFP).toBe(0);
  });

  it("honours the subagent-exclusion dimension", () => {
    const sub = row("A1", 1, false);
    (sub as any).features.subagentSides = 2;
    const r = scoreConfig([sub], frame, {
      signal: "strippedPooled",
      floor: 0.5,
      excludeSubagents: true,
    });
    expect(r.weightedFP).toBe(0);
  });
});

describe("wilson", () => {
  it("brackets the point estimate", () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it("is wide at n=1 and narrow at n=10000", () => {
    expect(wilson(1, 1)[0]).toBeLessThan(0.4);
    const [lo, hi] = wilson(5000, 10_000);
    expect(hi - lo).toBeLessThan(0.03);
  });

  it("returns [0,1] for n=0 rather than NaN", () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("paretoFront", () => {
  it("keeps only configs not dominated on both precision and recall", () => {
    const front = paretoFront([
      { id: "a", precision: 0.9, recall: 0.2 },
      { id: "b", precision: 0.5, recall: 0.5 },
      { id: "c", precision: 0.4, recall: 0.1 },
    ] as never);
    expect(front.map((x: any) => x.id).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scripts/re-derivation-scoring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Core weighting, which is the whole point of the module:

```typescript
// A stratum with drawn === 0 has no sampled evidence. Weighting it would divide
// by zero and hand it an Infinity weight, which silently swallows every other
// stratum's contribution. Skip it and report it as uncovered instead.
const weight = (stratum: string) => {
  const s = frame[stratum];
  if (!s || s.drawn === 0) return null;
  return s.population / s.drawn;
};

for (const row of labeled) {
  const w = weight(row.stratum);
  if (w === null) { uncovered.add(row.stratum); continue; }
  const fires = pred(row.features);
  if (fires && row.genuine) weightedTP += w;
  else if (fires && !row.genuine) weightedFP += w;
  else if (!fires && row.genuine) weightedFN += w;
}
const precision = weightedTP + weightedFP > 0 ? weightedTP / (weightedTP + weightedFP) : 0;
const recall = weightedTP + weightedFN > 0 ? weightedTP / (weightedTP + weightedFN) : 0;
const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
```

Confidence intervals use unweighted successes and n **within each stratum**, then propagate; report them as the honest interval rather than a point estimate.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scripts/re-derivation-scoring.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/lib/re-derivation-scoring.ts tests/unit/scripts/re-derivation-scoring.test.ts
git commit -m "feat(eval): population-weighted precision/recall scoring for Stage A"
```

---

### Task 7: Calibration CLI and report

**Files:**
- Create: `scripts/eval/re-derivation-calibrate.ts`
- Modify: `package.json` (add `"eval:rederiv-calibrate": "tsx scripts/eval/re-derivation-calibrate.ts"`)

**Interfaces:**
- Consumes: `scoreConfig`, `paretoFront` (Task 6); `frame.json`, `sample.jsonl`, `labels.jsonl`.
- Produces: `reports/re-derivation/2026-08-04-stage-a-calibration.md` and `.json`.

- [ ] **Step 1: Write the script**

It joins `sample.jsonl` to `labels.jsonl` on `pairId`, drops rows whose verdict failed to parse (counting them), maps `GENUINE → true` and the other four labels → `false`, then sweeps the full grid:

- `tokenizer`: raw, stripped
- `unit`: pooled, maxPair
- `signal`: lexical, cosine, max-of-both
- `minTokens`: 0, 5, 10, 20
- `gapDays`: 0, 3, 7, 14, 30
- `requireEntity`: true, false
- `excludeSubagents`: false, true
- `floor`: 0.05 to 0.95 step 0.05

For each combination it calls `scoreConfig` and records precision, recall, F1, and both intervals.

Report sections, in this order:
1. Identities and settings, including the judge model and the frozen window, mirroring `reports/replay-eval/2026-07-22-recall-impact.md`.
2. Label distribution across all five categories, by stratum.
3. Judge consistency (double-judge agreement) and human agreement from the spot check.
4. **The incumbent configuration's scores**, called out explicitly: raw tokenizer, pooled unit, lexical signal, floor 0.5, gap 7, entity required, subagents included.
5. Per-dimension curves.
6. Pareto front.
7. Two recommended operating points: counting (best F1) and firing (highest recall at precision lower bound ≥ 0.8).
8. Limitations, declared before the numbers are read: recall is conditional on the frame, A1 is small, and the sparsely-sampled strata carry a stated upper bound on hidden positives.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Run it**

Run: `npm run eval:rederiv-calibrate`
Expected: both report files written.

- [ ] **Step 4: Sanity-check the incumbent row against reality**

The incumbent configuration must fire on close to the 15 pairs the live detector flags. Run:

```bash
python3 - <<'PY'
import json
d = json.load(open("reports/re-derivation/2026-08-04-stage-a-calibration.json"))
inc = d["incumbent"]
print("incumbent precision:", inc["precision"], "recall:", inc["recall"])
print("weighted TP/FP/FN:", inc["weightedTP"], inc["weightedFP"], inc["weightedFN"])
PY
```

If the incumbent's weighted firing count is nowhere near the frame's 15-pair A1 population, the sweep is not reproducing the shipped detector and the report is not trustworthy. Stop and reconcile.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval/re-derivation-calibrate.ts package.json reports/re-derivation/2026-08-04-stage-a-calibration.md reports/re-derivation/2026-08-04-stage-a-calibration.json
git commit -m "feat(eval): Stage A calibration sweep and readout"
```

---

### Task 8: Human spot-check and readout close

**Files:**
- Modify: `reports/re-derivation/2026-08-04-stage-a-calibration.md`
- Modify: `logs/CHANGELOG/CHANGELOG.md`

**This task is not automatable.** It gates every downstream stage.

- [ ] **Step 1: Hand Edward the spot-check**

`reports/re-derivation/spot-check.md`, 20 pairs, no judge verdicts shown. Roughly 20 minutes.

- [ ] **Step 2: Compute agreement**

Compare his 20 labels against the judge's on the same rows. Report raw agreement and agreement on the GENUINE/not-GENUINE collapse separately, since the binary is what the curves depend on.

- [ ] **Step 3: Apply the agreement gate**

- Binary agreement **≥ 85%**: the labels stand. Record the number as the headline caveat and proceed to Stage B.
- Binary agreement **70–85%**: the labels are directional only. Report the curves with that caveat prominent and do not pick a firing threshold from them without a second labeling pass.
- Binary agreement **< 70%**: the labels do not support any threshold decision. Report the disagreement pattern, revise the rubric against the cases that split, and re-run Task 5. Do not proceed to Stage B.

- [ ] **Step 4: Answer the spec's open questions from the data**

1. Does the subagent cohort belong in the metric? Report the cost of excluding it (dimension 7) and put the product call to Edward.
2. Did `J' = 0` with high cosine (P3) yield positives? If yes, the detector must become embedding-first. If no, a cleaned lexical detector may suffice.

- [ ] **Step 5: Append the CHANGELOG entry**

Per session protocol: changes, decisions, state, next priorities. Cap 10 entries.

- [ ] **Step 6: Commit and push**

```bash
git add reports/re-derivation/ logs/CHANGELOG/CHANGELOG.md
git commit -m "reports: Stage A calibration readout and human agreement"
git push
```

---

## Self-Review

**Spec coverage.** Findings A–D are the motivation and need no task. The seven sweep dimensions are implemented in Task 6's `predicate` and enumerated in Task 7's grid. The eight strata are built in Task 4 and weighted in Task 6. The frozen frame is Task 4 Step 1.2 and constrained globally. The five-way rubric is Task 5. Pre-registration is enforced by the Global Constraints and Task 7's report section 1. The two operating points are Task 7 section 7. Open questions are answered in Task 8 Step 4.

**Placeholders.** None. Every code step carries runnable code; every verification step carries a command and an expected result.

**Type consistency.** `PairFeatures` (Task 1) is consumed unchanged by Tasks 4, 6, 7. `chatOnce` (Task 3) is consumed by Task 5. `Verdict.label` values in Task 5 match the `GENUINE` mapping in Task 7. `frame.strata[k].population/drawn` written in Task 4 matches the shape `scoreConfig` reads in Task 6.

**Known gap, deliberate.** Tasks 4, 5, and 7 have no unit tests; they are I/O orchestration over a live corpus and a live endpoint, and the repo's existing eval scripts follow the same split (logic in `lib/` with tests, CLI without). Each instead carries an explicit reproduction check — Task 4 Step 5, Task 5 Step 6, Task 7 Step 4 — that fails loudly against ground truth rather than passing quietly against a mock.
