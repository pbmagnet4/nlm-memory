// tests/integration/backfill-workstreams.test.ts
import { describe, expect, it } from "vitest";
import { backfillWorkstreams } from "../../src/core/workstream/backfill-workstreams.js";
import { DEFAULT_WEIGHTS } from "../../src/core/workstream/thresholds.js";

describe("backfillWorkstreams (match-only)", () => {
  it("binds sessions that match >= HIGH and skips the rest, never creating", async () => {
    const bound: Array<{ s: string; w: string }> = [];
    const HIGH = 0.6;
    // session s1 has a strong entity match to ws_a; s2 matches nothing.
    const deps = {
      listSessions: async () => [
        { sessionId: "s1", label: "L1", summary: "S1", entities: ["x", "y"] },
        { sessionId: "s2", label: "L2", summary: "S2", entities: ["zzz"] },
      ],
      buildInputs: async (input: any) => ({
        sessionEntities: input.entities,
        neighborScores: new Map(input.sessionId === "s1" ? [["ws_a", 0.9]] : []),
        candidates: input.sessionId === "s1" ? [{ workstreamId: "ws_a", entities: ["x", "y"] }] : [],
        thresholds: { high: HIGH, low: 0.3 },
        weights: DEFAULT_WEIGHTS,
      }),
      setBinding: async (s: string, w: string) => { bound.push({ s, w }); },
    } as any;
    const res = await backfillWorkstreams(deps);
    expect(res.bound).toBe(1);
    expect(bound).toEqual([{ s: "s1", w: "ws_a" }]);   // only the >=HIGH match bound
    expect(res.considered).toBe(2);
    expect(res.skipped).toBe(1);                        // s2 unmatched, left NULL
  });
});
