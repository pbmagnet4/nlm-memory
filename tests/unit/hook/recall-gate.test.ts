import { describe, expect, it } from "vitest";
import { parseRecallGateMode } from "../../../src/hook/recall-gate.js";

describe("parseRecallGateMode", () => {
  it("returns undefined (gate off) by default", () => {
    expect(parseRecallGateMode({})).toBeUndefined();
  });

  it("returns undefined for an explicit off", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "off" })).toBeUndefined();
  });

  it("parses shadow", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "shadow" })).toBe("shadow");
  });

  it("parses live", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "live" })).toBe("live");
  });

  it("treats an unknown value as off", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "yes" })).toBeUndefined();
  });
});
