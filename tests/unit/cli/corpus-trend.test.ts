import { describe, expect, it } from "vitest";
import { shouldAppendTrend } from "../../../src/cli/nlm.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const now = Date.now();

describe("shouldAppendTrend", () => {
  it("returns true when lastLineTs is null (file absent)", () => {
    expect(shouldAppendTrend(null, now)).toBe(true);
  });

  it("returns true when lastLineTs is not a valid ISO string", () => {
    expect(shouldAppendTrend("not-a-date", now)).toBe(true);
  });

  it("returns false when last entry is less than 7 days ago", () => {
    const recent = new Date(now - SEVEN_DAYS_MS + 1000).toISOString();
    expect(shouldAppendTrend(recent, now)).toBe(false);
  });

  it("returns true when last entry is exactly 7 days ago", () => {
    const exactly7d = new Date(now - SEVEN_DAYS_MS).toISOString();
    expect(shouldAppendTrend(exactly7d, now)).toBe(true);
  });

  it("returns true when last entry is more than 7 days ago", () => {
    const old = new Date(now - SEVEN_DAYS_MS - 1000).toISOString();
    expect(shouldAppendTrend(old, now)).toBe(true);
  });
});
