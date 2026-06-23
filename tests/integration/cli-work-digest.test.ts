import { describe, expect, it } from "vitest";
import { resolveDigestDate } from "../../src/cli/nlm.js";

describe("resolveDigestDate", () => {
  it("returns the provided date when valid", () => {
    expect(resolveDigestDate("2026-06-23")).toBe("2026-06-23");
  });

  it("throws on a malformed date", () => {
    expect(() => resolveDigestDate("June 23")).toThrow();
  });

  it("returns a YYYY-MM-DD string for today when omitted", () => {
    expect(resolveDigestDate(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
