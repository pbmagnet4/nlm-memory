import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getEmbedderSettings,
  parseLanePatch,
  saveEmbedderSettings,
  testEmbedder,
  type EmbedderSettingsDeps,
} from "../../../../src/core/embedding/embedder-settings-service.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { EmbedderBox, CodeEmbedderBox } from "../../../../src/llm/embedder-box.js";
import { OpenAIEmbedderClient } from "../../../../src/llm/openai-embedder-client.js";
import { OpenAICodeEmbedderClient } from "../../../../src/llm/openai-code-embedder-client.js";
import type { JobSnapshot } from "../../../../src/core/jobs/job-supervisor.js";

const PROD_ENV = {
  NLM_EMBED_PROVIDER: "openai",
  NLM_EMBED_BASE_URL: "http://192.168.2.2:4000/v1",
  NLM_EMBED_MODEL: "text-embedding-embeddinggemma-2-oq8e",
  NLM_EMBED_API_KEY: "sk-live-secret",
};
const PROD_MODEL = "text-embedding-embeddinggemma-2-oq8e";

interface Call { url: string; auth: string; model: string }

/** Fake OpenAI /embeddings: returns `dim` ones, records each request. */
function fakeFetch(dim: number, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    calls.push({ url: String(url), auth: String((init.headers as Record<string, string>)["Authorization"]), model: body.model });
    return new Response(JSON.stringify({ data: [{ embedding: new Array<number>(dim).fill(1) }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

function idleSnapshot(): JobSnapshot {
  return { name: "embed-rebuild", state: "idle", processed: 0, total: 0, startedAt: null, lastAdvanceAt: null, restarts: 0, restartsTotal: 0 };
}

async function setup(opts: { dim?: number; env?: Record<string, string>; stored?: { lane: "prose" | "code"; dim: number; model?: string } } = {}) {
  const storage = SqliteStorage.create({
    dbPath: join(mkdtempSync(join(tmpdir(), "nlm-esvc-")), "s.sqlite"),
    migrationsDir: resolve(__dirname, "../../../../migrations"),
  });
  await storage.init();
  const env = opts.env ?? PROD_ENV;
  if (opts.stored) {
    storage.embeddingConfig.upsertLane({ lane: opts.stored.lane, provider: "openai", model: opts.stored.model ?? PROD_MODEL, dim: opts.stored.dim }, "2026-10-27T00:00:00Z");
  }
  const calls: Call[] = [];
  const fetchImpl = fakeFetch(opts.dim ?? 768, calls);
  const prose = new EmbedderBox(new OpenAIEmbedderClient({ baseUrl: env["NLM_EMBED_BASE_URL"] ?? "http://x/v1", model: env["NLM_EMBED_MODEL"] ?? "m", fetchImpl }));
  const code = new CodeEmbedderBox(new OpenAICodeEmbedderClient({ baseUrl: env["NLM_EMBED_BASE_URL"] ?? "http://x/v1", fetchImpl }));
  const started: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  let snapshot = idleSnapshot();
  const deps: EmbedderSettingsDeps = {
    settings: storage.embedderSettings,
    config: storage.embeddingConfig,
    prose,
    code,
    jobs: {
      start: (args, jobEnv) => {
        started.push({ args, env: jobEnv });
        snapshot = { ...idleSnapshot(), state: "running", startedAt: "2026-10-27T00:00:00Z" };
      },
      snapshot: () => snapshot,
    },
    env,
    fetchImpl,
  };
  return { deps, storage, started, calls, prose, code, setRunning: () => { snapshot = { ...idleSnapshot(), state: "running" }; } };
}

const patch = (body: Record<string, unknown>) => {
  const p = parseLanePatch(body);
  if (typeof p === "string") throw new Error(p);
  return p;
};

describe("parseLanePatch", () => {
  it.each([
    [{ lane: "x" }, /lane/],
    [{ lane: "prose", provider: "azure" }, /provider/],
    [{ lane: "code", provider: "bundled" }, /provider/],
    [{ lane: "prose", base_url: "ftp://h" }, /base_url/],
    [{ lane: "prose", base_url: "not a url" }, /base_url/],
    [{ lane: "prose", model: "  " }, /model/],
    [{ lane: "prose", api_key: "" }, /api_key/],
    [{ lane: "prose", confirm_reembed: "yes" }, /confirm_reembed/],
  ])("rejects %j", (body, msg) => {
    expect(parseLanePatch(body)).toMatch(msg);
  });

  it("accepts nulls (clear) and normalizes provider case", () => {
    expect(patch({ lane: "prose", provider: "OpenAI", model: null, base_url: null })).toEqual({
      lane: "prose",
      update: { provider: "openai", model: null, baseUrl: null },
      confirmReembed: false,
    });
  });
});

describe("getEmbedderSettings", () => {
  it("represents the production env exactly (source env, reconcile match) and never exposes the key", async () => {
    const { deps } = await setup({ stored: { lane: "prose", dim: 768 } });
    const out = await getEmbedderSettings(deps);
    const prose = (out["lanes"] as Record<string, Record<string, unknown>>)["prose"]!;
    expect(prose["provider"]).toEqual({ value: "openai", source: "env" });
    expect(prose["base_url"]).toEqual({ value: "http://192.168.2.2:4000/v1", source: "env" });
    expect(prose["model"]).toEqual({ value: PROD_MODEL, source: "env" });
    expect(prose["api_key_set"]).toBe(true);
    expect(prose["api_key_source"]).toBe("env");
    expect(prose["stored"]).toEqual({ provider: "openai", model: PROD_MODEL, dim: 768 });
    expect(prose["reconcile"]).toBe("match");
    expect(JSON.stringify(out)).not.toContain("sk-live-secret");
  });

  it("reports stale when the stored vectors were built with a different dim, and unknown when the probe fails", async () => {
    const { deps } = await setup({ stored: { lane: "prose", dim: 1024 } });
    const stale = (await getEmbedderSettings(deps))["lanes"] as Record<string, Record<string, unknown>>;
    expect(stale["prose"]!["reconcile"]).toBe("stale");
    deps.prose.swap({ embed: () => Promise.reject(new Error("down")) } as never);
    const down = (await getEmbedderSettings(deps))["lanes"] as Record<string, Record<string, unknown>>;
    expect(down["prose"]!["reconcile"]).toBe("unknown");
  });
});

describe("testEmbedder", () => {
  it("probes the candidate through its own config and persists nothing", async () => {
    const { deps, calls, storage } = await setup();
    const out = await testEmbedder(deps, patch({ lane: "prose", model: "cand-model", base_url: "http://cand/v1", api_key: "cand-key" }));
    expect(out).toMatchObject({ ok: true, dim: 768, model: "cand-model" });
    expect(typeof out["latency_ms"]).toBe("number");
    expect(calls[0]).toEqual({ url: "http://cand/v1/embeddings", auth: "Bearer cand-key", model: "cand-model" });
    expect((await storage.embedderSettings.get("prose")).model).toBeNull();
  });

  it("uses the effective key when the endpoint is unchanged", async () => {
    const { deps, calls } = await setup();
    await testEmbedder(deps, patch({ lane: "prose", model: "other" }));
    expect(calls[0]!.auth).toBe("Bearer sk-live-secret");
  });

  it("does not forward the env key to a changed base_url or provider unless the request supplies a key", async () => {
    const { deps, calls } = await setup();
    await testEmbedder(deps, patch({ lane: "prose", base_url: "http://attacker.example/v1" }));
    expect(calls[0]).toMatchObject({ url: "http://attacker.example/v1/embeddings", auth: "Bearer local" });
    await testEmbedder(deps, patch({ lane: "prose", base_url: "http://other/v1", api_key: "explicit" }));
    expect(calls[1]!.auth).toBe("Bearer explicit");
    await testEmbedder(deps, patch({ lane: "prose", provider: "openai", base_url: "http://lan2/v1" }));
    expect(calls[2]!.auth).toBe("Bearer local");
  });

  it("does not forward a stored key to a changed base_url either", async () => {
    const { deps, calls, storage } = await setup();
    await storage.embedderSettings.update("prose", { apiKey: "stored-key" });
    await testEmbedder(deps, patch({ lane: "prose", base_url: "http://elsewhere/v1" }));
    expect(calls[0]!.auth).toBe("Bearer local");
    await testEmbedder(deps, patch({ lane: "prose", base_url: "http://192.168.2.2:4000/v1" }));
    expect(calls[1]!.auth).toBe("Bearer stored-key");
  });

  it("returns a generic error (status or class), never upstream text", async () => {
    const { deps } = await setup();
    const leaky: EmbedderSettingsDeps = {
      ...deps,
      fetchImpl: (async () => { throw new Error("connect failed with key sk-live-secret at http://internal"); }) as unknown as typeof fetch,
    };
    const thrown = await testEmbedder(leaky, patch({ lane: "prose" }));
    expect(thrown["ok"]).toBe(false);
    expect(String(thrown["error"])).toMatch(/^probe failed: /);
    expect(String(thrown["error"])).not.toContain("sk-live-secret");
    expect(String(thrown["error"])).not.toContain("internal");
    const http500: EmbedderSettingsDeps = { ...deps, fetchImpl: (async () => new Response("secret body", { status: 500 })) as unknown as typeof fetch };
    expect((await testEmbedder(http500, patch({ lane: "prose" })))["error"]).toBe("probe failed: HTTP 500");
  });
});

describe("probe timeouts", () => {
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  it("GET reports reconcile unknown for a hung lane, probing both lanes concurrently", async () => {
    const { deps } = await setup();
    const hung: EmbedderSettingsDeps = {
      ...deps,
      probeTimeoutMs: 150,
      prose: new EmbedderBox(new OpenAIEmbedderClient({ baseUrl: "http://x/v1", fetchImpl: hanging })),
      code: new CodeEmbedderBox(new OpenAICodeEmbedderClient({ baseUrl: "http://x/v1", fetchImpl: hanging })),
    };
    const started = Date.now();
    const lanes = (await getEmbedderSettings(hung))["lanes"] as Record<string, Record<string, unknown>>;
    expect(Date.now() - started).toBeLessThan(290);
    expect(lanes["prose"]!["reconcile"]).toBe("unknown");
    expect(lanes["code"]!["reconcile"]).toBe("unknown");
  });

  it("the test endpoint and PUT time out instead of hanging", async () => {
    const { deps } = await setup({ stored: { lane: "prose", dim: 768 } });
    const hung: EmbedderSettingsDeps = { ...deps, probeTimeoutMs: 50, fetchImpl: hanging };
    expect(await testEmbedder(hung, patch({ lane: "prose" }))).toMatchObject({ ok: false });
    const res = await saveEmbedderSettings(hung, patch({ lane: "prose", base_url: "http://slow/v1" }));
    expect(res.status).toBe(422);
  });
});

describe("saveEmbedderSettings, prose lane", () => {
  it("applies a base_url/api_key change live when provider+model+dim still match the stored vectors", async () => {
    const { deps, storage, started, calls } = await setup({ stored: { lane: "prose", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", base_url: "http://new-host/v1", api_key: "new-key" }));
    expect(res.status).toBe(200);
    expect(started).toHaveLength(0);
    expect(await storage.embedderSettings.get("prose")).toMatchObject({ baseUrl: "http://new-host/v1", apiKey: "new-key" });
    calls.length = 0;
    await deps.prose.embed("hello", "query");
    expect(calls[0]).toMatchObject({ url: "http://new-host/v1/embeddings", auth: "Bearer new-key" });
    const lane = res.body["lane"] as Record<string, unknown>;
    expect(lane["base_url"]).toEqual({ value: "http://new-host/v1", source: "setting" });
    expect(JSON.stringify(res.body)).not.toContain("new-key");
  });

  it("a save that moves base_url without a key clears the stored key and sends none", async () => {
    const { deps, storage, calls } = await setup({ stored: { lane: "prose", dim: 768 } });
    await storage.embedderSettings.update("prose", { apiKey: "stored-key" });
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", base_url: "http://moved/v1" }));
    expect(res.status).toBe(200);
    expect((await storage.embedderSettings.get("prose")).apiKey).toBeNull();
    calls.length = 0;
    await deps.prose.embed("x", "query");
    expect(calls[0]).toMatchObject({ url: "http://moved/v1/embeddings", auth: "Bearer local" });
    expect((res.body["lane"] as Record<string, unknown>)["api_key_set"]).toBe(false);
  });

  it("returns 409 without confirm_reembed on a model change, persisting and swapping nothing", async () => {
    const { deps, storage, started } = await setup({ stored: { lane: "prose", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", model: "different-model" }));
    expect(res.status).toBe(409);
    expect(res.body["requires_reembed"]).toBe(true);
    expect(res.body["candidate"]).toEqual({ provider: "openai", model: "different-model", dim: 768 });
    expect(started).toHaveLength(0);
    expect((await storage.embedderSettings.get("prose")).model).toBeNull();
  });

  it("returns 409 without confirm_reembed when only the dim changes", async () => {
    const { deps } = await setup({ dim: 1024, stored: { lane: "prose", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", base_url: "http://other/v1" }));
    expect(res.status).toBe(409);
  });

  it("with confirm_reembed persists, swaps, and starts the rebuild job with the effective lane config in the child env", async () => {
    const { deps, storage, started, calls } = await setup({ dim: 1024, stored: { lane: "prose", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", model: "bigger-model", api_key: "rebuild-key", confirm_reembed: true }));
    expect(res.status).toBe(202);
    expect(started).toEqual([{
      args: [],
      env: {
        NLM_EMBED_PROVIDER: "openai",
        NLM_EMBED_MODEL: "bigger-model",
        NLM_EMBED_BASE_URL: "http://192.168.2.2:4000/v1",
        NLM_EMBED_API_KEY: "rebuild-key",
      },
    }]);
    expect(await storage.embedderSettings.get("prose")).toMatchObject({ model: "bigger-model", apiKey: "rebuild-key" });
    calls.length = 0;
    await deps.prose.embed("x", "document");
    expect(calls[0]!.model).toBe("bigger-model");
    expect((res.body["rebuild_job"] as JobSnapshot).state).toBe("running");
    expect(JSON.stringify(res.body)).not.toContain("rebuild-key");
    // the stored vectors are still the old ones until the job finishes
    expect(((res.body["lane"] as Record<string, unknown>)["reconcile"])).toBe("stale");
  });

  it("refuses a second confirmed change while a rebuild is running, before persisting", async () => {
    const { deps, storage, started, setRunning } = await setup({ stored: { lane: "prose", dim: 768 } });
    setRunning();
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", model: "m2", confirm_reembed: true }));
    expect(res.status).toBe(409);
    expect(started).toHaveLength(0);
    expect((await storage.embedderSettings.get("prose")).model).toBeNull();
  });

  it("records the lane and applies live when no vectors exist yet", async () => {
    const { deps, storage, started } = await setup();
    const res = await saveEmbedderSettings(deps, patch({ lane: "prose", model: "first-model" }));
    expect(res.status).toBe(200);
    expect(started).toHaveLength(0);
    expect(storage.embeddingConfig.getLane("prose")).toMatchObject({ model: "first-model", dim: 768 });
  });

  it("returns 422 and changes nothing when the candidate fails its probe", async () => {
    const { deps, storage } = await setup({ stored: { lane: "prose", dim: 768 } });
    const failing: EmbedderSettingsDeps = {
      ...deps,
      fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    };
    const res = await saveEmbedderSettings(failing, patch({ lane: "prose", base_url: "http://dead/v1" }));
    expect(res.status).toBe(422);
    expect((await storage.embedderSettings.get("prose")).baseUrl).toBeNull();
  });
});

describe("saveEmbedderSettings, code lane", () => {
  it("applies base_url and api_key edits live", async () => {
    const { deps, storage, calls } = await setup({ stored: { lane: "code", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "code", base_url: "http://code-host/v1", api_key: "code-key" }));
    expect(res.status).toBe(200);
    expect(await storage.embedderSettings.get("code")).toMatchObject({ baseUrl: "http://code-host/v1", apiKey: "code-key" });
    calls.length = 0;
    await deps.code.embed("fn", "document");
    expect(calls[0]).toMatchObject({ url: "http://code-host/v1/embeddings", auth: "Bearer code-key" });
  });

  it.each([
    ["a model change", { model: "other-code-model" }, 768],
    ["a provider change", { provider: "ollama" }, 768],
    ["a dim change from a base_url edit", { base_url: "http://other/v1" }, 1024],
  ])("returns 409 for %s even with confirm_reembed, naming T1179", async (_n, change, dim) => {
    const { deps, storage } = await setup({ dim, stored: { lane: "code", dim: 768 } });
    const res = await saveEmbedderSettings(deps, patch({ lane: "code", ...change, confirm_reembed: true }));
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("T1179");
    expect(await storage.embedderSettings.get("code")).toEqual({ provider: null, baseUrl: null, model: null, apiKey: null });
  });
});
