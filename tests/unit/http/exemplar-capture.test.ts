import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createApp } from "../../../src/http/app.js";
import type { SignalStore, SignalAggregationFilter } from "../../../src/ports/signal-store.js";
import type { CodeExemplarStore } from "../../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../../src/ports/code-embedder.js";
import type { Signal, CodeExemplarInput } from "../../../src/shared/types.js";

function fakeSignalStore(): SignalStore {
  const rows: Signal[] = [];
  return {
    async insert(s) { if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async insertMany(ss) { for (const s of ss) if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async listForAggregation(_f: SignalAggregationFilter) { return rows; },
    async countSince() { return rows.length; },
    async pruneOlderThan() { return 0; },
  };
}

function fakeExemplarStore(): CodeExemplarStore & { inserted: CodeExemplarInput[]; embedded: string[] } {
  const inserted: CodeExemplarInput[] = [];
  const embedded: string[] = [];
  return {
    inserted,
    embedded,
    async insert(input) { inserted.push(input); return { id: `ex_${inserted.length}`, skipped: false }; },
    async insertMany(inputs) { for (const i of inputs) inserted.push(i); return inputs.length; },
    async upsertEmbedding(id) { embedded.push(id); },
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
  };
}

function fakeCodeEmbedder(): CodeEmbedder {
  return { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };
}

function appWith(deps: {
  signalStore: SignalStore;
  exemplarStore?: CodeExemplarStore;
  codeEmbedder?: CodeEmbedder;
}) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {} as never,
    signalStore: deps.signalStore,
    installScope: "install-test",
    ...(deps.exemplarStore ? { exemplarStore: deps.exemplarStore } : {}),
    ...(deps.codeEmbedder ? { codeEmbedder: deps.codeEmbedder } : {}),
  } as never);
}

const CODE_SIGNAL = JSON.stringify({
  kind: "gate",
  producer: "qg",
  outcome: "pass",
  model: "qwen3.6-27b",
  repo: "/r",
  detail: {
    task: "add two numbers",
    lang: "py",
    code: "def add(a, b):\n    total = a + b\n    return total",
  },
  session: "s1",
  ts: "2026-06-19T18:00:00.000Z",
});

async function postSignal(app: ReturnType<typeof createApp>) {
  return app.request("/api/signal", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3940" },
    body: CODE_SIGNAL,
  });
}

describe("signal-ingest auto-capture of code exemplars", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("captures an exemplar from a code-bearing signal when the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const exemplarStore = fakeExemplarStore();
    const app = appWith({ signalStore: fakeSignalStore(), exemplarStore, codeEmbedder: fakeCodeEmbedder() });

    const res = await postSignal(app);

    expect(res.status).toBe(202);
    expect(exemplarStore.inserted).toHaveLength(1);
    expect(exemplarStore.inserted[0]!.code).toContain("total = a + b");
    expect(exemplarStore.inserted[0]!.outcome).toBe("pass");
    expect(exemplarStore.inserted[0]!.installScope).toBe("install-test");
  });

  it("does not capture when the flag is off", async () => {
    const exemplarStore = fakeExemplarStore();
    const app = appWith({ signalStore: fakeSignalStore(), exemplarStore, codeEmbedder: fakeCodeEmbedder() });

    const res = await postSignal(app);

    expect(res.status).toBe(202);
    expect(exemplarStore.inserted).toHaveLength(0);
  });

  it("still accepts the signal (202) when no exemplar store is wired", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const app = appWith({ signalStore: fakeSignalStore() });

    const res = await postSignal(app);

    expect(res.status).toBe(202);
  });

  it("a signal carrying no code is a no-op for capture, still 202", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const exemplarStore = fakeExemplarStore();
    const app = appWith({ signalStore: fakeSignalStore(), exemplarStore, codeEmbedder: fakeCodeEmbedder() });

    const res = await app.request("/api/signal", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3940" },
      body: JSON.stringify({ kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "types" }, session: "s2", ts: "2026-06-19T18:00:00.000Z" }),
    });

    expect(res.status).toBe(202);
    expect(exemplarStore.inserted).toHaveLength(0);
  });
});
