// tests/unit/hook/recall-over-http.test.ts
import { describe, expect, it } from "vitest";
import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";
import { parseRecallTimeout } from "../../../src/hook/recall-over-http.js";

describe("parseRecallTimeout", () => {
  it("defaults to 4000 when env is unset", () => {
    expect(parseRecallTimeout(undefined)).toBe(4000);
  });

  it("parses a valid ms override", () => {
    expect(parseRecallTimeout("5000")).toBe(5000);
  });

  it("falls back to 4000 for non-numeric input", () => {
    expect(parseRecallTimeout("garbage")).toBe(4000);
  });

  it("falls back to 4000 for zero or negative values", () => {
    expect(parseRecallTimeout("0")).toBe(4000);
    expect(parseRecallTimeout("-500")).toBe(4000);
  });
});

describe("recall-over-http query filtering", () => {
  it("extractRecallQuery returns null for short conversational prompts", () => {
    expect(extractRecallQuery("yes please")).toBeNull();
    expect(extractRecallQuery("ok")).toBeNull();
    expect(extractRecallQuery("proceed")).toBeNull();
  });

  it("extractRecallQuery returns a non-empty string for technical prompts", () => {
    const q = extractRecallQuery("nlm-memory dependency upgrade Wave 2");
    expect(typeof q).toBe("string");
    expect((q as string).length).toBeGreaterThan(0);
  });
});
