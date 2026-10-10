import { describe, it, expect } from "vitest";
import { yieldStats, yields, type YieldRow } from "../../../scripts/eval/lib/clef-yield-report.js";

const row = (id: string, score: number | null, decisions: number, facts: number): YieldRow =>
  ({ id, runtime: "claude-code/1.0", chars: 1000, score, ms: 1000, decisions, facts, opens: 0 });

describe("yield stats", () => {
  const rows = [
    row("a", 0.5, 0, 0), // skippable, skipped
    row("b", 3, 0, 0), // skippable, kept
    row("c", 0.9, 2, 1), // yielding, lost
    row("d", 2.5, 4, 3), // yielding, kept
    row("e", null, 5, 5), // unscored: kept, excluded from totals
  ];

  it("counts what a threshold skips and what stored output it loses", () => {
    const s = yieldStats(rows, 1.5);
    expect(s.scored).toBe(4);
    expect(s.skipped).toBe(2);
    expect(s.skippableTotal).toBe(2);
    expect(s.skippableSkipped).toBe(1);
    expect(s.yieldingTotal).toBe(2);
    expect(s.yieldingLost).toBe(1);
    expect(s.decisionsLost).toBe(2);
    expect(s.decisionsTotal).toBe(6);
    expect(s.factsLost).toBe(1);
    expect(s.factsTotal).toBe(4);
  });

  it("never skips an unscored session", () => {
    expect(yieldStats([row("x", null, 3, 3)], 99).skipped).toBe(0);
  });

  it("treats a session with no decisions and no facts as storing nothing", () => {
    expect(yields(row("z", 1, 0, 0))).toBe(false);
    expect(yields(row("z", 1, 0, 1))).toBe(true);
  });

  it("gives a wide upper bound when few yielding sessions were checked", () => {
    const s = yieldStats([row("a", 3, 1, 0), row("b", 3, 1, 0)], 1.5);
    expect(s.yieldingLost).toBe(0);
    expect(s.yieldingLostUpper).toBeGreaterThan(0.3);
  });
});
