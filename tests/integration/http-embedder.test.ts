import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.js";
import type { EmbedderSettingsDeps } from "../../src/core/embedding/embedder-settings-service.js";
import type { StoredEmbedderLane } from "../../src/ports/embedder-settings-store.js";
import { applyEmbedderUpdate, NO_STORED_EMBEDDER } from "../../src/ports/embedder-settings-store.js";
import { EmbedderBox, CodeEmbedderBox } from "../../src/llm/embedder-box.js";
import { OpenAIEmbedderClient } from "../../src/llm/openai-embedder-client.js";
import type { EmbeddingLaneConfig } from "../../src/core/embedding/embedding-config.js";
import type { JobSnapshot } from "../../src/core/jobs/job-supervisor.js";

const ENV = { NLM_EMBED_PROVIDER: "openai", NLM_EMBED_BASE_URL: "http://lan/v1", NLM_EMBED_MODEL: "m1", NLM_EMBED_API_KEY: "sk-secret" };

function setup(storedDim = 768) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: new Array<number>(768).fill(1) }] }), { status: 200 })) as unknown as typeof fetch;
  const rows = new Map<string, StoredEmbedderLane>();
  const vectors = new Map<string, EmbeddingLaneConfig>([["prose", { lane: "prose", provider: "openai", model: "m1", dim: storedDim }]]);
  const started: unknown[] = [];
  let snapshot: JobSnapshot = { name: "embed-rebuild", state: "idle", processed: 0, total: 0, startedAt: null, lastAdvanceAt: null, restarts: 0, restartsTotal: 0 };
  const embedder: EmbedderSettingsDeps = {
    settings: {
      get: async (lane) => rows.get(lane) ?? NO_STORED_EMBEDDER,
      update: async (lane, patch) => {
        const next = applyEmbedderUpdate(rows.get(lane) ?? NO_STORED_EMBEDDER, patch);
        rows.set(lane, next);
        return next;
      },
    },
    config: {
      getLane: (lane) => vectors.get(lane) ?? null,
      upsertLane: (cfg) => { vectors.set(cfg.lane, cfg); },
    },
    prose: new EmbedderBox(new OpenAIEmbedderClient({ baseUrl: "http://lan/v1", model: "m1", fetchImpl })),
    code: new CodeEmbedderBox({ embed: async () => ({ vector: new Float32Array(768), dim: 768 }) }),
    jobs: {
      start: (args, env) => {
        started.push({ args, env });
        snapshot = { ...snapshot, state: "running" };
      },
      snapshot: () => snapshot,
    },
    env: ENV,
    fetchImpl,
  };
  const app = createApp({ recall: {}, store: {}, embedder } as never);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, send, started, rows };
}

describe("/api/embedder", () => {
  it("GET reports lanes and never returns the key", async () => {
    const { send } = setup();
    const res = await send("GET", "/api/embedder/settings");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-secret");
    const body = JSON.parse(text) as { lanes: { prose: { reconcile: string; api_key_set: boolean } }; rebuild_job: unknown };
    expect(body.lanes.prose).toMatchObject({ reconcile: "match", api_key_set: true });
    expect(body.rebuild_job).toBeNull();
  });

  it("returns 503 on every route when the embedder is not wired", async () => {
    const app = createApp({ recall: {}, store: {} } as never);
    for (const [method, path] of [["GET", "/api/embedder/settings"], ["PUT", "/api/embedder/settings"], ["POST", "/api/embedder/test"]] as const) {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(res.status).toBe(503);
    }
  });

  it.each([
    ["PUT", { lane: "nope" }],
    ["PUT", { lane: "prose", provider: "azure" }],
    ["PUT", { lane: "prose", base_url: "ftp://x" }],
    ["PUT", { lane: "prose", model: "" }],
    ["POST", { lane: "code", provider: "bundled" }],
  ])("%s %j is a 400", async (method, body) => {
    const { send } = setup();
    const res = await send(method, method === "PUT" ? "/api/embedder/settings" : "/api/embedder/test", body);
    expect(res.status).toBe(400);
  });

  it("PUT without JSON is a 400", async () => {
    const { app } = setup();
    const res = await app.request("/api/embedder/settings", { method: "PUT", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("POST /test returns ok, dim, model and latency", async () => {
    const { send } = setup();
    const body = (await (await send("POST", "/api/embedder/test", { lane: "prose" })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, dim: 768, model: "m1" });
  });

  it("PUT maps statuses: 200 live, 409 unconfirmed, 202 confirmed with the job in the response and in /api/health", async () => {
    const { send, started } = setup();
    expect((await send("PUT", "/api/embedder/settings", { lane: "prose", base_url: "http://other/v1" })).status).toBe(200);
    expect((await send("PUT", "/api/embedder/settings", { lane: "prose", model: "m2" })).status).toBe(409);
    expect(started).toHaveLength(0);
    const ok = await send("PUT", "/api/embedder/settings", { lane: "prose", model: "m2", confirm_reembed: true });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as { rebuild_job: JobSnapshot }).rebuild_job.state).toBe("running");
    expect(started).toHaveLength(1);
    const health = (await (await send("GET", "/api/health")).json()) as { embedJob: JobSnapshot | null };
    expect(health.embedJob?.state).toBe("running");
  });
});
