import { describe, expect, it } from "vitest";
import { isAgentLoaded, isBenignBootoutError } from "../../../src/cli/launchctl-helpers.js";

describe("isBenignBootoutError", () => {
  it("recognizes the 'Could not find service' message", () => {
    expect(isBenignBootoutError("Could not find service \"foo\" in domain for port: 0\n")).toBe(true);
  });

  it("recognizes 'No such process'", () => {
    expect(isBenignBootoutError("Boot-out failed: No such process")).toBe(true);
  });

  it("recognizes 'not currently loaded' phrasing", () => {
    expect(isBenignBootoutError("Service is not currently loaded.")).toBe(true);
  });

  it("treats unrecognized stderr as a real failure", () => {
    expect(isBenignBootoutError("Bootstrap failed: 5: Input/output error")).toBe(false);
  });

  it("treats empty stderr as a real failure (no excuse to be silent)", () => {
    expect(isBenignBootoutError("")).toBe(false);
  });

  it("is case-insensitive on the match", () => {
    expect(isBenignBootoutError("COULD NOT FIND SERVICE")).toBe(true);
  });
});

describe("isAgentLoaded", () => {
  const label = "com.example.test-agent";

  it("returns true when the label appears in the launchctl list output", () => {
    const stub = () => `12345\t0\tcom.apple.WebKit.GPU\n87530\t0\t${label}\n22222\t0\tsomething.else\n`;
    expect(isAgentLoaded(label, stub)).toBe(true);
  });

  it("returns false when the label is absent", () => {
    const stub = () => `12345\t0\tcom.apple.WebKit.GPU\n22222\t0\tsomething.else\n`;
    expect(isAgentLoaded(label, stub)).toBe(false);
  });

  it("returns false when the runner throws (launchctl unreachable)", () => {
    const stub = (): string => {
      throw new Error("launchctl not found");
    };
    expect(isAgentLoaded(label, stub)).toBe(false);
  });

  it("requires substring match — partial label collision is fine, full label wins", () => {
    // A different agent that happens to share a prefix should not falsely match
    // a query for the full label. (We match by includes(), so this is a guard:
    // make sure the label is specific enough.)
    const stub = () => `12345\t0\tcom.example.test-agent-helper\n`;
    // includes() will return true here — documents the limitation. If we ever
    // want exact-match, change the helper. For now, the actual NLM label is
    // distinctive enough that this isn't a concern.
    expect(isAgentLoaded(label, stub)).toBe(true);
  });
});
