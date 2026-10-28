import { describe, expect, it } from "vitest";
import { cohenKappa, postStratified, ruleOfThree, wilson } from "../../../scripts/eval/lib/property-holdout-stats.js";

describe("wilson", () => {
  it("matches the reference interval for 95/100", () => {
    const w = wilson(95, 100);
    expect(w.low).toBeCloseTo(0.8884, 3);
    expect(w.high).toBeCloseTo(0.9785, 3);
  });
  it("gives lower bound 0.946 at 99/100", () => {
    expect(wilson(99, 100).low).toBeCloseTo(0.9455, 3);
  });
  it("is [0,1] wide for n=0", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("ruleOfThree", () => {
  it("is 3/N", () => {
    expect(ruleOfThree(100)).toBeCloseTo(0.03);
    expect(ruleOfThree(60)).toBeCloseTo(0.05);
  });
  it("is null with no proposals", () => {
    expect(ruleOfThree(0)).toBeNull();
  });
});

describe("cohenKappa", () => {
  it("is 1 for identical labels and 0 for chance agreement", () => {
    expect(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"])).toBe(1);
    expect(cohenKappa(["a", "a", "b", "b"], ["a", "b", "a", "b"])).toBe(0);
  });
  it("computes the textbook 2x2 value", () => {
    const l1 = [...Array(20).fill("y"), ...Array(5).fill("y"), ...Array(10).fill("n"), ...Array(15).fill("n")];
    const l2 = [...Array(20).fill("y"), ...Array(5).fill("n"), ...Array(10).fill("y"), ...Array(15).fill("n")];
    expect(cohenKappa(l1, l2)).toBeCloseTo(0.4, 5);
  });
  it("is null when chance agreement is total and for empty input", () => {
    expect(cohenKappa(["a", "a"], ["a", "a"])).toBeNull();
    expect(cohenKappa([], [])).toBeNull();
  });
  it("rejects unequal lengths", () => {
    expect(() => cohenKappa(["a"], [])).toThrow();
  });
});

describe("postStratified", () => {
  it("weights stratum precision by population share", () => {
    const r = postStratified([
      { stratum: "C", population: 10, n: 10, correct: 5 },
      { stratum: "D", population: 90, n: 10, correct: 10 },
    ]);
    expect(r.estimate).toBeCloseTo(0.95);
    expect(r.unsampled).toEqual([]);
  });
  it("renormalises over sampled strata and reports unsampled ones", () => {
    const r = postStratified([
      { stratum: "C", population: 10, n: 0, correct: 0 },
      { stratum: "D", population: 90, n: 10, correct: 9 },
    ]);
    expect(r.estimate).toBeCloseTo(0.9);
    expect(r.unsampled).toEqual(["C"]);
  });
});
