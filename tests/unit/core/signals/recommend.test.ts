import { describe, expect, it } from "vitest";
import { recommendActions } from "../../../../src/core/signals/recommend.js";
import type { FailureMode } from "../../../../src/core/signals/aggregate.js";

const mode = (o: Partial<FailureMode>): FailureMode => ({ repo: "/r", model: "m", kind: "gate", step: "types", total: 100, failures: 60, failRate: 0.6, lastTs: "x", ...o });

describe("recommendActions", () => {
  it("recommends a model swap when fail rate exceeds the swap threshold", () => {
    const recs = recommendActions([mode({ failRate: 0.6 })], { swapThreshold: 0.5 });
    expect(recs.some((r) => r.kind === "model-swap")).toBe(true);
  });

  it("recommends an AGENTS.md rule for the most common step", () => {
    const recs = recommendActions([mode({ step: "types", failRate: 0.3 })], { swapThreshold: 0.5 });
    expect(recs.some((r) => r.kind === "agents-rule" && r.text.includes("types"))).toBe(true);
  });

  it("returns nothing for an empty input", () => {
    expect(recommendActions([], {})).toEqual([]);
  });
});
