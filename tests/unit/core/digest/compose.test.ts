import { describe, it, expect } from "vitest";
import { composeDigest } from "@core/digest/compose.js";

const FIXED_NOW = new Date("2026-05-30T07:00:00-05:00");

// isProbe is tested in tests/unit/core/telemetry/probe-filter.test.ts

describe("composeDigest", () => {
  const baseStats = {
    total: 100,
    hit_rate: 0.85,
    top_queries: [
      { query: "deployment plan", count: 12 },
      { query: "smoke run", count: 3 }, // probe
    ],
  };

  it("formats the digest with 24h slice and 7d totals", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-30T05:00:00Z", source: "claude-code", query: "deployment plan" },
        { ts: "2026-05-30T04:00:00Z", source: "claude-code", query: "deployment plan" },
        { ts: "2026-05-29T15:00:00Z", source: "hermes", query: "what's blocked" },
        { ts: "2026-05-29T14:00:00Z", source: "claude-code", query: "smoke test" }, // probe
        { ts: "2026-05-28T10:00:00Z", source: "claude-code", query: "old entry" }, // outside 24h
      ],
      port: 3940,
      hookAlert: null,
      precision: { precisionAtK: 0.4, conversationCount: 45 },
      now: FIXED_NOW,
    });

    expect(text).toContain("Last 24h (real traffic): 3 queries");
    expect(text).toContain("claude-code=2");
    expect(text).toContain("hermes=1");
    expect(text).toContain("Last 7d: 97 real / 100 total"); // 100 - 3 probes
    // The surfacing rate must be labeled as surfacing, not "hit_rate" (which
    // reads like precision). True cited-precision is shown on its own line.
    expect(text).toContain("surfaced 85%");
    expect(text).not.toContain("hit_rate");
    expect(text).toContain("Recall precision (cited/surfaced): 40% (45 conv)");
    expect(text).toContain("1. deployment plan");
    expect(text).toContain("UI: http://localhost:3940/ui/");
  });

  it("shows precision n/a when no conversations are scoreable", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: null,
      precision: { precisionAtK: null, conversationCount: 0 },
      now: FIXED_NOW,
    });
    expect(text).toContain("Recall precision (cited/surfaced): n/a");
    expect(text).not.toContain("hit_rate");
  });

  it("renders (none) when no real 24h traffic", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-28T10:00:00Z", source: "claude-code", query: "old entry" },
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    expect(text).toContain("Last 24h (real traffic): 0 queries · none");
    expect(text).toContain("  (none)");
  });

  it("prepends hook alert when supplied", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: "WARN hook silent: 5 CC sessions, 0 fires",
      now: FIXED_NOW,
    });
    const alertIdx = text.indexOf("WARN hook silent");
    const trafficIdx = text.indexOf("Last 24h");
    expect(alertIdx).toBeGreaterThan(0);
    expect(alertIdx).toBeLessThan(trafficIdx);
  });

  it("truncates top queries longer than 80 chars with an ellipsis", () => {
    const longQuery = "a".repeat(120);
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-30T05:00:00Z", source: "x", query: longQuery },
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    expect(text).toContain(`1. ${"a".repeat(80)}…\n`);
    expect(text).not.toContain("a".repeat(81));
  });

  it("truncates at a word boundary when one falls late in the budget", () => {
    const longQuery = `${"word ".repeat(14)}straggler-that-would-be-chopped-midway`;
    const text = composeDigest({
      stats: baseStats,
      recent: [
        { ts: "2026-05-30T05:00:00Z", source: "x", query: longQuery },
      ],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    const line = text.split("\n").find((l) => l.includes("1. "));
    expect(line).toMatch(/…$/);
    expect(line).not.toMatch(/\bstraggler-[a-z-]*…$/);
  });
});
