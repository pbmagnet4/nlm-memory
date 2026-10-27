/**
 * M2 (T1036): BM25 keyword leg + RRF upper-band ordering — failing first.
 *
 * 1. IDF discrimination: a fact matching a rare query token must outrank a
 *    fact matching only a ubiquitous token (raw overlap ties them).
 * 2. Length norm: equal token overlap, shorter field wins.
 * 3. RRF: a semantic hit with strong keyword support outranks a
 *    semantic-only hit with marginally higher similarity.
 * 4. Bands preserved: keyword-only backfill stays below the semantic band,
 *    and keywordScore/semanticScore/matchedIn remain exposed.
 */

import { describe, expect, it } from "vitest";
import { FactRecallService } from "../../../../src/core/recall-facts/fact-recall-service.js";
import type {
  FactListFilter,
  FactSemanticNeighbor,
  FactStore,
} from "../../../../src/ports/fact-store.js";
import { StubEmbedder } from "../../../fixtures/llm-stubs.js";
import type { Fact, FactHistoryChain } from "../../../../src/shared/types.js";
import { makeFact } from "../../../fixtures/facts.js";
import { resetLaneHealthForTests } from "../../../../src/core/health/embedding-lane-state.js";

class Store implements FactStore {
  constructor(
    private readonly facts: Fact[],
    private readonly neighbors: FactSemanticNeighbor[] = [],
  ) {}
  async insert(): Promise<void> {}
  async insertMany(): Promise<void> {}
  async getById(_t: string, id: string): Promise<Fact | null> {
    return this.facts.find((f) => f.id === id) ?? null;
  }
  async getByIds(_t: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>> {
    const set = new Set(ids);
    return this.facts.filter((f) => set.has(f.id));
  }
  async findCurrent(): Promise<Fact | null> {
    return null;
  }
  async list(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async listBySession(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async summarizeCurrentValues() { return { distinctValueCount: 0, sourceSessionCount: 0, examples: [] }; }
  async listSubjectStats() { return []; }
  async listBySubjects() { return []; }
  async listBySessions(): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async markSuperseded(): Promise<void> {}
  async retire(): Promise<void> {}
  async listForRecall(_t: string, _f: FactListFilter): Promise<ReadonlyArray<Fact>> {
    return this.facts;
  }
  async semanticSearch(): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    return this.neighbors;
  }
  async getHistory(): Promise<ReadonlyArray<FactHistoryChain>> {
    return [];
  }
  async corroborationCounts(
    _t: string,
    triples: ReadonlyArray<{ subject: string; predicate: string; value: string }>,
  ): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const t of triples) m.set(`${t.subject} ${t.predicate} ${t.value}`, 1);
    return m;
  }
  async upsertEmbedding(): Promise<void> {}
  async ingestSessionFacts(): Promise<void> {}
}

const svc = (facts: Fact[], neighbors: FactSemanticNeighbor[] = []) =>
  new FactRecallService({ factStore: new Store(facts, neighbors), llm: new StubEmbedder() });

const F = (id: string, value: string) =>
  makeFact({ id, subject: `subj_${id}`, predicate: `pred_${id}`, value, confidence: 0.9, sourceSessionId: "s" });

describe("M2 BM25 keyword leg", () => {
  it("ranks a rare-token match above a ubiquitous-token match", async () => {
    resetLaneHealthForTests();
    const common = "project";
    const facts = [
      F("f_common", `${common} deployment status green`),
      F("f_rare", `${common} zebrafish migration blocked`),
      F("f_filler", `${common} status weekly sync`),
    ];
    const res = await svc(facts).search("team_local", { query: `${common} status zebrafish`, mode: "keyword", limit: 3 });
    expect(res.results[0]!.id).toBe("f_rare");
  });

  it("prefers the shorter field on equal token overlap", async () => {
    resetLaneHealthForTests();
    const facts = [
      F("f_long", "alpha beta gamma delta epsilon zeta eta theta rollout plan for next quarter review"),
      F("f_short", "alpha rollout"),
    ];
    const res = await svc(facts).search("team_local", { query: "alpha rollout", mode: "keyword", limit: 2 });
    expect(res.results[0]!.id).toBe("f_short");
  });
});

describe("M2 RRF upper-band ordering", () => {
  it("lets strong keyword consensus overtake a middling semantic rank", async () => {
    resetLaneHealthForTests();
    // Keyword ranks (query "zebrafish migration blocked"): f_c matches all 3
    // tokens (kw 1), f_b matches 2 (kw 2), f_a matches 1 (kw 3).
    // Semantic ranks: f_a 0.90 (sem 1), f_b 0.89 (sem 2), f_c 0.88 (sem 3).
    // RRF(60): f_a = 1/61+1/63, f_b = 2/62, f_c = 1/63+1/61 → f_c edges out
    // f_b on consensus while f_a still leads on similarity.
    const facts = [
      F("f_a", "zebrafish quarterly planning memo"),
      F("f_b", "zebrafish migration weekly sync"),
      F("f_c", "zebrafish migration blocked"),
    ];
    const neighbors: FactSemanticNeighbor[] = [
      { factId: "f_a", distance: 0.45 },
      { factId: "f_b", distance: 0.46 },
      { factId: "f_c", distance: 0.47 },
    ];
    const res = await svc(facts, neighbors).search("team_local", { query: "zebrafish migration blocked", mode: "hybrid", limit: 3 });
    expect(res.results.map((r) => r.id)).toEqual(["f_a", "f_c", "f_b"]);
    for (const r of res.results) {
      expect(r.matchedIn).toContain("semantic");
      expect(r).toHaveProperty("keywordScore");
      expect(r).toHaveProperty("semanticScore");
    }
  });

  it("keeps keyword-only backfill below the semantic band", async () => {
    resetLaneHealthForTests();
    const facts = [F("f_sem", "zebrafish migration blocked"), F("f_kw", "zebrafish weekly sync notes")];
    const neighbors: FactSemanticNeighbor[] = [{ factId: "f_sem", distance: 0.45 }];
    const res = await svc(facts, neighbors).search("team_local", { query: "zebrafish migration", mode: "hybrid", limit: 2 });
    expect(res.results[0]!.id).toBe("f_sem");
    expect(res.results[0]!.matchScore).toBeGreaterThanOrEqual(0.5);
    expect(res.results[1]!.id).toBe("f_kw");
    expect(res.results[1]!.matchScore).toBeLessThan(0.5);
  });
});
