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
    // "task 6 approved" strips to {task, 6, approved} on both sides: none of
    // those three tokens are in STOPWORDS (verified against the tokenize
    // describe block above, which pins the stripped tokenizer's behavior
    // including keeping bare digits), so the pooled stripped set size is 3,
    // not 2. See the final report for the plan-vs-implementation reconciliation.
    expect(f.minStrippedTokens).toBe(3);
  });

  it("orders the pair earlier-first regardless of argument order", () => {
    expect(pairFeatures(b, a, {}).aId).toBe("cc_sub_a1");
  });

  it("leaves cosine null when no vectors are supplied", () => {
    expect(pairFeatures(a, b, {}).maxPairCosine).toBeNull();
  });
});
