import { describe, expect, it } from "vitest";
import { p95 } from "../../../src/core/health/slo-metrics.js";
import {
  buildReport,
  buildSchedule,
  defaultSinceMs,
  LOAD_TARGETS,
  parseHookLogLines,
  percentile,
  recallUrl,
  replayQuery,
  selectWindow,
  type MeasuredRequest,
} from "../../../scripts/eval/lib/load-replay-lib.js";

const line = (fields: Record<string, unknown>): string => JSON.stringify(fields);

const evaluate = (ts: string, promptPreview: string, conversationId = "conv-1"): string =>
  line({ ts, conversationId, promptPreview, gate: "evaluate", hits: [], wouldInject: [], estTokens: 0, mode: "shadow" });

describe("parseHookLogLines", () => {
  it("keeps gate=evaluate rows with a string preview and a parseable ts", () => {
    const { records, malformed, skipped } = parseHookLogLines(
      [
        evaluate("2026-11-01T10:00:00.000Z", "compare ranking weights for exemplar recall"),
        evaluate("2026-11-01T10:01:00.000Z", "why does the vitest worker time out"),
      ].join("\n"),
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.promptPreview).toBe("compare ranking weights for exemplar recall");
    expect(records[0]!.conversationId).toBe("conv-1");
    expect(records[0]!.tsMs).toBe(Date.parse("2026-11-01T10:00:00.000Z"));
    expect(malformed).toBe(0);
    expect(skipped).toBe(0);
  });

  it("preserves file order", () => {
    const { records } = parseHookLogLines(
      [
        evaluate("2026-11-01T10:02:00.000Z", "second prompt about indexing"),
        evaluate("2026-11-01T10:03:00.000Z", "third prompt about backups"),
      ].join("\n"),
    );
    expect(records.map((r) => r.tsMs)).toEqual([
      Date.parse("2026-11-01T10:02:00.000Z"),
      Date.parse("2026-11-01T10:03:00.000Z"),
    ]);
  });

  it("skips kind-tagged event lines (stop/session-end/pre-compact share the log)", () => {
    const { records, skipped } = parseHookLogLines(
      line({ ts: "2026-11-01T10:00:00.000Z", kind: "stop", conversationId: "c", promptPreview: "x", gate: "evaluate" }),
    );
    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("skips non-evaluate gates, non-string previews, and unparseable or non-string ts", () => {
    const { records, skipped } = parseHookLogLines(
      [
        line({ ts: "2026-11-01T10:00:00.000Z", promptPreview: "write a long design doc", gate: "generative" }),
        line({ ts: "2026-11-01T10:00:00.000Z", promptPreview: 42, gate: "evaluate" }),
        line({ ts: "not-a-date", promptPreview: "valid prompt text here", gate: "evaluate" }),
        line({ promptPreview: "valid prompt text here", gate: "evaluate" }),
        line({ ts: 1730000000000, promptPreview: "valid prompt text here", gate: "evaluate" }),
        line({ ts: "2026-11-01T10:00:00.000Z", promptPreview: "valid prompt text here", gate: "evaluate" }),
      ].join("\n"),
    );
    expect(records).toHaveLength(1);
    expect(skipped).toBe(5);
  });

  it("counts malformed lines and ignores blank lines without counting them", () => {
    const { records, malformed, skipped } = parseHookLogLines(
      ["", "  ", "{ not json", evaluate("2026-11-01T10:00:00.000Z", "a real prompt about recall"), "[1,2]", '"just a string"'].join("\n"),
    );
    expect(records).toHaveLength(1);
    expect(malformed).toBe(3);
    expect(skipped).toBe(0);
  });

  it("defaults a missing conversationId to the hook's unknown sentinel", () => {
    const { records } = parseHookLogLines(
      line({ ts: "2026-11-01T10:00:00.000Z", promptPreview: "a real prompt about recall", gate: "evaluate" }),
    );
    expect(records[0]!.conversationId).toBe("unknown");
  });
});

describe("defaultSinceMs / selectWindow", () => {
  const { records } = parseHookLogLines(
    [
      evaluate("2026-11-01T00:00:00.000Z", "first prompt about ranking"),
      evaluate("2026-11-01T12:00:00.000Z", "second prompt about indexing"),
      evaluate("2026-11-02T11:00:00.000Z", "third prompt about backups"),
    ].join("\n"),
  );

  it("defaults the window to 24h before the newest record", () => {
    expect(defaultSinceMs(records)).toBe(Date.parse("2026-11-01T11:00:00.000Z"));
  });

  it("selectWindow drops records before sinceMs and keeps the rest in order", () => {
    const selected = selectWindow(records, Date.parse("2026-11-01T11:00:00.000Z"), 100);
    expect(selected.map((r) => r.tsMs)).toEqual([
      Date.parse("2026-11-01T12:00:00.000Z"),
      Date.parse("2026-11-02T11:00:00.000Z"),
    ]);
  });

  it("selectWindow caps at limit, keeping the newest records", () => {
    const selected = selectWindow(records, 0, 2);
    expect(selected.map((r) => r.tsMs)).toEqual([
      Date.parse("2026-11-01T12:00:00.000Z"),
      Date.parse("2026-11-02T11:00:00.000Z"),
    ]);
  });

  it("returns empty for no matching records and for an empty input", () => {
    expect(selectWindow(records, Date.parse("2026-12-01T00:00:00.000Z"), 100)).toEqual([]);
    expect(selectWindow([], 0, 100)).toEqual([]);
    expect(defaultSinceMs([])).toBeNull();
  });
});

describe("buildSchedule", () => {
  const t0 = Date.parse("2026-11-01T10:00:00.000Z");

  it("divides inter-arrival gaps by the speed factor, starting at 0", () => {
    expect(buildSchedule([t0, t0 + 10_000, t0 + 30_000], 10)).toEqual([0, 1_000, 3_000]);
  });

  it("speed 0 means back-to-back (all offsets 0)", () => {
    expect(buildSchedule([t0, t0 + 60_000, t0 + 120_000], 0)).toEqual([0, 0, 0]);
  });

  it("a single record starts at 0", () => {
    expect(buildSchedule([t0], 10)).toEqual([0]);
  });

  it("rejects a negative speed", () => {
    expect(() => buildSchedule([t0], -1)).toThrow(RangeError);
  });
});

describe("percentile (nearest-rank, same definition as slo-metrics p95)", () => {
  it("returns null for an empty sample set", () => {
    expect(percentile([], 0.95)).toBeNull();
  });

  it("matches the daemon's p95 exactly", () => {
    const sets = [[1], [1, 2, 3, 4], Array.from({ length: 100 }, (_, i) => i + 1), [12.5, 7, 7, 99, 3]];
    for (const s of sets) {
      expect(percentile(s, 0.95)).toEqual(p95(s));
    }
  });

  it("computes p50 by nearest rank (ceil(0.5*n))", () => {
    expect(percentile([10], 0.5)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("is order-insensitive", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });
});

describe("replayQuery", () => {
  it("is the hook's own composition: buildRecallQuery then extractRecallQuery", () => {
    const q = replayQuery("please compare ranking weights for exemplar recall", "conv-1", {});
    expect(q).not.toBeNull();
    expect(q).toContain("compare");
    expect(q).toContain("ranking");
    expect(q).toContain("recall");
    expect(q).not.toContain("please");
  });

  it("returns null for thin prompts the hook would never send", () => {
    expect(replayQuery("ok thanks", "conv-1", {})).toBeNull();
  });
});

describe("recallUrl", () => {
  it("reproduces the hook's GET params on the configured base URL", () => {
    const url = recallUrl("http://127.0.0.1:3940", "ranking weights", "conv-9");
    expect(url).toBe(
      "http://127.0.0.1:3940/api/recall?q=ranking%20weights&mode=keyword&limit=5" +
        "&withFacts=true&withExemplars=true&withConcepts=true&conversation_id=conv-9",
    );
  });

  it("omits conversation_id when absent and trims a trailing slash", () => {
    expect(recallUrl("http://host:1/", "a query", undefined)).toBe(
      "http://host:1/api/recall?q=a%20query&mode=keyword&limit=5&withFacts=true&withExemplars=true&withConcepts=true",
    );
  });
});

const ok = (ms: number): MeasuredRequest => ({ outcome: "ok", ms });
const mk = (outcome: MeasuredRequest["outcome"], ms: number): MeasuredRequest => ({ outcome, ms });

describe("buildReport", () => {
  it("counts outcomes and derives both rates over measured requests (skipped excluded)", () => {
    const measured: MeasuredRequest[] = [
      ok(10), ok(20), ok(30), ok(40), ok(50), ok(60), ok(70),
      mk("timeout", 4000),
      mk("unreachable", 1),
      mk("http-error", 5),
    ];
    const report = buildReport(measured, 2);
    expect(report.requests).toBe(10);
    expect(report.skipped).toBe(2);
    expect(report.counts).toEqual({ ok: 7, timeout: 1, unreachable: 1, "http-error": 1 });
    expect(report.timeoutRate).toBe(0.1);
    expect(report.failureRate).toBe(0.3);
  });

  it("a run with only unreachable requests breaches failureRate, not timeoutRate", () => {
    // timeoutRate stays the daemon's literal definition so the two numbers
    // compare; the all-unreachable acceptance run exits 1 via failureRate.
    const report = buildReport(Array.from({ length: 8 }, () => mk("unreachable", 1)));
    expect(report.timeoutRate).toBe(0);
    expect(report.failureRate).toBe(1);
    expect(report.breaches).toEqual(["failureRate"]);
  });

  it("a run with timeouts breaches both timeoutRate and failureRate", () => {
    const report = buildReport([
      ...Array.from({ length: 5 }, () => ok(50)),
      ...Array.from({ length: 5 }, () => mk("timeout", 4000)),
    ]);
    expect(report.timeoutRate).toBe(0.5);
    expect(report.failureRate).toBe(0.5);
    expect(report.breaches).toEqual(["timeoutRate", "failureRate"]);
  });

  it("computes p50/p95/max over ok requests only", () => {
    const latencies = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const report = buildReport([
      ...latencies.map(ok),
      mk("timeout", 99_999),
      mk("http-error", 88_888),
    ]);
    expect(report.latencyMs.p50).toBe(10); // ceil(0.5*20)=10th
    expect(report.latencyMs.p95).toBe(19); // ceil(0.95*20)=19th
    expect(report.latencyMs.max).toBe(20);
  });

  it("omits latency stats when no request succeeded", () => {
    const report = buildReport([mk("timeout", 4000), mk("unreachable", 1)]);
    expect(report.latencyMs).toEqual({ p50: null, p95: null, max: null });
  });

  it("reports no breaches just inside the thresholds (strict >)", () => {
    const measured: MeasuredRequest[] = [
      ...Array.from({ length: 50 }, () => ok(1000)), // p95 lands exactly on the target, not above it
      mk("timeout", 4000), // 1/51 ≈ 1.96% ≤ 2% on both rate targets
    ];
    expect(buildReport(measured).breaches).toEqual([]);
  });

  it("breaches recallP95Ms when ok latency exceeds the target", () => {
    const measured = Array.from({ length: 20 }, () => ok(1001));
    const report = buildReport(measured);
    expect(report.breaches).toEqual(["recallP95Ms"]);
  });

  it("an empty run measures nothing: zero rates, null latency, no breaches", () => {
    const report = buildReport([], 3);
    expect(report.requests).toBe(0);
    expect(report.timeoutRate).toBe(0);
    expect(report.failureRate).toBe(0);
    expect(report.latencyMs).toEqual({ p50: null, p95: null, max: null });
    expect(report.breaches).toEqual([]);
  });

  it("exposes the shipped targets", () => {
    expect(LOAD_TARGETS).toEqual({ timeoutRate: 0.02, failureRate: 0.02, recallP95Ms: 1000 });
  });
});
