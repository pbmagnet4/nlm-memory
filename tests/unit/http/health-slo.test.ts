import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import { buildSloResponse, SLO_TARGETS, type SloState } from "../../../src/core/health/slo-metrics.js";

const NOW = Date.parse("2026-02-05T12:00:00.000Z");
const HOUR = 3_600_000;

// Fixture: two breaches in the last 24h (timeout rate, stall), ingest lag
// inside target, latency under p95 target.
const STATE: SloState = {
  savedAt: NOW,
  recall: [
    { ts: NOW - 1 * HOUR, outcome: "timeout" },
    { ts: NOW - 2 * HOUR, outcome: "timeout" },
    { ts: NOW - 3 * HOUR, outcome: "ok", latencyMs: 700 },
    { ts: NOW - 4 * HOUR, outcome: "ok", latencyMs: 940 },
    { ts: NOW - 5 * HOUR, outcome: "skipped" },
    // 7d-only events: they must not move the 24h window
    { ts: NOW - 3 * 24 * HOUR, outcome: "ok" },
  ],
  stalls: [
    { ts: NOW - 2 * HOUR, ms: 640 },
    { ts: NOW - 10 * HOUR, ms: 300 },
  ],
  ingest: {
    sampledAt: NOW - 30_000,
    lagMinutes: 4,
    classifyLagMinutes: 1.5,
    lagging: false,
    timeouts1h: 2,
    summary: "2 pending, oldest 4m, 5 ok/1h",
  },
  // Last night's Clef judge run (the eval's own holdout number, for shape).
  relevance: {
    at: NOW - 40 * 60_000,
    value: 0.254,
    pairs: 114,
    threshold: 1.43,
    model: "clef-flash-oQ8e",
    phrasing: "same",
  },
};

function appWith(slo?: { snapshot(): SloState }) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    ...(slo ? { slo } : {}),
  } as never);
}

describe("GET /api/health/slo", () => {
  it("defaults to the 24h window and reports targets/actual/breaches", async () => {
    // Freeze the clock the route reads by making every sample relative-safe:
    // the fixture uses absolute timestamps, so pin "now" via a fresh offset.
    const res = await appWith({ snapshot: () => shifted(STATE) }).request("/api/health/slo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof buildSloResponse> & {
      actual: { outcomes: { timeoutRate: number | null }; ingest: { lagMinutes: number } };
    };
    expect(body.window).toBe("24h");
    expect(body.targets).toEqual(SLO_TARGETS);
    // 2 timeouts of 5 in-window outcomes = 0.4 > 0.02
    expect(body.actual.outcomes.total).toBe(5);
    expect(body.actual.outcomes.timeoutRate).toBe(0.4);
    expect(body.actual.stalls).toEqual({ count: 2, maxMs: 640 });
    expect(body.actual.recallLatency.p95Ms).toBe(940); // nearest-rank of [700,940]
    expect(body.actual.stalls).toEqual({ count: 2, maxMs: 640 });
    expect(body.actual.ingest.lagMinutes).toBe(4);
    // T1782 gauge. It is reported and never breached: a 25% kept share is what
    // the eval measured, not a target.
    expect(body.actual.relevancePrecision).toMatchObject({
      value: 0.254,
      pairs: 114,
      threshold: 1.43,
      model: "clef-flash-oQ8e",
    });
    // The fixture is rebased onto the wall clock, so `at` is relative.
    expect(Date.now() - Date.parse(body.actual.relevancePrecision!.at)).toBeLessThan(41 * 60_000);
    expect(body.breaches).toEqual(["timeoutRate", "maxStallMs"]);
  });

  it("a night with no judge run reports relevancePrecision: null", async () => {
    const res = await appWith({ snapshot: () => shifted({ ...STATE, relevance: null }) }).request("/api/health/slo");
    const body = (await res.json()) as ReturnType<typeof buildSloResponse>;
    expect(body.actual.relevancePrecision).toBeNull();
    expect(body.breaches).toEqual(["timeoutRate", "maxStallMs"]);
  });

  it("?window=7d widens the counted set", async () => {
    const res = await appWith({ snapshot: () => shifted(STATE) }).request("/api/health/slo?window=7d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof buildSloResponse>;
    expect(body.window).toBe("7d");
    expect(body.actual.outcomes.total).toBe(6);
  });

  it("rejects an unknown window with 400", async () => {
    const res = await appWith({ snapshot: () => shifted(STATE) }).request("/api/health/slo?window=30d");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("30d");
  });

  it("503s when the store is not wired", async () => {
    expect((await appWith().request("/api/health/slo")).status).toBe(503);
  });

  it("is reachable credential-free in local mode, like /api/health", async () => {
    // installLocalOnlyMiddleware skips tenant resolution for the health pair;
    // a garbage Bearer must not turn a health poll into a 401.
    const res = await appWith({ snapshot: () => shifted(STATE) }).request("/api/health/slo", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(200);
  });

  it("is a LOCAL route: hard 403 under NLM_HOSTED=1", async () => {
    process.env["NLM_HOSTED"] = "1";
    try {
      const app = appWith({ snapshot: () => shifted(STATE) });
      // The health-route skip shares /api/health's path before token handling;
      // the hosted gate then hard-refuses the LOCAL disposition either way.
      const res = await app.request("/api/health/slo");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { disposition?: string }).disposition).toBe("LOCAL");
    } finally {
      delete process.env["NLM_HOSTED"];
    }
  });
});

/** Rebase the fixture onto the wall clock so the route's Date.now() lands the
 *  events inside the requested window. */
function shifted(state: SloState): SloState {
  const delta = Date.now() - NOW;
  return {
    savedAt: state.savedAt + delta,
    recall: state.recall.map((e) => ({ ...e, ts: e.ts + delta })),
    stalls: state.stalls.map((e) => ({ ...e, ts: e.ts + delta })),
    ingest: state.ingest && { ...state.ingest, sampledAt: state.ingest.sampledAt + delta },
    relevance: state.relevance && { ...state.relevance, at: state.relevance.at + delta },
  };
}

/** Pin the p95 expectation against the shared pure implementation. */
describe("buildSloResponse sanity (fixture re-check)", () => {
  it("matches what the route returned for the same state", () => {
    const res = buildSloResponse(shifted(STATE), "24h", Date.now());
    expect(res.breaches).toEqual(["timeoutRate", "maxStallMs"]);
  });
});
