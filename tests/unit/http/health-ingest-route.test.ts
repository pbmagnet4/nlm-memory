import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { IngestLagReport } from "../../../src/core/health/ingest-lag.js";

const REPORT: IngestLagReport = {
  adapters: { pi: { pending: 2, parked: 1, oldest_pending_at: "2026-10-24T00:00:00.000Z" } },
  last_success_at: null,
  timeouts_1h: 3,
  errors_1h: 0,
  lagging: true,
  summary: "2 pending, oldest 3d, 0 ok/1h",
};

function appWith(ingestLag?: { get(): Promise<IngestLagReport> }) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    ...(ingestLag ? { ingestLag } : {}),
  } as never);
}

describe("GET /api/health/ingest", () => {
  it("returns the lag report verbatim", async () => {
    const res = await appWith({ get: async () => REPORT }).request("/api/health/ingest");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
  });

  it("503s when the monitor is not wired", async () => {
    expect((await appWith().request("/api/health/ingest")).status).toBe(503);
  });
});
