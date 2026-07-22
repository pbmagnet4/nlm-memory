// tests/integration/tenant-leak-contract.pg.test.ts
/**
 * The standing cross-tenant leak-test contract (program spec §6), pg lane
 * (Wave C5). Mirrors the sqlite contract's (tenant-leak-contract.test.ts)
 * cases that have a pg-reachable shape — the same fixture data, the same
 * store methods (now the Pg* implementations), the same assertions.
 *
 * Requires NLM_PG_TEST_URL. Set to a connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 * Skips cleanly (describe.skipIf) when absent — per program spec §1 item 19,
 * this absence must be reported, not papered over: a green run of this
 * file's *sibling* sqlite suite does NOT mean the pg lane passed.
 *
 * Case 10 (concurrent tenants) runs here on the pg-test-schema helper's
 * per-file isolated schema (M7): team_a and team_b share that one schema
 * (row-level tenancy, matching the real hosted topology), and the test
 * interleaves concurrent Promise.all batches of reads and writes across
 * both tenants against the one live pg instance.
 * M3 flips case 8 (token-swap auth) to a real assertion. Case 7 (ingest
 * attribution) is M4's job; case 12 (M6 file-state isolation) mirrors the
 * sqlite file's it.todo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { seedTenantCorpusPg, type SeededTenantCorpusPg } from "../helpers/seed-tenant-corpus-pg.js";
import { rollupWorkstream } from "../../src/core/workstream/rollup.js";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import { buildFailureModeBlock } from "../../src/core/signals/failure-mode-recall.js";
import { getSessionHandler } from "../../src/mcp/server.js";
import { createApp } from "../../src/http/app.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import { PgTeamTokenStore } from "../../src/core/tenancy/team-token-store.js";
import { hashTeamToken } from "../../src/core/tenancy/team-auth.js";
import type { Fact, Signal } from "../../src/shared/types.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];

describe.skipIf(!PG_TEST_URL)("tenant leak-test contract (spec §6, pg lane)", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let fixture: SeededTenantCorpusPg;

  afterEach(async () => {
    await fixture.storage.close();
  });

  async function seed(): Promise<SeededTenantCorpusPg> {
    fixture = await seedTenantCorpusPg(pgUrl());
    return fixture;
  }

  it("case 1: recall as team A never returns a B session/fact — keyword-adjacent store paths", async () => {
    await seed();
    const { A, B } = fixture.ids;

    const sessions = await fixture.sessionStore.getByIds("team_a", [...A.sessionIds, ...B.sessionIds]);
    expect(sessions.map((s) => s.id).sort()).toEqual([...A.sessionIds].sort());

    const factsForRecall = await fixture.factStore.listForRecall("team_a", {});
    expect(factsForRecall.map((f) => f.id).sort()).toEqual([...A.factIds].sort());

    const facts = await fixture.factStore.getByIds("team_a", [...A.factIds, ...B.factIds]);
    expect(facts.map((f) => f.id).sort()).toEqual([...A.factIds].sort());
  });

  it("case 2: vector-neighbor leak — a B fact embedded near an A query is not returned by A's semantic search (pgvector)", async () => {
    await seed();
    const { A, B } = fixture.ids;
    const queryVector = new Float32Array(768);
    for (let i = 0; i < 768; i++) queryVector[i] = Math.sin((i + 1) * 1); // matches A's fact-1 embedding exactly

    const neighbors = await fixture.factStore.semanticSearch("team_a", queryVector, 5);
    const neighborIds = neighbors.map((n) => n.factId);
    expect(neighborIds).toContain(A.factIds[0]);
    expect(neighborIds).not.toContain(B.factIds[0]);

    const resolved = await fixture.factStore.getByIds("team_a", [A.factIds[0], B.factIds[0]]);
    expect(resolved.map((f) => f.id)).toEqual([A.factIds[0]]);
  });

  it("case 3: entity-filtered recall as A never returns a B session; the shared surface form resolves to two " +
      "tenant-local entity rows; entity merge refuses a source/target that lives only in B", async () => {
    await seed();
    const { A, B } = fixture.ids;

    const entityRows = await fixture.storage.pgPool().query<{ tenant_id: string }>(
      "SELECT tenant_id FROM entities WHERE canonical = $1 ORDER BY tenant_id",
      [A.entityCanonical],
    );
    expect(entityRows.rows.map((r) => r.tenant_id)).toEqual(["team_a", "team_b"]);

    const aEntities = await fixture.sessionStore.getEntities("team_a", A.sessionIds[1]);
    expect(aEntities).toContain(A.soloEntityCanonical);
    expect(aEntities).not.toContain(B.soloEntityCanonical);

    await expect(
      fixture.entityStore.merge("team_a", B.soloEntityCanonical, A.entityCanonical),
    ).rejects.toThrow(/source entity not found/);
    await expect(
      fixture.entityStore.merge("team_a", A.soloEntityCanonical, B.soloEntityCanonical),
    ).rejects.toThrow(/target entity not found/);
  });

  it("case 4: by-id refusal — SessionStore.getById / FactStore.getById for a cross-tenant id return the not-found shape", async () => {
    await seed();
    const { A, B } = fixture.ids;

    expect(await fixture.sessionStore.getById("team_a", B.sessionIds[0])).toBeNull();
    expect(await fixture.sessionStore.getById("team_a", "nonexistent-session")).toBeNull();
    expect(await fixture.factStore.getById("team_a", B.factIds[0])).toBeNull();
    expect(await fixture.factStore.getById("team_a", "nonexistent-fact")).toBeNull();
  });

  it("case 5: workstream surfaces — recall_workstream never pairs or returns rows across tenants", async () => {
    await seed();
    const { A, B } = fixture.ids;
    const rollupDeps = {
      workstreams: fixture.workstreamStore,
      sessions: fixture.sessionStore,
      facts: fixture.factStore,
      exemplars: fixture.exemplarStore,
    };

    const rollup = await rollupWorkstream(rollupDeps, "team_a", A.workstreamId);
    expect(rollup?.workstream.id).toBe(A.workstreamId);
    expect(rollup?.sessionIds).toEqual([A.sessionIds[0]]);
    expect(rollup?.facts.map((f) => f.id)).not.toContain(B.factIds[0]);

    expect(await rollupWorkstream(rollupDeps, "team_a", B.workstreamId)).toBeNull();

    const candidates = await fixture.workstreamStore.candidatesByEntityOverlap("team_a", [A.entityCanonical], 10);
    expect(candidates.map((c) => c.workstreamId)).toContain(A.workstreamId);
    expect(candidates.map((c) => c.workstreamId)).not.toContain(B.workstreamId);
  });

  it("case 6: digest / failure-mode block for A contain no B content; signals with identical repo basenames never cross", async () => {
    await seed();
    const { A, B } = fixture.ids;

    const localDate = new Date("2026-07-20T00:00:00Z");
    const dateStr = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
    const digest = await buildWorkDigest(
      { store: fixture.sessionStore, workstreams: fixture.workstreamStore },
      "team_a",
      dateStr,
    );
    expect(digest.coverage.sessions).toBe(2);
    expect(digest.coverage.sessions).not.toBe(4);

    const aSignals = await fixture.signalStore.listForAggregation("team_a", { installScope: "team_a", repo: A.repo });
    expect(aSignals.map((s) => s.id)).toEqual([A.signalId]);
    const crossRepo = await fixture.signalStore.listForAggregation("team_a", { installScope: "team_a", repo: B.repo });
    expect(crossRepo).toEqual([]);

    const sharedInstallScope = "shared-install-scope";
    const sharedRepo = "/shared/repo/path";
    const collidingSignal = (teamId: "team_a" | "team_b", id: string): Signal => ({
      id, v: 1, installScope: sharedInstallScope, kind: "gate", producer: "quality-gate",
      outcome: "pass", model: "qwen3-coder", repo: sharedRepo, step: null, detail: null,
      sessionId: null, scope: null, ts: "2026-07-21T00:00:00Z", createdAt: "2026-07-21T00:00:00Z",
    });
    await fixture.signalStore.insert("team_a", collidingSignal("team_a", "collide-a"));
    await fixture.signalStore.insert("team_b", collidingSignal("team_b", "collide-b"));

    const aColliding = await fixture.signalStore.listForAggregation("team_a", { installScope: sharedInstallScope, repo: sharedRepo });
    expect(aColliding.map((s) => s.id)).toEqual(["collide-a"]);

    const block = await buildFailureModeBlock("team_a", fixture.signalStore, { installScope: "team_a", repo: A.repo });
    expect(block).toBe("");
  });

  it("case 9: no-parameter override — a crafted tenant field on the MCP input never widens results beyond the caller's tenantId", async () => {
    await seed();
    const { A, B } = fixture.ids;
    const deps = { recall: {} as never, store: fixture.sessionStore };

    const craftedOwnSession = { id: A.sessionIds[0], tenant: "team_b", scope: "*" };
    const ownResult = await getSessionHandler(deps, "team_a", craftedOwnSession as unknown as { id: string });
    expect(ownResult.isError).toBeUndefined();

    const craftedCrossTenant = { id: B.sessionIds[0], tenant: "team_a", scope: "*" };
    const crossResult = await getSessionHandler(deps, "team_a", craftedCrossTenant as unknown as { id: string });
    expect(crossResult.isError).toBe(true);
  });

  // Case 11 (store guard) is backend-agnostic static source analysis — it
  // scans TypeScript source files, not a live database — so it has no
  // separate pg-reachable shape. Covered once by tests/integration/tenant-guard.test.ts.

  it.todo(
    "case 7: ingest attribution — a session pushed via A's source token is recallable by A, invisible to B; a " +
      "revoked token's push is rejected",
  );

  // Case 8 (M3, spec §3), pg twin. Mirrors the sqlite file's case 8 against
  // PgTeamTokenStore + the real HTTP app on the isolated per-file schema.
  it("case 8: token-swap — the same request body issued with A's then B's token returns disjoint result sets; a " +
      "bad/absent token gets 401 with no corpus read", async () => {
    await seed();
    const prevHosted = process.env["NLM_HOSTED"];
    process.env["NLM_HOSTED"] = "1";
    try {
      const teamTokens = new PgTeamTokenStore(fixture.storage.pgPool());
      const tokenA = "token-team-a-case8-pg";
      const tokenB = "token-team-b-case8-pg";
      const tokenRevoked = "token-revoked-case8-pg";
      await teamTokens.insert(hashTeamToken(tokenA), "team_a");
      await teamTokens.insert(hashTeamToken(tokenB), "team_b");
      await teamTokens.insert(hashTeamToken(tokenRevoked), "team_a");
      await teamTokens.revoke(hashTeamToken(tokenRevoked));

      const { A, B } = fixture.ids;
      const recall = new RecallService({ store: fixture.sessionStore, llm: new FixedEmbedder() });
      const app = createApp({ recall, store: fixture.sessionStore, teamTokens });

      const resA = await app.request("/api/recall?q=onboarding&mode=keyword", {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(resA.status).toBe(200);
      const idsA = ((await resA.json()) as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(idsA).toContain(A.sessionIds[0]);
      expect(idsA).not.toContain(B.sessionIds[0]);

      const resB = await app.request("/api/recall?q=onboarding&mode=keyword", {
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(resB.status).toBe(200);
      const idsB = ((await resB.json()) as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(idsB).toContain(B.sessionIds[0]);
      expect(idsB).not.toContain(A.sessionIds[0]);

      let called = false;
      const spyRecall = { search: async () => { called = true; return { query: "", mode: "keyword" as const, limit: 0, total: 0, results: [] }; } };
      const spyApp = createApp({ recall: spyRecall as never, store: fixture.sessionStore, teamTokens });

      const resBad = await spyApp.request("/api/recall?q=x&mode=keyword", {
        headers: { authorization: "Bearer garbage-token-xyz-pg" },
      });
      expect(resBad.status).toBe(401);
      expect(called).toBe(false);

      const resRevoked = await spyApp.request("/api/recall?q=x&mode=keyword", {
        headers: { authorization: `Bearer ${tokenRevoked}` },
      });
      expect(resRevoked.status).toBe(401);
      expect(called).toBe(false);

      const resAbsent = await spyApp.request("/api/recall?q=x&mode=keyword");
      expect(resAbsent.status).toBe(401);
      expect(called).toBe(false);
    } finally {
      if (prevHosted === undefined) delete process.env["NLM_HOSTED"];
      else process.env["NLM_HOSTED"] = prevHosted;
    }
  });

  it("case 10: concurrent tenants (pg) — interleaved A and B reads/writes on one pg instance never bleed", async () => {
    await seed();
    const { A, B } = fixture.ids;

    const concurrentFact = (teamId: "team_a" | "team_b", n: number): Fact => ({
      id: `fact-${teamId}-concurrent-${n}`,
      kind: "attribute",
      subject: `${teamId}-concurrent-subject-${n}`,
      predicate: "uses",
      value: `${teamId} concurrent value ${n}`,
      sourceSessionId: teamId === "team_a" ? A.sessionIds[0] : B.sessionIds[0],
      sourceQuote: null,
      createdAt: "2026-07-22T00:00:00Z",
      supersededBy: null,
      confidence: 0.9,
    });

    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round++) {
      const [, , aFacts, bFacts, aSessions, bSessions] = await Promise.all([
        fixture.factStore.insert("team_a", concurrentFact("team_a", round)),
        fixture.factStore.insert("team_b", concurrentFact("team_b", round)),
        fixture.factStore.listForRecall("team_a", {}),
        fixture.factStore.listForRecall("team_b", {}),
        fixture.sessionStore.getByIds("team_a", [...A.sessionIds, ...B.sessionIds]),
        fixture.sessionStore.getByIds("team_b", [...A.sessionIds, ...B.sessionIds]),
      ]);

      expect(aFacts.some((f) => f.id.startsWith("fact-team_b"))).toBe(false);
      expect(bFacts.some((f) => f.id.startsWith("fact-team_a"))).toBe(false);
      expect(aSessions.map((s) => s.id)).toEqual(expect.arrayContaining([...A.sessionIds]));
      expect(aSessions.some((s) => (B.sessionIds as readonly string[]).includes(s.id))).toBe(false);
      expect(bSessions.map((s) => s.id)).toEqual(expect.arrayContaining([...B.sessionIds]));
      expect(bSessions.some((s) => (A.sessionIds as readonly string[]).includes(s.id))).toBe(false);
    }

    // Settled-state check: every concurrently-inserted fact landed under its
    // own tenant only, across the whole interleaved run.
    const finalA = await fixture.factStore.listForRecall("team_a", {});
    const finalB = await fixture.factStore.listForRecall("team_b", {});
    for (let round = 0; round < ROUNDS; round++) {
      expect(finalA.map((f) => f.id)).toContain(`fact-team_a-concurrent-${round}`);
      expect(finalB.map((f) => f.id)).toContain(`fact-team_b-concurrent-${round}`);
    }
    expect(finalA.some((f) => f.id.startsWith("fact-team_b"))).toBe(false);
    expect(finalB.some((f) => f.id.startsWith("fact-team_a"))).toBe(false);
  });

  it.todo(
    "case 12: state isolation (M6) — per-conversation memo state and query/citation/miss logs never mix tenants; " +
      "a conversation-id collision across teams does not share dedup state",
  );
});
