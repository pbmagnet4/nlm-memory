/**
 * Deterministic tests for the wiki-live ablation scorer (synthetic data only —
 * no corpus, no DB, no models).
 */
import { describe, expect, it } from "vitest";
import {
  blendedRerank,
  normalizeScores,
  recallAtK,
  tokenize,
  tokenRecall,
  WIKI_BLEND,
} from "../../../scripts/eval/lib/wiki-live-scoring.js";
import { parseArgs } from "../../../scripts/eval/wiki-live-ablation.js";

describe("wiki-live-scoring", () => {
  it("declares the single fixed 50/50 blend", () => {
    expect(WIKI_BLEND).toBe(0.5);
  });

  it("tokenizes like the spike scorer (lowercase alnum, len > 1)", () => {
    expect(tokenize("PoLL Judge-Harness v2 a")).toEqual(new Set(["poll", "judge", "harness", "v2"]));
    expect(tokenize("")).toEqual(new Set());
  });

  it("tokenRecall is the query-token hit fraction", () => {
    expect(tokenRecall(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 3);
    expect(tokenRecall(new Set(), new Set(["x"]))).toBe(0);
    expect(tokenRecall(new Set(["x"]), new Set())).toBe(0);
  });

  it("normalizeScores maps a spread to [0,1] preserving order", () => {
    expect(normalizeScores([10, 20, 30])).toEqual([0, 0.5, 1]);
  });

  it("normalizeScores maps a degenerate list to all 1s (wiki term decides)", () => {
    expect(normalizeScores([5, 5, 5])).toEqual([1, 1, 1]);
    expect(normalizeScores([])).toEqual([]);
  });

  it("blendedRerank lets a strong wiki term overturn recall order", () => {
    const ranked = blendedRerank([
      { id: "recall-best", score: 9, wikiRecall: 0, rank: 0 },
      { id: "wiki-best", score: 1, wikiRecall: 1, rank: 1 },
    ]);
    // recall-norm: [1, 0] -> blended [0.5, 0.5] -> tie -> recall rank wins.
    expect(ranked).toEqual(["recall-best", "wiki-best"]);
    const ranked2 = blendedRerank([
      { id: "recall-best", score: 9, wikiRecall: 0, rank: 0 },
      { id: "mid", score: 4, wikiRecall: 0, rank: 1 },
      { id: "wiki-best", score: 5, wikiRecall: 1, rank: 2 },
    ]);
    // recall-norm: [1, 0, 0.2] -> blended [0.5, 0, 0.6] -> wiki wins.
    expect(ranked2).toEqual(["wiki-best", "recall-best", "mid"]);
  });

  it("blendedRerank breaks full ties by original recall rank", () => {
    const ranked = blendedRerank([
      { id: "b", score: 3, wikiRecall: 0.5, rank: 1 },
      { id: "a", score: 3, wikiRecall: 0.5, rank: 0 },
    ]);
    expect(ranked).toEqual(["a", "b"]);
  });

  it("recallAtK gives partial credit and handles empties", () => {
    expect(recallAtK(["s1", "s2"], ["s1", "s9"])).toBe(0.5);
    expect(recallAtK(["s1", "s2"], ["s1", "s2"])).toBe(1);
    expect(recallAtK(["s1", "s2"], ["s9"])).toBe(0);
    expect(recallAtK([], ["s1"])).toBe(0);
  });
});

describe("wiki-live-ablation parseArgs", () => {
  it("clamps depth up to the limit so the wiki arm pool is never shorter than top-K", () => {
    expect(parseArgs(["--limit=10", "--depth=5"]).depth).toBe(10);
    expect(parseArgs(["--limit=10", "--depth=5"]).limit).toBe(10);
  });

  it("leaves depth above the limit untouched and keeps defaults", () => {
    expect(parseArgs(["--limit=10", "--depth=30"]).depth).toBe(30);
    expect(parseArgs([])).toEqual(
      expect.objectContaining({ limit: 10, depth: 30 }),
    );
  });
});
