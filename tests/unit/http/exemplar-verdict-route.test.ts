// tests/unit/http/exemplar-verdict-route.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { ExemplarVerdictPatch, ExemplarVerdictSource } from "../../../src/ports/code-exemplar-store.js";

function fakeStore(calls: Array<{ id: string; patch: ExemplarVerdictPatch; source: ExemplarVerdictSource }>) {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict(id: string, patch: ExemplarVerdictPatch, source: ExemplarVerdictSource) {
      calls.push({ id, patch, source });
      return { status: id === "missing" ? "not_found" as const : "applied" as const };
    },
  };
}
function appWith(store: ReturnType<typeof fakeStore>) {
  return createApp({ recall: { search: async () => ({}) }, store: {}, exemplarStore: store, installScope: "s" } as never);
}

describe("POST /api/exemplar/:id/verdict", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1"; });
  afterEach(() => { if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev; });

  it("retires an exemplar as a human verdict", async () => {
    const calls: Array<{ id: string; patch: ExemplarVerdictPatch; source: ExemplarVerdictSource }> = [];
    const app = appWith(fakeStore(calls));
    const res = await app.request("/api/exemplar/ex1/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ id: "ex1", patch: { retired: true }, source: "human" }]);
  });

  it("404s when the exemplar does not exist", async () => {
    const app = appWith(fakeStore([]));
    const res = await app.request("/api/exemplar/missing/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(404);
  });

  it("403s when the flag is off", async () => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    const app = appWith(fakeStore([]));
    const res = await app.request("/api/exemplar/ex1/verdict", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ retire: true }),
    });
    expect(res.status).toBe(403);
  });
});
