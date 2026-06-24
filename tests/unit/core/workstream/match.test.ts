// tests/unit/core/workstream/match.test.ts
import { describe, expect, it } from "vitest";
import { matchWorkstream, jaccard } from "../../../../src/core/workstream/match.js";
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
});
