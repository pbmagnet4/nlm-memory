import { describe, expect, it } from "vitest";
import { composeSessionStartOutput } from "../../../src/hook/session-start-hook.js";

describe("composeSessionStartOutput", () => {
  it("prepends the failure-mode block above the recall block", () => {
    const out = composeSessionStartOutput("## Known failure modes for this repo\n- m failed `types`...", "<recall pointer block>");
    expect(out.indexOf("Known failure modes")).toBeLessThan(out.indexOf("<recall pointer block>"));
  });

  it("returns just the recall block when no failure modes", () => {
    expect(composeSessionStartOutput("", "<recall>")).toBe("<recall>");
  });

  it("returns just the failure-mode block when no recall hits", () => {
    expect(composeSessionStartOutput("## Known failure modes\n- x", "")).toBe("## Known failure modes\n- x");
  });

  it("returns empty when both empty", () => {
    expect(composeSessionStartOutput("", "")).toBe("");
  });
});
