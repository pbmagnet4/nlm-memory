// T1770: per-stage wall-time attribution on RecallResult.timingsMs.
// The hook lane measures 0.8-2.9 s end to end; these tests pin which stage
// the time was attributed to.
import { beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../../../src/core/recall/recall-service.js";
import { StubEmbedder } from "../../../fixtures/llm-stubs.js";
import { makeSession } from "../../../fixtures/sessions.js";
import { resetLaneHealthForTests } from "../../../../src/core/health/embedding-lane-state.js";
import { resetForTests } from "../../../../src/core/health/embed-inflight.js";
import type {
  KeywordNeighbor,
  SearchOptions,
  SemanticNeighbor,
  SessionStore,
} from "../../../../src/ports/session-store.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../../../src/ports/llm-client.js";
import type { FactStore } from "../../../../src/ports/fact-store.js";
import type { Session } from "../../../../src/shared/types.js";

const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

class InMemoryStore implements SessionStore {
  constructor(
    private readonly sessions: Session[],
    private readonly neighbors: SemanticNeighbor[] = [],
    private readonly keywordHits: KeywordNeighbor[] = [],
  ) {}
  async list(): Promise<ReadonlyArray<Session>> { return this.sessions; }
  async getById(_tenantId: string, id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async getByIds(_tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    return this.sessions.filter((s) => ids.includes(s.id));
  }
  async semanticSearch(): Promise<ReadonlyArray<SemanticNeighbor>> { return this.neighbors; }
  async keywordSearch(): Promise<ReadonlyArray<KeywordNeighbor>> { return this.keywordHits; }
  async resolveSuccessors(): Promise<Map<string, string>> { return new Map(); }
  async listByDateRange(): Promise<ReadonlyArray<Session>> { return []; }
  async updateStatus(): Promise<void> {}
  async markSuperseded(): Promise<void> {}
  async setWorkstreamBinding(): Promise<void> {}
  async listSessionIdsByWorkstreams(): Promise<ReadonlyArray<string>> { return []; }
  async getEntities(): Promise<ReadonlyArray<string>> { return []; }
  async getWorkstreamIds(): Promise<Map<string, string | null>> { return new Map(); }
}

/** Embeds (and optionally rewrites) with a fixed sleep, so a stage's recorded
 *  duration must be at least the sleep. */
class SlowEmbedder implements LLMClient {
  constructor(
    private readonly embedMs: number,
    private readonly rewriteMs = 0,
  ) {}
  async embed(): Promise<EmbedResult> {
    await delay(this.embedMs);
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "slow-test" };
  }
  async rewriteForRecall(query: string) {
    await delay(this.rewriteMs);
    return { keywordQuery: query, semanticQuery: query };
  }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<ClassifyResult> { throw new Error("stub"); }
}

const corpus: Session[] = [
  makeSession({ id: "a", label: "Hono router setup", entities: ["NLM"], decisions: ["chose Hono over Express"] }),
  makeSession({ id: "b", label: "pgvector migration plan", entities: ["NLM", "Postgres"] }),
];

function service(llm: LLMClient, store: SessionStore, factStore?: FactStore) {
  return new RecallService({ store, llm, ...(factStore ? { factStore } : {}) });
}

describe("RecallService stage timings (T1770)", () => {
  beforeEach(() => {
    resetLaneHealthForTests();
    resetForTests();
  });

  it("keyword mode records keyword + total and omits the legs that never ran", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "a", score: 3 }]);
    const result = await service(new StubEmbedder(), store)
      .search("team_local", { query: "hono", mode: "keyword" });
    const timings = result.timingsMs!;
    expect(timings).toBeDefined();
    expect(timings.keyword).toBeTypeOf("number");
    expect(timings.total).toBeTypeOf("number");
    for (const v of Object.values(timings)) expect(Number.isInteger(v)).toBe(true);
    for (const absent of ["rewrite", "embed", "semantic", "facts", "concepts", "exemplars"]) {
      expect(timings[absent]).toBeUndefined();
    }
  });

  it("hybrid records embed/semantic/keyword; a slow embedder puts the time in embed", async () => {
    const store = new InMemoryStore(
      corpus,
      [{ sessionId: "b", distance: 0.2, chunkIndex: 0 }],
      [{ sessionId: "a", score: 2 }],
    );
    const result = await service(new SlowEmbedder(60), store)
      .search("team_local", { query: "pgvector hono", mode: "hybrid" });
    const timings = result.timingsMs!;
    expect(timings.embed).toBeGreaterThanOrEqual(50); // 60 ms sleep, integer ms
    expect(timings.embed).toBeLessThan(3_000);
    expect(timings.keyword).toBeTypeOf("number");
    expect(timings.semantic).toBeTypeOf("number");
    expect(timings.total).toBeGreaterThanOrEqual(timings.embed!);
  });

  it("rewrite=true records the rewrite stage", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "a", score: 1 }]);
    const result = await service(new SlowEmbedder(1, 40), store)
      .search("team_local", { query: "hono", mode: "keyword", rewrite: true });
    expect(result.timingsMs!.rewrite).toBeGreaterThanOrEqual(30);
  });

  it("facts runs only when requested with a fact store; timing recorded even when no facts match", async () => {
    const store = new InMemoryStore(corpus, [], [{ sessionId: "a", score: 1 }]);
    const factStore = { list: async () => [] } as unknown as FactStore;
    const svc = service(new StubEmbedder(), store, factStore);

    const without = await svc.search("team_local", { query: "hono", mode: "keyword" });
    expect(without.timingsMs!.facts).toBeUndefined();

    const withFacts = await svc.search("team_local", { query: "hono", mode: "keyword", withRelatedFacts: true });
    expect(withFacts.timingsMs!.facts).toBeTypeOf("number");
  });

  it("embed failures still attribute their time (semantic-mode early return carries timings)", async () => {
    const store = new InMemoryStore(corpus, [{ sessionId: "b", distance: 0.2, chunkIndex: 0 }]);
    const result = await service(new StubEmbedder(true), store)
      .search("team_local", { query: "pgvector", mode: "semantic" });
    expect(result.modeUnavailable).toBe("ollama_unreachable");
    const timings = result.timingsMs!;
    expect(timings.embed).toBeTypeOf("number"); // the failed leg ran and is paid for
    expect(timings.semantic).toBeUndefined(); // never reached the store
    expect(timings.total).toBeTypeOf("number");
  });

  it("short-circuit returns carry no timings", async () => {
    const store = new InMemoryStore(corpus);
    const result = await service(new StubEmbedder(), store).search("team_local", { query: "" });
    expect(result.total).toBe(0);
    expect(result.timingsMs).toBeUndefined();
  });
});
