import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRecencyConfig, recencyMultiplier, resetRecencyConfigForTest } from "../../../../src/core/recall/recency.js";

const NOW = Date.UTC(2026, 5, 4, 12, 0, 0); // 2026-06-04T12:00:00Z

function daysAgo(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString();
}

describe("recencyMultiplier — default config (180d half-life, 0.25 floor)", () => {
  beforeEach(() => {
    delete process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"];
    delete process.env["NLM_RECALL_DECAY_FLOOR"];
    resetRecencyConfigForTest();
  });
  afterEach(() => {
    resetRecencyConfigForTest();
  });

  it("returns 1.0 for a session started 'now'", () => {
    expect(recencyMultiplier(daysAgo(0), NOW)).toBeCloseTo(1.0, 4);
  });

  it("returns ~0.5 for a session started one half-life ago (180d)", () => {
    expect(recencyMultiplier(daysAgo(180), NOW)).toBeCloseTo(0.5, 3);
  });

  it("returns ~0.25 for a session started two half-lives ago (360d)", () => {
    // 2^-2 = 0.25, equal to the floor — should still return 0.25
    expect(recencyMultiplier(daysAgo(360), NOW)).toBeCloseTo(0.25, 3);
  });

  it("clamps to the 0.25 floor for very old sessions", () => {
    expect(recencyMultiplier(daysAgo(3650), NOW)).toBeCloseTo(0.25, 4);
  });

  it("clamps to 1.0 for sessions in the future (clock skew)", () => {
    expect(recencyMultiplier(daysAgo(-7), NOW)).toBe(1.0);
  });

  it("returns 1.0 for missing startedAt", () => {
    expect(recencyMultiplier(null, NOW)).toBe(1.0);
    expect(recencyMultiplier(undefined, NOW)).toBe(1.0);
    expect(recencyMultiplier("", NOW)).toBe(1.0);
  });

  it("returns 1.0 for unparseable startedAt", () => {
    expect(recencyMultiplier("not-a-date", NOW)).toBe(1.0);
  });

  it("is monotonically decreasing with age (newer scores higher)", () => {
    const a = recencyMultiplier(daysAgo(7), NOW);
    const b = recencyMultiplier(daysAgo(30), NOW);
    const c = recencyMultiplier(daysAgo(90), NOW);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
});

describe("recencyMultiplier — env var overrides", () => {
  beforeEach(() => {
    delete process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"];
    delete process.env["NLM_RECALL_DECAY_FLOOR"];
    resetRecencyConfigForTest();
  });
  afterEach(() => {
    delete process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"];
    delete process.env["NLM_RECALL_DECAY_FLOOR"];
    resetRecencyConfigForTest();
  });

  it("disables decay when HALF_LIFE_DAYS=0", () => {
    process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"] = "0";
    resetRecencyConfigForTest();
    expect(recencyMultiplier(daysAgo(0), NOW)).toBe(1.0);
    expect(recencyMultiplier(daysAgo(365), NOW)).toBe(1.0);
    expect(recencyMultiplier(daysAgo(3650), NOW)).toBe(1.0);
    expect(getRecencyConfig().disabled).toBe(true);
  });

  it("honors a custom half-life", () => {
    process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"] = "30";
    resetRecencyConfigForTest();
    expect(recencyMultiplier(daysAgo(30), NOW)).toBeCloseTo(0.5, 3);
    expect(recencyMultiplier(daysAgo(60), NOW)).toBeCloseTo(0.25, 3);
  });

  it("honors a custom floor", () => {
    process.env["NLM_RECALL_DECAY_FLOOR"] = "0.5";
    resetRecencyConfigForTest();
    // 365d at default 180d half-life would be 0.25, but floor=0.5 clamps it up
    expect(recencyMultiplier(daysAgo(365), NOW)).toBeCloseTo(0.5, 3);
  });

  it("ignores nonsense half-life values, falls back to default", () => {
    process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"] = "not-a-number";
    resetRecencyConfigForTest();
    expect(recencyMultiplier(daysAgo(180), NOW)).toBeCloseTo(0.5, 3);
  });

  it("ignores out-of-range floor, falls back to default", () => {
    process.env["NLM_RECALL_DECAY_FLOOR"] = "2.0";
    resetRecencyConfigForTest();
    expect(getRecencyConfig().floor).toBeCloseTo(0.25, 4);
  });
});
