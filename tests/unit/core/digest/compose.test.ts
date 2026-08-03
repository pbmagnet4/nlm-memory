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

  it("shows tier-b outcome coverage with the honest unobserved majority", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
      outcomeCoverage: { total: 10, held: 1, overturned: 1, builtUpon: 1, reDerivedLater: 0, unobserved: 7 },
    });
    expect(text).toContain(
      "tier-b outcomes (30d, 10 sessions): held 10% · overturned 10% · built-upon 10% · re-derived 0% · unobserved 70%",
    );
  });

  it("shows a no-data line when outcomeCoverage is absent", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
    });
    expect(text).toContain("tier-b outcomes (30d): no sessions ended in window");
  });

  it("shows a no-data line when outcomeCoverage.total is zero", () => {
    const text = composeDigest({
      stats: baseStats,
      recent: [],
      port: 3940,
      hookAlert: null,
      now: FIXED_NOW,
      outcomeCoverage: { total: 0, held: 0, overturned: 0, builtUpon: 0, reDerivedLater: 0, unobserved: 0 },
    });
    expect(text).toContain("tier-b outcomes (30d): no sessions ended in window");
  });

  describe("Jobs line", () => {
    it("shows no active job when job is absent (never started, or daemon restart mid-run)", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
      });
      expect(text).toContain("Jobs: no active job");
    });

    it("shows no active job when job is explicitly null", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: null,
      });
      expect(text).toContain("Jobs: no active job");
    });

    it("shows no active job for an idle snapshot", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "idle",
          processed: 0,
          total: 0,
          startedAt: null,
          lastAdvanceAt: null,
          restarts: 0,
          restartsTotal: 0,
        },
      });
      expect(text).toContain("Jobs: no active job");
    });

    it("shows a running job's progress and time since last advance", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "running",
          processed: 412,
          total: 664,
          startedAt: "2026-05-30T11:40:00Z",
          lastAdvanceAt: "2026-05-30T11:57:00Z", // 3m before FIXED_NOW (12:00:00Z)
          restarts: 0,
          restartsTotal: 0,
        },
      });
      expect(text).toContain("Jobs: reprocess 412/664, last advance 3m ago");
    });

    it("shows a running job with no progress yet, without a bogus timestamp", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "running",
          processed: 0,
          total: 664,
          startedAt: "2026-05-30T11:59:50Z",
          lastAdvanceAt: null,
          restarts: 0,
          restartsTotal: 0,
        },
      });
      expect(text).toContain("Jobs: reprocess 0/664, no progress yet");
    });

    it("appends a restart count to the running line once the run has OOM-churned, even though restarts (no-progress counter) has since reset", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "running",
          processed: 412,
          total: 664,
          startedAt: "2026-05-30T11:00:00Z",
          lastAdvanceAt: "2026-05-30T11:57:00Z",
          restarts: 0, // reset by a recent advance
          restartsTotal: 2, // but this run has respawned twice lifetime
        },
      });
      expect(text).toContain("Jobs: reprocess 412/664, last advance 3m ago, 2 restarts");
    });

    it("singularizes the running-line restart suffix when restartsTotal is exactly 1", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "running",
          processed: 100,
          total: 664,
          startedAt: "2026-05-30T11:00:00Z",
          lastAdvanceAt: "2026-05-30T11:57:00Z",
          restarts: 1,
          restartsTotal: 1,
        },
      });
      expect(text).toContain("Jobs: reprocess 100/664, last advance 3m ago, 1 restart");
      expect(text).not.toContain("1 restarts");
    });

    it("omits the restart suffix on the running line when restartsTotal is 0", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "running",
          processed: 412,
          total: 664,
          startedAt: "2026-05-30T11:40:00Z",
          lastAdvanceAt: "2026-05-30T11:57:00Z",
          restarts: 0,
          restartsTotal: 0,
        },
      });
      expect(text).not.toContain("restart");
    });

    it("shows a stalled job with progress and time since last advance", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "stalled",
          processed: 412,
          total: 664,
          startedAt: "2026-05-30T11:00:00Z",
          lastAdvanceAt: "2026-05-30T11:35:00Z", // 25m before FIXED_NOW
          restarts: 2,
          restartsTotal: 2,
        },
      });
      expect(text).toContain("Jobs: reprocess stalled at 412/664, last advance 25m ago");
    });

    it("shows a completed run's final tally", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "completed",
          processed: 664,
          total: 664,
          startedAt: "2026-05-30T10:00:00Z",
          lastAdvanceAt: "2026-05-30T11:50:00Z",
          restarts: 1,
          restartsTotal: 1,
        },
      });
      expect(text).toContain("Jobs: reprocess completed 664/664");
    });

    it("phrases an exhausted run so the restarts count can't be misread as restarts still to come", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "exhausted",
          processed: 412,
          total: 664,
          startedAt: "2026-05-30T10:00:00Z",
          lastAdvanceAt: "2026-05-30T11:30:00Z",
          restarts: 3,
          restartsTotal: 3,
        },
      });
      expect(text).toContain("Jobs: reprocess gave up after 3 fruitless restarts (412/664 processed)");
    });

    it("singularizes 'restart' when the exhausted count is exactly 1", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "exhausted",
          processed: 50,
          total: 664,
          startedAt: "2026-05-30T10:00:00Z",
          lastAdvanceAt: "2026-05-30T11:30:00Z",
          restarts: 1,
          restartsTotal: 1,
        },
      });
      expect(text).toContain("Jobs: reprocess gave up after 1 fruitless restart (50/664 processed)");
      expect(text).not.toContain("1 fruitless restarts");
    });

    it("shows a stopped run's tally at the point it was stopped", () => {
      const text = composeDigest({
        stats: baseStats,
        recent: [],
        port: 3940,
        hookAlert: null,
        now: FIXED_NOW,
        job: {
          name: "reprocess",
          state: "stopped",
          processed: 200,
          total: 664,
          startedAt: "2026-05-30T10:00:00Z",
          lastAdvanceAt: "2026-05-30T11:30:00Z",
          restarts: 0,
          restartsTotal: 0,
        },
      });
      expect(text).toContain("Jobs: reprocess stopped at 200/664");
    });
  });
});
