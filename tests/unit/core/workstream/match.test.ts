// tests/unit/core/workstream/match.test.ts
import { describe, expect, it } from "vitest";
import { matchWorkstream, jaccard, scoreCandidates } from "../../../../src/core/workstream/match.js";
import type { MatchInputs } from "../../../../src/core/workstream/model.js";

const base = (over: Partial<MatchInputs>): MatchInputs => ({
  sessionEntities: ["NLM", "Daemon"],
  neighborScores: new Map(),
  candidates: [],
  thresholds: { high: 0.55, low: 0.3 },
  weights: { semantic: 0.5, entity: 0.5 },
  ...over,
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });
  it("is intersection over union", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });
});

it("scoreCandidates returns candidates sorted by combined score desc", () => {
  const out = scoreCandidates({
    sessionEntities: ["x"], neighborScores: new Map([["ws_a", 0.9], ["ws_b", 0.1]]),
    candidates: [{ workstreamId: "ws_a", entities: ["x"] }, { workstreamId: "ws_b", entities: [] }],
    thresholds: { high: 0.5, low: 0.3 }, weights: { semantic: 0.5, entity: 0.5 },
  });
  expect(out[0]!.workstreamId).toBe("ws_a");
  expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
});

describe("matchWorkstream", () => {
  it("binds when top score >= high", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["NLM", "Daemon"] }],
      neighborScores: new Map([["ws_1", 0.8]]),
    }));
    expect(d).toEqual({ kind: "bind", workstreamId: "ws_1", confidence: expect.any(Number) });
    if (d.kind === "bind") expect(d.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("is ambiguous when top score is between low and high", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["NLM"] }, { workstreamId: "ws_2", entities: ["Daemon"] }],
      neighborScores: new Map([["ws_1", 0.4], ["ws_2", 0.3]]),
    }));
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.candidates.length).toBeGreaterThanOrEqual(1);
      expect(d.candidates.length).toBeLessThanOrEqual(5);
      expect(d.candidates[0]!.workstreamId).toBe("ws_1"); // sorted by score desc
    }
  });

  it("creates when there are no candidates", () => {
    expect(matchWorkstream(base({})).kind).toBe("create");
  });

  it("creates when top score is below low", () => {
    const d = matchWorkstream(base({
      candidates: [{ workstreamId: "ws_1", entities: ["Other"] }],
      neighborScores: new Map([["ws_1", 0.1]]),
    }));
    expect(d.kind).toBe("create");
  });

  it("binds when top score exactly equals high (>= boundary)", () => {
    // score = weights.semantic * semantic + weights.entity * jaccard(sessionEntities, candidate.entities)
    // = 0.5 * 1.0 + 0.5 * jaccard(["x"], []) = 0.5 * 1.0 + 0.5 * 0 = 0.5 == high
    // 0.5 = 2^-1, exactly representable in binary. Locks the >= operator against regression.
    const d = matchWorkstream({
      sessionEntities: ["x"],
      neighborScores: new Map([["ws_a", 1.0]]),
      candidates: [{ workstreamId: "ws_a", entities: [] }],
      thresholds: { high: 0.5, low: 0.25 },
      weights: { semantic: 0.5, entity: 0.5 },
    });
    expect(d.kind).toBe("bind");
  });

  it("is ambiguous (not create) when top score exactly equals low (strict-< boundary)", () => {
    // score = 0.5 * 1.0 + 0.5 * jaccard(["x"], []) = 0.5 * 1.0 + 0.5 * 0 = 0.5 == low
    // 0.5 < 0.5 is false (strict), so create is skipped; 0.5 >= 0.75 is false, so bind is skipped -> ambiguous.
    // 0.5 = 2^-1, 0.75 = 3/4 = 2^-1 + 2^-2, both exactly representable. Locks the strict-< operator.
    const d = matchWorkstream({
      sessionEntities: ["x"],
      neighborScores: new Map([["ws_a", 1.0]]),
      candidates: [{ workstreamId: "ws_a", entities: [] }],
      thresholds: { high: 0.75, low: 0.5 },
      weights: { semantic: 0.5, entity: 0.5 },
    });
    expect(d.kind).toBe("ambiguous");
  });
});
