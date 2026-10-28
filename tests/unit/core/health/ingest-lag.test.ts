import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";
import {
  recordClassifyFailure,
  recordClassifySuccess,
  recordIngestProgress,
  resetClassifyOutcomes,
} from "../../../../src/core/health/classify-outcomes.js";
import {
  computeIngestLag,
  createIngestLagMonitor,
  ingestLagThresholdHours,
  LOOKBACK_MS,
  type AdapterStateEntry,
  type IngestLagDeps,
} from "../../../../src/core/health/ingest-lag.js";
import { MAX_CLASSIFY_FAILURES } from "../../../../src/core/scheduler/scan-once.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-27T12:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nlm-lag-"));
  resetClassifyOutcomes(NOW - 10 * HOUR);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, size: number, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(size));
  const t = (NOW - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

function adapter(name: string, paths: string[]): TranscriptAdapter {
  return { name, discover: async () => paths } as unknown as TranscriptAdapter;
}

function deps(
  adapters: TranscriptAdapter[],
  state: Record<string, Record<string, AdapterStateEntry>> = {},
  thresholdHours = 6,
): IngestLagDeps {
  return {
    listAdapters: async () => adapters,
    readState: async (name) => new Map(Object.entries(state[name] ?? {})),
    idleMinutes: 15,
    thresholdHours,
    schedulerIntervalMs: 30 * 60_000,
  };
}

describe("computeIngestLag", () => {
  it("counts unseen and grown files as pending, parked files apart, and finds the oldest", async () => {
    const unseen = file("unseen", 10, 3 * HOUR);
    const grown = file("grown", 20, 1 * HOUR);
    const done = file("done", 30, 2 * HOUR);
    const parked = file("parked", 40, 5 * HOUR);
    const parkedGrown = file("parked-grown", 50, 4 * HOUR);
    const active = file("active", 5, 60_000);
    recordClassifySuccess(NOW - 1000);
    recordIngestProgress(NOW - 1000);
    const report = await computeIngestLag(
      deps(
        [adapter("claude-code", [unseen, grown, done, parked, parkedGrown, active])],
        {
          "claude-code": {
            [grown]: { fileSize: 5, failureCount: 0 },
            [done]: { fileSize: 30, failureCount: 0 },
            [parked]: { fileSize: 40, failureCount: MAX_CLASSIFY_FAILURES },
            [parkedGrown]: { fileSize: 7, failureCount: MAX_CLASSIFY_FAILURES },
          },
        },
      ),
      NOW,
    );
    expect(report.adapters["claude-code"]).toEqual({
      pending: 3,
      parked: 1,
      unreadable: 0,
      oldest_pending_at: new Date(NOW - 4 * HOUR).toISOString(),
    });
    expect(report.lagging).toBe(false);
    expect(report.summary).toBe("3 pending, oldest 4h, 1 ok/1h");
  });

  it("reports per adapter and ignores vanished files", async () => {
    const a = file("a", 1, 2 * HOUR);
    const b = file("b", 1, 3 * HOUR);
    const report = await computeIngestLag(
      deps([adapter("pi", [a, join(dir, "gone")]), adapter("codex", [b])]),
      NOW,
    );
    expect(report.adapters["pi"]?.pending).toBe(1);
    expect(report.adapters["codex"]?.oldest_pending_at).toBe(new Date(NOW - 3 * HOUR).toISOString());
  });

  it("asks the adapter only for files modified inside the lookback window", async () => {
    let since: Date | undefined;
    const spy = {
      name: "pi",
      discover: async (o?: { since?: Date }) => {
        since = o?.since;
        return [];
      },
    } as unknown as TranscriptAdapter;
    await computeIngestLag(deps([spy]), NOW);
    expect(since?.getTime()).toBe(NOW - LOOKBACK_MS);
  });

  it("aggregates sources that share an adapter name", async () => {
    const a = file("a", 1, 2 * HOUR);
    const b = file("b", 1, 3 * HOUR);
    const c = file("c", 1, 1 * HOUR);
    const report = await computeIngestLag(
      deps([adapter("hermes-agent", [a, c]), adapter("hermes-agent", [b])]),
      NOW,
    );
    expect(report.adapters["hermes-agent"]).toEqual({
      pending: 3,
      parked: 0,
      unreadable: 0,
      oldest_pending_at: new Date(NOW - 3 * HOUR).toISOString(),
    });
  });

  it("counts a source whose stat throws as unreadable without failing the pass", async () => {
    const a = file("a", 1, 2 * HOUR);
    const flaky = {
      name: "hermes-agent",
      discover: async () => ["bad", a],
      stat: (p: string) => {
        if (p === "bad") throw new Error("database is locked");
        return { mtimeMs: NOW - 2 * HOUR, size: 1 };
      },
    } as unknown as TranscriptAdapter;
    const report = await computeIngestLag(deps([flaky]), NOW);
    expect(report.adapters["hermes-agent"]).toMatchObject({ pending: 1, unreadable: 1 });
    expect(report.summary).toBe("1 pending, oldest 2h, 0 ok/1h, 1 unreadable");
  });

  it("is caught up with no pending files", async () => {
    const report = await computeIngestLag(deps([adapter("pi", [])]), NOW);
    expect(report).toMatchObject({ lagging: false, last_success_at: null, summary: "0 pending, 0 ok/1h" });
  });

  describe("lagging thresholds", () => {
    it("is not lagging when the oldest pending file is exactly at the threshold", async () => {
      recordIngestProgress(NOW - 1000);
      const f = file("f", 1, 6 * HOUR);
      expect((await computeIngestLag(deps([adapter("pi", [f])]), NOW)).lagging).toBe(false);
    });

    it("is lagging when the oldest pending file is past the threshold", async () => {
      recordIngestProgress(NOW - 1000);
      const f = file("f", 1, 6 * HOUR + 1000);
      expect((await computeIngestLag(deps([adapter("pi", [f])]), NOW)).lagging).toBe(true);
    });

    it("honors a custom threshold", async () => {
      recordIngestProgress(NOW - 1000);
      const f = file("f", 1, 2 * HOUR);
      expect((await computeIngestLag(deps([adapter("pi", [f])], {}, 1), NOW)).lagging).toBe(true);
    });

    it("is lagging when a file has waited three ticks and there was no progress for three ticks", async () => {
      recordIngestProgress(NOW - 90 * 60_000 - 1000);
      const f = file("f", 1, 2 * HOUR);
      expect((await computeIngestLag(deps([adapter("pi", [f])]), NOW)).lagging).toBe(true);
    });

    it("is not lagging when progress is within three ticks", async () => {
      recordIngestProgress(NOW - 90 * 60_000 + 1000);
      const f = file("f", 1, 2 * HOUR);
      expect((await computeIngestLag(deps([adapter("pi", [f])]), NOW)).lagging).toBe(false);
    });

    it("does not read a quiet period followed by one new session as lagging", async () => {
      recordIngestProgress(NOW - 8 * HOUR);
      const f = file("f", 1, 20 * 60_000);
      const report = await computeIngestLag(deps([adapter("pi", [f])]), NOW);
      expect(report.adapters["pi"]?.pending).toBe(1);
      expect(report.lagging).toBe(false);
    });

    it("does not read gate-skip-only activity as stalled", async () => {
      recordClassifySuccess(NOW - 3 * HOUR);
      recordIngestProgress(NOW - 60_000);
      const f = file("f", 1, 1 * HOUR);
      const report = await computeIngestLag(deps([adapter("pi", [f])]), NOW);
      expect(report.lagging).toBe(false);
      expect(report.last_progress_at).toBe(new Date(NOW - 60_000).toISOString());
      expect(report.last_success_at).toBe(new Date(NOW - 3 * HOUR).toISOString());
    });

    it("gives a freshly started daemon an hour before 'no success' counts", async () => {
      resetClassifyOutcomes(NOW - 10 * 60_000);
      const f = file("f", 1, 1 * HOUR);
      expect((await computeIngestLag(deps([adapter("pi", [f])]), NOW)).lagging).toBe(false);
    });
  });

  it("reports rolling-window failure counts and the last success", async () => {
    recordClassifySuccess(NOW - 30 * 60_000);
    recordClassifyFailure("timeout", NOW - 2 * HOUR);
    recordClassifyFailure("timeout", NOW - 10 * 60_000);
    recordClassifyFailure("error", NOW - 5 * 60_000);
    const report = await computeIngestLag(deps([]), NOW);
    expect(report.timeouts_1h).toBe(1);
    expect(report.errors_1h).toBe(1);
    expect(report.last_success_at).toBe(new Date(NOW - 30 * 60_000).toISOString());
  });
});

describe("createIngestLagMonitor", () => {
  it("serves the cached report for 60s, then recomputes", async () => {
    let calls = 0;
    let now = NOW;
    const monitor = createIngestLagMonitor(
      { ...deps([]), listAdapters: async () => { calls += 1; return []; } },
      () => now,
    );
    await monitor.get();
    now += 59_000;
    await monitor.get();
    expect(calls).toBe(1);
    now += 2_000;
    await monitor.get();
    expect(calls).toBe(2);
  });
});

describe("ingestLagThresholdHours", () => {
  it("defaults to 6 and rejects junk", () => {
    expect(ingestLagThresholdHours({})).toBe(6);
    expect(ingestLagThresholdHours({ NLM_INGEST_LAG_ALERT_HOURS: "abc" })).toBe(6);
    expect(ingestLagThresholdHours({ NLM_INGEST_LAG_ALERT_HOURS: "-1" })).toBe(6);
    expect(ingestLagThresholdHours({ NLM_INGEST_LAG_ALERT_HOURS: "12" })).toBe(12);
  });
});
