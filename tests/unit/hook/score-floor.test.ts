import { describe, expect, it } from "vitest";
import { parseScoreFloor } from "../../../src/hook/score-floor.js";

describe("parseScoreFloor", () => {
  it("defaults to 0 when the env var is unset", () => {
    expect(parseScoreFloor(undefined)).toBe(0);
  });

  it("parses a valid numeric string", () => {
    expect(parseScoreFloor("2")).toBe(2);
    expect(parseScoreFloor("2.5")).toBe(2.5);
    expect(parseScoreFloor("0")).toBe(0);
  });

  it("falls back to 0 on a non-numeric value (NaN guard)", () => {
    expect(parseScoreFloor("abc")).toBe(0);
    expect(parseScoreFloor("")).toBe(0);
    expect(parseScoreFloor("  ")).toBe(0);
    expect(parseScoreFloor("NaN")).toBe(0);
  });

  it("falls back to 0 on non-finite values", () => {
    expect(parseScoreFloor("Infinity")).toBe(0);
    expect(parseScoreFloor("-Infinity")).toBe(0);
  });

  it("clamps negative floors to 0 (never deny-all via negatives, never admit-all surprise)", () => {
    expect(parseScoreFloor("-5")).toBe(0);
  });
});
