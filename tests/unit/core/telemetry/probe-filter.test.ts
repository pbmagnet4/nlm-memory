import { describe, it, expect } from "vitest";
import { isProbe, PROBE_EXACT_QUERIES, PROBE_SUBSTRINGS } from "@core/telemetry/probe-filter.js";

describe("isProbe - exact match", () => {
  it("strips bare pgvector (exact match)", () => {
    expect(isProbe("pgvector")).toBe(true);
  });

  it("does NOT strip pgvector as a substring of a longer query", () => {
    // "pgvector" lives in PROBE_EXACT_QUERIES only; it is not in PROBE_SUBSTRINGS.
    expect(isProbe("pgvector performance tuning")).toBe(false);
  });

  it("strips bare 'x' (exact match -- too short for substring)", () => {
    expect(isProbe("x")).toBe(true);
  });

  it("strips empty string (exact match)", () => {
    expect(isProbe("")).toBe(true);
  });

  it("strips with leading/trailing whitespace (trim before match)", () => {
    expect(isProbe(" x ")).toBe(true);
  });
});

describe("isProbe - substring match", () => {
  it("strips bare 'probe' (substring match on itself)", () => {
    expect(isProbe("probe")).toBe(true);
  });

  it("strips a query containing 'probe' as a substring -- accepted trade-off", () => {
    // "how did we probe the API" is stripped because PROBE_SUBSTRINGS includes
    // "probe". This is an intentional trade-off: probe traffic is always labelled
    // with the bare word, so the false-positive rate is acceptable.
    expect(isProbe("how did we probe the API")).toBe(true);
  });

  it("strips 'smoke test' (contains 'smoke')", () => {
    expect(isProbe("smoke test")).toBe(true);
  });

  it("is case-insensitive (SMOKE -> stripped)", () => {
    expect(isProbe("SMOKE")).toBe(true);
  });

  it("strips concurrency probe (contains 'probe')", () => {
    expect(isProbe("Concurrency Probe baseline")).toBe(true);
  });

  it("strips test probe (contains 'probe')", () => {
    expect(isProbe("test probe")).toBe(true);
  });

  it("strips beacon (contains 'beacon')", () => {
    expect(isProbe("beacon check")).toBe(true);
  });

  it("strips cutover-test (contains 'cutover-test')", () => {
    expect(isProbe("cutover-test Jan")).toBe(true);
  });
});

describe("isProbe - real queries pass through", () => {
  it("does not strip a real agent query about deployment", () => {
    expect(isProbe("real user query about deployment")).toBe(false);
  });

  it("does not strip a query containing 'hono' as a substring", () => {
    // "hono" is exact-only; "hono router middleware" is a real query.
    expect(isProbe("hono router middleware")).toBe(false);
  });
});

describe("isProbe - null / undefined", () => {
  it("returns false for null", () => {
    expect(isProbe(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isProbe(undefined)).toBe(false);
  });
});

describe("PROBE_EXACT_QUERIES set membership", () => {
  it("contains the expected exact-match entries", () => {
    expect(PROBE_EXACT_QUERIES.has("pgvector")).toBe(true);
    expect(PROBE_EXACT_QUERIES.has("hono")).toBe(true);
    expect(PROBE_EXACT_QUERIES.has("x")).toBe(true);
    expect(PROBE_EXACT_QUERIES.has("")).toBe(true);
  });
});

describe("PROBE_SUBSTRINGS minimal list", () => {
  it("contains 'probe' and does not redundantly contain 'concurrency probe' or 'test probe'", () => {
    expect(PROBE_SUBSTRINGS).toContain("probe");
    expect(PROBE_SUBSTRINGS).not.toContain("concurrency probe");
    expect(PROBE_SUBSTRINGS).not.toContain("test probe");
  });
});
