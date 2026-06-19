// tests/unit/http/recall-exemplars-route.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { RecallResult } from "../../../src/shared/types.js";

function appWithRecall(captured: { query: unknown }) {
  const recall = {
    search: async (q: { withRelatedExemplars?: boolean }) => {
      captured.query = q;
      const r: RecallResult = {
        query: "", entity: null, kind: null, mode: "keyword", limit: 5, total: 0, results: [],
        relatedExemplars: q.withRelatedExemplars
          ? [{ id: "ex1", outcome: "pass", lang: "ts", repo: "/r", taskContext: "throttle", distance: 0.2 }]
          : undefined,
      };
      return r;
    },
  };
  return createApp({ recall, store: {} } as never);
}

describe("GET /api/recall — withExemplars", () => {
  it("passes withRelatedExemplars and returns relatedExemplars when requested", async () => {
    const captured = { query: undefined as unknown };
    const app = appWithRecall(captured);
    const res = await app.request("/api/recall?q=throttle&mode=keyword&withExemplars=true", { headers: { host: "localhost:3940" } });
    expect(res.status).toBe(200);
    const body = await res.json() as RecallResult;
    expect((captured.query as { withRelatedExemplars?: boolean }).withRelatedExemplars).toBe(true);
    expect(body.relatedExemplars?.map((e) => e.id)).toEqual(["ex1"]);
  });

  it("does not request exemplars without the param", async () => {
    const captured = { query: undefined as unknown };
    const app = appWithRecall(captured);
    await app.request("/api/recall?q=throttle&mode=keyword", { headers: { host: "localhost:3940" } });
    expect((captured.query as { withRelatedExemplars?: boolean }).withRelatedExemplars).toBeUndefined();
  });
});
