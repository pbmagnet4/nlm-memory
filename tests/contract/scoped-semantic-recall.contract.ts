import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { FactEligibility } from "../../src/ports/fact-store.js";
import type { SearchOptions } from "../../src/ports/session-store.js";
import type { Fact, Session } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface ScopedSemanticHarness {
  name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  foreignTeam(storage: Storage): Promise<void>;
  seedSession(storage: Storage, session: Session, tenantId: string): Promise<void>;
  seedChunk(storage: Storage, sessionId: string, chunkIndex: number, vector: Float32Array, mapped: boolean): Promise<void>;
}

const TENANT = "team_local";
const FOREIGN = "team_foreign";
const WS = "ws_semantic";
const QUERY = new Float32Array(768);
function vector(distance: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = distance;
  return v;
}
function distance(v: Float32Array): number {
  return Math.sqrt(v.reduce((sum, value, i) => sum + (value - QUERY[i]!) ** 2, 0));
}
function assertNeighbors(actual: readonly { distance: number }[], expected: readonly { distance: number }[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((hit, i) => expect(Math.abs(hit.distance - expected[i]!.distance)).toBeLessThanOrEqual(1e-5));
}

export function runScopedSemanticRecallContract(h: ScopedSemanticHarness): void {
  describe(`eligible exact semantic oracle: ${h.name}`, () => {
    let storage: Storage;
    beforeEach(async () => {
      storage = await h.setup();
      await h.foreignTeam(storage);
      await storage.workstreams.create(TENANT, { id: WS, label: "Semantic scope", scope: null });
      await storage.workstreams.create(FOREIGN, { id: "ws_foreign", label: "Foreign scope", scope: null });
    });
    afterEach(async () => h.teardown(storage));

    it("returns fact top-k from the eligible corpus beyond global KNN overfetch", async () => {
      for (const [id, tenant, ws] of [["source", TENANT, WS], ["other", TENANT, null], ["foreign", FOREIGN, "ws_foreign"]] as const) {
        await h.seedSession(storage, makeSession({ id }), tenant);
        if (ws) await storage.sessions.setWorkstreamBinding(tenant, id, ws, "operator", 1);
      }
      const corpus: { fact: Fact; tenant: string; v: Float32Array; ws: string | null; sourceTenant: string }[] = [];
      const add = async (id: string, d: number, overrides: Partial<Fact> = {}, tenant = TENANT, sourceTenant = tenant) => {
        const fact = makeFact({ id, sourceSessionId: "source", subject: "project", predicate: "database", kind: "decision", confidence: 0.9, ...overrides });
        await storage.facts.insert(tenant, fact);
        if (fact.retiredAt) await storage.facts.retire(tenant, fact.id);
        const v = vector(d);
        await storage.facts.upsertEmbedding(tenant, id, v);
        corpus.push({ fact, tenant, v, ws: fact.sourceSessionId === "source" ? WS : fact.sourceSessionId === "foreign" ? "ws_foreign" : null, sourceTenant });
      };
      await add("eligible_b", 2);
      await add("eligible_a", 2);
      await add("eligible_far", 3);
      for (let i = 0; i < 24; i++) {
        await add(`wrong_tenant_${i}`, 0.01, { sourceSessionId: "foreign" }, FOREIGN);
        await add(`wrong_scope_${i}`, 0.02, { sourceSessionId: "other" });
        await add(`retired_${i}`, 0.03, { retiredAt: "2026-01-01T00:00:00Z" });
        await add(`superseded_${i}`, 0.04, { supersededBy: "eligible_a" });
        await add(`low_${i}`, 0.05, { confidence: 0.1 });
        await add(`kind_${i}`, 0.06, { kind: "attribute" });
        await add(`subject_${i}`, 0.07, { subject: "other" });
        await add(`predicate_${i}`, 0.08, { predicate: "other" });
      }
      // A corrupt cross-tenant source reference must never make a local fact eligible.
      await add("cross_tenant_source", 0, { sourceSessionId: "foreign" }, TENANT, FOREIGN);
      const noEmbedding = makeFact({ id: "no_embedding", sourceSessionId: "source" });
      await storage.facts.insert(TENANT, noEmbedding);
      const base: FactEligibility = { workstreamIds: [WS], subject: "project", predicate: "database", kind: "decision", minConfidence: 0.8 };
      const filters: FactEligibility[] = [base, { ...base, includeSuperseded: true }, {}, { workstreamIds: [] }, { workstreamIds: ["ws_foreign"] }, { ...base, subject: "missing" }, { ...base, minConfidence: 0.95 }];
      for (const filter of filters) {
        const expected = corpus.filter(({ fact: f, tenant, ws, sourceTenant }) => tenant === TENANT && sourceTenant === TENANT
          && (filter.workstreamIds === undefined || (ws !== null && filter.workstreamIds.includes(ws)))
          && (filter.subject === undefined || f.subject === filter.subject)
          && (filter.predicate === undefined || f.predicate === filter.predicate)
          && (filter.kind === undefined || f.kind === filter.kind)
          && (filter.minConfidence === undefined || f.confidence >= filter.minConfidence)
          && (filter.includeSuperseded === true || (f.supersededBy === null && f.retiredAt === null)))
          .map(({ fact, v }) => ({ factId: fact.id, distance: distance(v) }))
          .sort((a, b) => a.distance - b.distance || (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0)).slice(0, 3);
        const actual = await storage.facts.semanticSearch(TENANT, QUERY, 3, filter);
        expect(actual.map((x) => x.factId), JSON.stringify(filter)).toEqual(expected.map((x) => x.factId));
        assertNeighbors(actual, expected);
      }
      const defaultHits = await storage.facts.semanticSearch(TENANT, QUERY, 3);
      const explicitHits = await storage.facts.semanticSearch(TENANT, QUERY, 3, {});
      expect(defaultHits).toEqual(explicitHits);
    });

    it("max-pools every eligible chunk, retains unmapped winning chunk, and deterministically breaks ties", async () => {
      const corpus: { session: Session; tenant: string; ws: string | null; chunkIndex: number; v: Float32Array }[] = [];
      const seed = async (id: string, status: Session["status"], tenant: string, ws: string | null, chunks: readonly number[], mapped = true) => {
        const session = makeSession({ id, status });
        await h.seedSession(storage, session, tenant);
        if (ws) await storage.sessions.setWorkstreamBinding(tenant, id, ws, "operator", 1);
        for (const [chunkIndex, d] of chunks.entries()) {
          const v = vector(d);
          await h.seedChunk(storage, id, chunkIndex, v, mapped);
          corpus.push({ session, tenant, ws, chunkIndex, v });
        }
      };
      await seed("eligible_b", "closed", TENANT, WS, [2]);
      await seed("eligible_a", "closed", TENANT, WS, [4, 2, 2], false);
      await seed("many_chunks", "closed", TENANT, WS, Array.from({ length: 64 }, (_, i) => 0.5 + i * 0.001));
      await seed("wrong_scope", "closed", TENANT, null, Array(64).fill(0.01));
      await seed("foreign", "closed", FOREIGN, "ws_foreign", Array(64).fill(0.02));
      await seed("superseded", "superseded", TENANT, WS, Array(64).fill(0.03));
      await seed("replaced", "replaced", TENANT, WS, Array(64).fill(0.04));
      await h.seedSession(storage, makeSession({ id: "no_embedding" }), TENANT);
      await storage.sessions.setWorkstreamBinding(TENANT, "no_embedding", WS, "operator", 1);
      for (const opts of [{ workstreamIds: [WS] }, { workstreamIds: [WS], includeSuperseded: true }, {}, { workstreamIds: [] }, { workstreamIds: ["ws_foreign"] }] satisfies SearchOptions[]) {
        const best = new Map<string, { sessionId: string; chunkIndex: number; distance: number }>();
        for (const row of corpus) {
          if (row.tenant !== TENANT || row.session.status === "replaced" || (opts.includeSuperseded !== true && row.session.status === "superseded")
            || (opts.workstreamIds !== undefined && (row.ws === null || !opts.workstreamIds.includes(row.ws)))) continue;
          const hit = { sessionId: row.session.id, chunkIndex: row.chunkIndex, distance: distance(row.v) };
          const prior = best.get(hit.sessionId);
          if (!prior || hit.distance < prior.distance || (hit.distance === prior.distance && hit.chunkIndex < prior.chunkIndex)) best.set(hit.sessionId, hit);
        }
        const expected = [...best.values()].sort((a, b) => a.distance - b.distance || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)).slice(0, 3);
        const actual = await storage.sessions.semanticSearch(TENANT, QUERY, 3, opts);
        expect(actual.map((x) => [x.sessionId, x.chunkIndex]), JSON.stringify(opts)).toEqual(expected.map((x) => [x.sessionId, x.chunkIndex]));
        assertNeighbors(actual, expected);
      }
      await storage.sessions.setWorkstreamBinding(TENANT, "eligible_a", null, null, null);
      expect((await storage.sessions.semanticSearch(TENANT, QUERY, 3, { workstreamIds: [WS] })).map((x) => x.sessionId)).toEqual(["many_chunks", "eligible_b"]);
    });

    it("expands equal-distance boundaries before selecting deterministic IDs", async () => {
      for (let i = 95; i >= 0; i--) {
        const id = `tie_${String(i).padStart(3, "0")}`;
        await h.seedSession(storage, makeSession({ id }), TENANT);
        await h.seedChunk(storage, id, 2, vector(2), false);
        await h.seedChunk(storage, id, 1, vector(2), false);
        await storage.facts.insert(TENANT, makeFact({ id, sourceSessionId: id }));
        await storage.facts.upsertEmbedding(TENANT, id, vector(2));
      }
      expect(await storage.sessions.semanticSearch(TENANT, QUERY, 1)).toEqual([{ sessionId: "tie_000", chunkIndex: 1, distance: 2 }]);
      expect(await storage.facts.semanticSearch(TENANT, QUERY, 1)).toEqual([{ factId: "tie_000", distance: 2 }]);
    });

    it("falls back exactly beyond the native KNN cap with many chunks and foreign facts", async () => {
      await h.seedSession(storage, makeSession({ id: "many" }), TENANT);
      await h.seedSession(storage, makeSession({ id: "far" }), TENANT);
      await h.seedSession(storage, makeSession({ id: "foreign" }), FOREIGN);
      await h.seedChunk(storage, "far", 3, vector(2), false);
      await storage.facts.insert(TENANT, makeFact({ id: "far", sourceSessionId: "far" }));
      await storage.facts.upsertEmbedding(TENANT, "far", vector(2));
      for (let i = 0; i < 4100; i++) {
        await h.seedChunk(storage, "many", i, vector(1), false);
        const id = `cap_${i}`;
        await storage.facts.insert(FOREIGN, makeFact({ id, sourceSessionId: "foreign" }));
        await storage.facts.upsertEmbedding(FOREIGN, id, vector(0.01));
      }
      expect(await storage.sessions.semanticSearch(TENANT, QUERY, 2)).toEqual([
        { sessionId: "many", chunkIndex: 0, distance: 1 }, { sessionId: "far", chunkIndex: 3, distance: 2 },
      ]);
      expect(await storage.facts.semanticSearch(TENANT, QUERY, 1)).toEqual([{ factId: "far", distance: 2 }]);
    }, 60_000);

    it("returns no neighbors for an eligible corpus with no embeddings", async () => {
      await h.seedSession(storage, makeSession({ id: "empty" }), TENANT);
      await storage.sessions.setWorkstreamBinding(TENANT, "empty", WS, "operator", 1);
      await storage.facts.insert(TENANT, makeFact({ sourceSessionId: "empty" }));
      expect(await storage.sessions.semanticSearch(TENANT, QUERY, 5, { workstreamIds: [WS] })).toEqual([]);
      expect(await storage.facts.semanticSearch(TENANT, QUERY, 5, { workstreamIds: [WS] })).toEqual([]);
    });
  });
}
