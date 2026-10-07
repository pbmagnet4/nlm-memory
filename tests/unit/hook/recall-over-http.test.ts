// tests/unit/hook/recall-over-http.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";
import { parseRecallTimeout, recallOverHttp } from "../../../src/hook/recall-over-http.js";

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

describe("recallOverHttp relatedConcepts mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => body } as Response;
    });
    return urls;
  }

  it("maps relatedConcepts and requests withConcepts", async () => {
    const urls = stubFetch({
      results: [],
      relatedConcepts: [
        { concept: "math.chain-rule", status: "practicing", attemptCount: 2, nextStep: "Compare." },
      ],
    });
    const res = await recallOverHttp("nlm-memory dependency upgrade Wave 2");
    expect(urls[0]).toContain("withConcepts=true");
    expect(res.concepts).toEqual([
      { concept: "math.chain-rule", status: "practicing", attemptCount: 2, nextStep: "Compare." },
    ]);
    expect(res.outcome).toBe("ok");
  });

  it("tolerates old servers without the field", async () => {
    stubFetch({ results: [] });
    const res = await recallOverHttp("nlm-memory dependency upgrade Wave 2");
    expect(res.concepts).toEqual([]);
    expect(res.outcome).toBe("ok");
  });
});
