// tests/unit/core/recall/recall-exemplar-injection.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../../../src/core/recall/recall-service.js";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../../../src/ports/code-embedder.js";
import type { CodeExemplarHit } from "../../../../src/shared/types.js";

const fakeStoreHit: CodeExemplarHit = {
  id: "ex1", code: "c", taskContext: "throttle util", outcome: "pass",
  repo: "/r", model: "m", lang: "ts", survived: null, gitSha: null, distance: 0.2,
};
function exemplarStore(): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() {},
    async searchByVector() { return [fakeStoreHit]; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
    async listBySessions() { return []; },
  };
}
const codeEmbedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };

// Minimal store + llm so keyword recall returns an empty-but-valid result.
const store = {
  keywordSearch: async () => [],
  semanticSearch: async () => [],
  resolveSuccessors: async () => new Map(),
  getByIds: async () => [],
} as never;
const llm = { embed: async () => ({ vector: new Float32Array(768), model: "m" }) } as never;

describe("RecallService passive exemplar injection", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("attaches relatedExemplars when flag on + opted in", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle scroll handler", mode: "keyword", withRelatedExemplars: true });
    expect(res.relatedExemplars).toBeDefined();
    expect(res.relatedExemplars!.map((e) => e.id)).toEqual(["ex1"]);
  });

  it("omits relatedExemplars when the flag is off", async () => {
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle", mode: "keyword", withRelatedExemplars: true });
    expect(res.relatedExemplars).toBeUndefined();
  });

  it("omits relatedExemplars when not opted in", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const svc = new RecallService({ store, llm, exemplarStore: exemplarStore(), codeEmbedder, installScope: "scope" });
    const res = await svc.search({ query: "throttle", mode: "keyword" });
    expect(res.relatedExemplars).toBeUndefined();
  });
});
