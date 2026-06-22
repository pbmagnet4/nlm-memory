import { describe, expect, it } from "vitest";
import {
  aggregateClasses,
  classifyMiss,
  type MissClass,
} from "../../../scripts/eval/candidate-recall-classify.js";

describe("classifyMiss", () => {
  it("returns hit when a gold id is in the final top-k", () => {
    expect(
      classifyMiss({
        goldIds: ["g1"],
        finalTopKIds: ["x", "g1", "y"],
        wideCandidateIds: ["x", "g1", "y", "z"],
      }),
    ).toBe("hit");
  });

  it("returns ranking-miss when gold is in the wide pool but not the final top-k", () => {
    expect(
      classifyMiss({
        goldIds: ["g1"],
        finalTopKIds: ["x", "y"],
        wideCandidateIds: ["x", "y", "g1", "z"],
      }),
    ).toBe("ranking-miss");
  });

  it("returns candidate-miss when gold is absent from the wide pool", () => {
    expect(
      classifyMiss({
        goldIds: ["g1"],
        finalTopKIds: ["x", "y"],
        wideCandidateIds: ["x", "y", "z"],
      }),
    ).toBe("candidate-miss");
  });

  it("treats an empty gold set as candidate-miss (no recoverable target)", () => {
    expect(
      classifyMiss({
        goldIds: [],
        finalTopKIds: ["x"],
        wideCandidateIds: ["x", "y"],
      }),
    ).toBe("candidate-miss");
  });

  it("hit wins when any of several gold ids lands in the final top-k", () => {
    expect(
      classifyMiss({
        goldIds: ["g1", "g2"],
        finalTopKIds: ["x", "g2"],
        wideCandidateIds: ["x", "g2", "g1"],
      }),
    ).toBe("hit");
  });
});

describe("aggregateClasses", () => {
  it("reports no-misses when everything is a hit", () => {
    const agg = aggregateClasses(["hit", "hit"]);
    expect(agg.verdict).toBe("no-misses");
    expect(agg.hits).toBe(2);
    expect(agg.rankingMissShare).toBe(0);
    expect(agg.candidateMissShare).toBe(0);
  });

  it("computes shares over misses only, excluding hits from the denominator", () => {
    // 2 hits, 1 ranking, 1 candidate -> shares are 0.5 / 0.5 over 2 misses.
    const agg = aggregateClasses(["hit", "hit", "ranking-miss", "candidate-miss"]);
    expect(agg.hits).toBe(2);
    expect(agg.rankingMisses).toBe(1);
    expect(agg.candidateMisses).toBe(1);
    expect(agg.rankingMissShare).toBe(0.5);
    expect(agg.candidateMissShare).toBe(0.5);
    expect(agg.verdict).toBe("mixed");
  });

  it("verdict is recall-bound when candidate misses dominate (>=65%)", () => {
    const classes: MissClass[] = [
      "candidate-miss",
      "candidate-miss",
      "candidate-miss",
      "ranking-miss",
    ];
    const agg = aggregateClasses(classes);
    expect(agg.candidateMissShare).toBe(0.75);
    expect(agg.verdict).toBe("recall-bound");
  });

  it("verdict is ranking-bound when ranking misses dominate (>=65%)", () => {
    const classes: MissClass[] = [
      "ranking-miss",
      "ranking-miss",
      "ranking-miss",
      "candidate-miss",
    ];
    const agg = aggregateClasses(classes);
    expect(agg.rankingMissShare).toBe(0.75);
    expect(agg.verdict).toBe("ranking-bound");
  });
});
