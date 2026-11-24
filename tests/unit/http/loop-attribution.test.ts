import { expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import { defaultActiveJobSet } from "../../../src/core/scheduler/loop-monitor.js";

it("names the in-flight route in the active-job set a stall is attributed against", async () => {
  let during: readonly string[] = [];
  const app = createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) },
    store: {},
    slo: {
      snapshot: () => {
        during = defaultActiveJobSet.active();
        return { savedAt: 0, recall: [], stalls: [], stageSamples: [], ingest: null, relevance: null };
      },
    },
  } as never);

  expect((await app.request("/api/health/slo")).status).toBe(200);
  expect(during).toContain("http GET /api/health/slo");
  expect(defaultActiveJobSet.active()).not.toContain("http GET /api/health/slo");
});
