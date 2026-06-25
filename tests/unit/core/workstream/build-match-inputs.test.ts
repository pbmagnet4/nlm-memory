// tests/unit/core/workstream/build-match-inputs.test.ts
import { describe, expect, it } from "vitest";
import { buildMatchInputs } from "../../../../src/core/workstream/build-match-inputs.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../../../../src/core/workstream/thresholds.js";

function deps(over: Partial<any> = {}) {
  return {
    embedder: { embed: async () => ({ vector: [0.1, 0.2] }) },
    sessions: {
      semanticSearch: async () => [{ sessionId: "n1", distance: 0.2 }, { sessionId: "self", distance: 0 }],
      getWorkstreamIds: async () => new Map([["n1", "ws_a"]]),
    },
    workstreams: {
      listAll: async () => [{ id: "ws_a", label: "A", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
      candidatesByEntityOverlap: async () => [{ workstreamId: "ws_a", entities: ["x"] }],
      entitiesFor: async () => new Map([["ws_a", ["x"]]]),
    },
    thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_WEIGHTS,
    ...over,
  } as any;
}

describe("buildMatchInputs", () => {
  it("assembles neighbor scores + entity candidates and excludes the session itself", async () => {
    const inputs = await buildMatchInputs(deps(), { sessionId: "self", label: "L", summary: "S", entities: ["x"] });
    expect(inputs.sessionEntities).toEqual(["x"]);
    expect(inputs.candidates.map((c) => c.workstreamId)).toContain("ws_a");
    expect(inputs.neighborScores.get("ws_a")).toBeGreaterThan(0);   // n1 contributed; self excluded
    expect(inputs.thresholds).toBe(DEFAULT_THRESHOLDS);
  });
  it("resolves a neighbor's merged workstream to the survivor", async () => {
    const d = deps({
      sessions: {
        semanticSearch: async () => [{ sessionId: "n1", distance: 0.2 }],
        getWorkstreamIds: async () => new Map([["n1", "ws_old"]]),
      },
      workstreams: {
        listAll: async () => [
          { id: "ws_old", label: "Old", status: "merged", mergedInto: "ws_new", createdAt: "t", updatedAt: "t", lastSessionAt: null },
          { id: "ws_new", label: "New", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
        ],
        candidatesByEntityOverlap: async () => [],
        entitiesFor: async () => new Map([["ws_new", ["x"]]]),
      },
    });
    const inputs = await buildMatchInputs(d, { sessionId: "self", label: "L", summary: "S", entities: ["x"] });
    expect(inputs.neighborScores.has("ws_new")).toBe(true);   // survivor, not ws_old
    expect(inputs.neighborScores.has("ws_old")).toBe(false);
  });
});
