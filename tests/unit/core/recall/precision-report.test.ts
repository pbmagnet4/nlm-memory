import { describe, expect, it } from "vitest";
import { formatPrecisionReport } from "../../../../src/core/recall/precision.js";

const blended = { precisionAtK: 0, conversationCount: 203, perConversation: [] };
const perSource = [
  { source: "session-start-hook", precision: 0, conversationCount: 380 },
  { source: "mcp", precision: 0.066, conversationCount: 89 },
];

describe("formatPrecisionReport", () => {
  const lines = formatPrecisionReport(30, blended, perSource, ["http"], false);
  const text = lines.join("\n");

  it("leads with per-source rows and gives each known source an expectation note", () => {
    expect(text.indexOf("Per source")).toBeLessThan(text.indexOf("Blended"));
    expect(text).toContain("structurally rarely cited");
    expect(text).toContain("the lane that carries value");
  });

  it("labels the blended figure informational", () => {
    expect(text).toMatch(/Blended \(informational[^)]*\): 0\.0%/);
  });

  it("lists unmeasurable sources and handles an empty hook log", () => {
    expect(text).toContain("Unmeasurable (no conversation id captured): http");
    const empty = formatPrecisionReport(7, { ...blended, precisionAtK: null }, [], [], true).join("\n");
    expect(empty).toContain("Blended (informational): no hook-lane conversations");
    expect(empty).toContain("nlm help close-loop");
  });
});
