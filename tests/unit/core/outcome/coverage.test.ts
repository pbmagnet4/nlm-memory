import { describe, it, expect } from "vitest";
import { computeOutcomeCoverage } from "@core/outcome/coverage.js";
import type { OutcomeCoverageInput } from "@core/outcome/coverage.js";
import type { OutcomeEdge, OutcomeSession, OutcomeSignal } from "@ports/outcome.js";

function baseInput(overrides: Partial<OutcomeCoverageInput> = {}): OutcomeCoverageInput {
  return {
    sessions: [],
    signalsBySession: new Map(),
    edgesBySession: new Map(),
    citationsBySession: new Map(),
    reDerivationPairs: [],
    now: () => new Date("2026-01-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("computeOutcomeCoverage", () => {
  it("returns all-zero counts for an empty window", async () => {
    const coverage = await computeOutcomeCoverage("team_local", baseInput());
    expect(coverage).toEqual({
      total: 0,
      held: 0,
      overturned: 0,
      builtUpon: 0,
      reDerivedLater: 0,
      unobserved: 0,
    });
  });

  it("buckets sessions with no evidence as unobserved, honestly the majority", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-19T00:00:00.000Z", status: "closed" },
      { id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
      { id: "s3", endedAt: "2026-01-17T00:00:00.000Z", status: "closed" },
    ];
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions }));
    expect(coverage.total).toBe(3);
    expect(coverage.unobserved).toBe(3);
    expect(coverage.held + coverage.overturned + coverage.builtUpon + coverage.reDerivedLater).toBe(0);
  });

  it("buckets a superseded session as overturned via the batched edge map", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-19T00:00:00.000Z", status: "superseded" },
      { id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
    ];
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions }));
    expect(coverage.overturned).toBe(1);
    expect(coverage.unobserved).toBe(1);
  });

  it("buckets held-eligible sessions via the shared 14-day clock rule", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-01T00:00:00.000Z", status: "closed" }, // 19 days elapsed -> held
      { id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" }, // 2 days elapsed -> unobserved
    ];
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions }));
    expect(coverage.held).toBe(1);
    expect(coverage.unobserved).toBe(1);
  });

  it("buckets a continues edge as built-upon using the per-session edge map, not other sessions' edges", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
      { id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
    ];
    const edgesBySession = new Map<string, ReadonlyArray<OutcomeEdge>>([
      ["s1", [{ fromSession: "s3", toSession: "s1", kind: "continues" }]],
    ]);
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions, edgesBySession }));
    expect(coverage.builtUpon).toBe(1);
    expect(coverage.unobserved).toBe(1);
  });

  it("buckets a re-derivation pair member as re-derived-later", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
    ];
    const coverage = await computeOutcomeCoverage("team_local", 
      baseInput({ sessions, reDerivationPairs: [{ a: "s1", b: "s9", sharedEntities: ["x"], jaccard: 0.9 }] }),
    );
    expect(coverage.reDerivedLater).toBe(1);
  });

  it("Tier-A signal evidence wins over everything, matching deriveOutcome precedence", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
    ];
    const signalsBySession = new Map<string, ReadonlyArray<OutcomeSignal>>([
      ["s1", [{ id: "sig-1", outcome: "fail" }]],
    ]);
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions, signalsBySession }));
    expect(coverage.overturned).toBe(1);
  });

  it("does not leak one session's evidence onto another session's verdict", async () => {
    const sessions: OutcomeSession[] = [
      { id: "s1", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
      { id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" },
    ];
    const signalsBySession = new Map<string, ReadonlyArray<OutcomeSignal>>([
      ["s1", [{ id: "sig-1", outcome: "pass" }]],
    ]);
    const coverage = await computeOutcomeCoverage("team_local", baseInput({ sessions, signalsBySession }));
    expect(coverage.held).toBe(1); // s1 via tier-A
    expect(coverage.unobserved).toBe(1); // s2 has no signals of its own
  });
});
