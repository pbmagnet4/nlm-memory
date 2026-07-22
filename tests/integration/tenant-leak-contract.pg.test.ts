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
 * Case 10 (concurrent tenants) is explicitly out of scope here — it requires
 * M7's per-file pg schema isolation harness, not this shared-schema fixture.
 * Cases 7, 8, 12 mirror the sqlite file's it.todo (M3/M4/M6 surfaces).
 */
import { afterEach, describe, expect, it } from "vitest";
import { seedTenantCorpusPg, type SeededTenantCorpusPg } from "../helpers/seed-tenant-corpus-pg.js";
import { rollupWorkstream } from "../../src/core/workstream/rollup.js";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import { buildFailureModeBlock } from "../../src/core/signals/failure-mode-recall.js";
import { getSessionHandler } from "../../src/mcp/server.js";
import type { Signal } from "../../src/shared/types.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];

describe.skipIf(!PG_TEST_URL)("tenant leak-test contract (spec §6, pg lane)", () => {
  let fixture: SeededTenantCorpusPg;

  afterEach(async () => {
    await fixture.storage.close();
  });

  async function seed(): Promise<SeededTenantCorpusPg> {
    fixture = await seedTenantCorpusPg(PG_TEST_URL!);
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

  it.todo(
    "case 8: token-swap — the same request body issued with A's then B's token returns disjoint result sets; a " +
      "bad/absent token gets 401 with no corpus read",
  );

  it.todo(
    "case 10: concurrent tenants (pg) — interleaved A and B reads/writes on one pg instance never bleed " +
      "(requires M7's isolated per-file pg schema harness; this file's shared-schema fixture is serial)",
  );

  it.todo(
    "case 12: state isolation (M6) — per-conversation memo state and query/citation/miss logs never mix tenants; " +
      "a conversation-id collision across teams does not share dedup state",
  );
});
