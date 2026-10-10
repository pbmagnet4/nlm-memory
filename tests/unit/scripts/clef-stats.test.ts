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
