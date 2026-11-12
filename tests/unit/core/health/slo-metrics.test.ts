import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSloMetricsStore,
  parseHookRecord,
  pruneSloState,
  computeSloActual,
  computeIngestSample,
  buildSloResponse,
  p95,
  SLO_TARGETS,
  type SloState,
} from "../../../../src/core/health/slo-metrics.js";
import type { IngestLagReport } from "../../../../src/core/health/ingest-lag.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 1, 5, 12, 0, 0, 0);

function hookLine(tsMs: number, outcome: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    conversationId: "c1",
    promptPreview: "p",
    gate: "evaluate",
    hits: [],
    wouldInject: [],
    estTokens: 1,
    mode: "live",
    recallOutcome: outcome,
    ...extra,
  });
}

describe("parseHookRecord", () => {
  it("accepts kind-less records carrying a known recallOutcome", () => {
    const ev = parseHookRecord(hookLine(NOW, "timeout"));
    expect(ev).toEqual({ ts: NOW, outcome: "timeout" });
  });

  it("captures latencyMs samples, ignores junk latencies", () => {
    expect(parseHookRecord(hookLine(NOW, "ok", { latencyMs: 412 }))).toEqual({
      ts: NOW,
      outcome: "ok",
      latencyMs: 412,
    });
    expect(parseHookRecord(hookLine(NOW, "ok", { latencyMs: "3ms" }))).toEqual({ ts: NOW, outcome: "ok" });
    expect(parseHookRecord(hookLine(NOW, "ok", { latencyMs: -1 }))).toEqual({ ts: NOW, outcome: "ok" });
  });

  it("skips kind-carrying entries, unknown outcomes, malformed and foreign lines", () => {
    expect(parseHookRecord(JSON.stringify({ ts: new Date(NOW).toISOString(), kind: "stop", recallOutcome: "timeout" }))).toBeNull();
    expect(parseHookRecord(hookLine(NOW, "exploded"))).toBeNull();
    expect(parseHookRecord("{not json")).toBeNull();
    expect(parseHookRecord("")).toBeNull();
    expect(parseHookRecord(JSON.stringify({ conversationId: "c", recallOutcome: "ok" }))).toBeNull();
  });
});

describe("p95", () => {
  it("nearest-rank, single sample, empty", () => {
    expect(p95([])).toBeNull();
    expect(p95([12])).toBe(12);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});

describe("rolling windows", () => {
  const state: SloState = {
    savedAt: NOW,
    recall: [
      { ts: NOW - 1 * HOUR, outcome: "ok" },
      { ts: NOW - 2 * HOUR, outcome: "timeout" },
      { ts: NOW - 3 * DAY, outcome: "ok", latencyMs: 1200 },
      { ts: NOW - 8 * DAY, outcome: "timeout" }, // outside 7d
    ],
    stalls: [
      { ts: NOW - 5 * HOUR, ms: 320 },
      { ts: NOW - 3 * DAY, ms: 260 },
      { ts: NOW - 8 * DAY, ms: 900 },
    ],
    ingest: {
      sampledAt: NOW - 60_000,
      lagMinutes: 3.5,
      classifyLagMinutes: 2,
      lagging: false,
      timeouts1h: 1,
      summary: "7 pending",
    },
  };

  it("24h window excludes older events; 7d keeps them; 8d never counts", () => {
    const d1 = computeSloActual(state, "24h", NOW);
    expect(d1.outcomes.total).toBe(2);
    expect(d1.outcomes.timeoutRate).toBe(0.5); // 1 of 2 timed out
    expect(d1.stalls).toEqual({ count: 1, maxMs: 320 });
    expect(d1.recallLatency).toEqual({ samples: 0, p95Ms: null });

    const d7 = computeSloActual(state, "7d", NOW);
    expect(d7.outcomes.total).toBe(3);
    expect(d7.outcomes.timeoutRate).toBeCloseTo(1 / 3, 4);
    expect(d7.stalls).toEqual({ count: 2, maxMs: 320 });
    expect(d7.recallLatency).toEqual({ samples: 1, p95Ms: 1200 });
  });

  it("outcome counts are exact per kind", () => {
    const s: SloState = {
      ...state,
      recall: [
        { ts: NOW - HOUR, outcome: "unreachable" },
        { ts: NOW - HOUR, outcome: "http-error" },
        { ts: NOW - HOUR, outcome: "skipped" },
      ],
    };
    const a = computeSloActual(s, "24h", NOW);
    expect(a.outcomes.byOutcome).toEqual({ ok: 0, timeout: 0, unreachable: 1, "http-error": 1, skipped: 1 });
    expect(a.outcomes.timeoutRate).toBe(0);
  });

  it("an ingest gauge sampled outside the window reads as missing", () => {
    const stale = computeSloActual({ ...state, ingest: { ...state.ingest!, sampledAt: NOW - 2 * DAY } }, "24h", NOW);
    expect(stale.ingest).toBeNull();
    const fresh7 = computeSloActual({ ...state, ingest: { ...state.ingest!, sampledAt: NOW - 2 * DAY } }, "7d", NOW);
    expect(fresh7.ingest?.lagMinutes).toBe(3.5);
  });

  it("pruneSloState drops past-7d events, keeps the rest", () => {
    const p = pruneSloState(state, NOW);
    expect(p.recall).toHaveLength(3);
    expect(p.stalls).toHaveLength(2);
  });
});

describe("buildSloResponse", () => {
  it("reports targets, actuals and every breached name", () => {
    const state: SloState = {
      savedAt: NOW,
      recall: [
        { ts: NOW - HOUR, outcome: "timeout" },
        { ts: NOW - HOUR, outcome: "ok", latencyMs: 1500 },
      ],
      stalls: [{ ts: NOW - HOUR, ms: 900 }],
      ingest: { sampledAt: NOW - 1000, lagMinutes: 40, classifyLagMinutes: 30, lagging: true, timeouts1h: 2, summary: "s" },
    };
    const res = buildSloResponse(state, "24h", NOW);
    expect(res.window).toBe("24h");
    expect(res.targets).toBe(SLO_TARGETS);
    expect(res.breaches).toEqual(["timeoutRate", "recallP95Ms", "maxStallMs", "lagMinutes"]);
  });

  it("no outcomes / no latency / no stalls / no ingest -> nothing breaches", () => {
    const res = buildSloResponse({ savedAt: 0, recall: [], stalls: [], ingest: null }, "7d", NOW);
    expect(res.breaches).toEqual([]);
    expect(res.actual.outcomes.timeoutRate).toBeNull();
    expect(res.actual.recallLatency.p95Ms).toBeNull();
    expect(res.actual.stalls).toEqual({ count: 0, maxMs: null });
    expect(res.actual.ingest).toBeNull();
  });
});

describe("computeIngestSample", () => {
  it("reduces an ingest report to minute gauges", () => {
    const report: IngestLagReport = {
      adapters: {
        claude: { pending: 2, parked: 0, unreadable: 0, oldest_pending_at: new Date(NOW - 10 * 60_000).toISOString() },
        codex: { pending: 1, parked: 0, unreadable: 0, oldest_pending_at: new Date(NOW - 25 * 60_000).toISOString() },
      },
      last_success_at: new Date(NOW - 60_000).toISOString(),
      last_progress_at: new Date(NOW - 4 * 60_000).toISOString(),
      timeouts_1h: 3,
      errors_1h: 0,
      lagging: true,
      summary: "3 pending, oldest 25m, 5 ok/1h",
    };
    expect(computeIngestSample(report, NOW)).toEqual({
      sampledAt: NOW,
      lagMinutes: 25,
      classifyLagMinutes: 4,
      lagging: true,
      timeouts1h: 3,
      summary: report.summary,
    });
  });

  it("no pending files -> lagMinutes null; no progress ever -> classify lag null", () => {
    const empty: IngestLagReport = {
      adapters: {},
      last_success_at: null,
      last_progress_at: null,
      timeouts_1h: 0,
      errors_1h: 0,
      lagging: false,
      summary: "0 pending, 0 ok/1h",
    };
    const s = computeIngestSample(empty, NOW);
    expect(s.lagMinutes).toBeNull();
    expect(s.classifyLagMinutes).toBeNull();
  });
});

describe("createSloMetricsStore — tail reading", () => {
  let tmp: string;
  let logPath: string;
  let statePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-slo-"));
    logPath = join(tmp, "hook-log.jsonl");
    statePath = join(tmp, "slo-metrics.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function store() {
    return createSloMetricsStore({ hookLogPath: logPath, statePath, now: () => NOW });
  }

  it("consumes new records incrementally by byte offset", () => {
    writeFileSync(logPath, [hookLine(NOW - HOUR, "ok"), hookLine(NOW - HOUR, "timeout")].join("\n") + "\n", "utf8");
    const s = store();
    expect(s.pollHookLog()).toBe(2);
    expect(s.pollHookLog()).toBe(0); // nothing new
    appendFileSync(logPath, hookLine(NOW - 60_000, "ok") + "\n", "utf8");
    expect(s.pollHookLog()).toBe(1); // only the appended line
    expect(s.snapshot().recall).toHaveLength(3);
  });

  it("holds back a partial trailing line until it is completed", () => {
    const line = hookLine(NOW - HOUR, "ok");
    writeFileSync(logPath, line.slice(0, 40), "utf8"); // mid-append
    const s = store();
    expect(s.pollHookLog()).toBe(0);
    appendFileSync(logPath, line.slice(40) + "\n", "utf8");
    expect(s.pollHookLog()).toBe(1);
    expect(s.snapshot().recall[0]).toEqual({ ts: NOW - HOUR, outcome: "ok" });
  });

  it("a truncated/rotated log re-reads from the start", () => {
    writeFileSync(logPath, hookLine(NOW - HOUR, "timeout") + "\n", "utf8");
    const s = store();
    expect(s.pollHookLog()).toBe(1);
    writeFileSync(logPath, hookLine(NOW - 2 * HOUR, "ok") + "\n", "utf8"); // shorter: real truncation
    expect(s.pollHookLog()).toBe(1); // re-read, not skipped as size<offset
    expect(s.snapshot().recall.some((e) => e.outcome === "timeout")).toBe(true);
  });

  it("a missing log polls to zero without throwing", () => {
    expect(store().pollHookLog()).toBe(0);
  });

  it("drops records older than the 7d horizon", () => {
    writeFileSync(logPath, hookLine(NOW - 8 * DAY, "ok") + "\n", "utf8");
    const s = store();
    expect(s.pollHookLog()).toBe(0);
  });
});

describe("createSloMetricsStore — persistence", () => {
  let tmp: string;
  let statePath: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-slo-state-"));
    statePath = join(tmp, "nested", "slo-metrics.json");
    logPath = join(tmp, "hook-log.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function store() {
    return createSloMetricsStore({ hookLogPath: logPath, statePath, now: () => NOW });
  }

  it("persist -> load round-trips outcomes, stalls, latency and the ingest gauge", () => {
    const s = store();
    s.recordStall(410.5, NOW - 2 * HOUR);
    writeFileSync(logPath, hookLine(NOW - HOUR, "ok", { latencyMs: 800 }) + "\n", "utf8");
    s.pollHookLog();
    s.recordIngestReport({
      adapters: { a: { pending: 1, parked: 0, unreadable: 0, oldest_pending_at: new Date(NOW - 4 * HOUR).toISOString() } },
      last_success_at: null,
      last_progress_at: null,
      timeouts_1h: 0,
      errors_1h: 0,
      lagging: false,
      summary: "1 pending, 0 ok/1h",
    });
    s.persist();

    const s2 = store();
    s2.load();
    const st = s2.snapshot();
    expect(st.recall).toEqual([{ ts: NOW - HOUR, outcome: "ok", latencyMs: 800 }]);
    expect(st.stalls).toEqual([{ ts: NOW - 2 * HOUR, ms: 410.5 }]);
    expect(st.ingest?.lagMinutes).toBe(240);

    const d7 = buildSloResponse(st, "7d", NOW);
    expect(d7.breaches).toEqual(["maxStallMs", "lagMinutes"]);
  });

  it("persist prunes past-7d events from the file; corrupt files start empty", () => {
    const s = store();
    writeFileSync(logPath, hookLine(NOW - 8 * DAY, "ok") + "\n" + hookLine(NOW - HOUR, "ok") + "\n", "utf8");
    s.pollHookLog(); // 8d-old line is dropped at consume time
    s.recordStall(300, NOW - 9 * DAY); // stale stall persists out instead
    s.persist();
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as { schemaVersion: number; stalls: unknown[] };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.stalls).toHaveLength(0);

    writeFileSync(statePath, "{corrupt", "utf8");
    const s2 = store();
    s2.load(); // must not throw
    expect(s2.snapshot().recall).toEqual([]);
    expect(s2.snapshot().stalls).toEqual([]);
  });

  it("refresh() tails, samples the ingest monitor and persists, swallowing sampler failures", async () => {
    writeFileSync(logPath, hookLine(NOW - HOUR, "unreachable") + "\n", "utf8");
    const s = store();
    await s.refresh({
      get: async () => {
        throw new Error("adapter discovery blew up");
      },
    });
    expect(s.snapshot().recall).toHaveLength(1);
    expect(s.snapshot().ingest).toBeNull();
    expect(() => readFileSync(statePath, "utf8")).not.toThrow();
  });
});
