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
