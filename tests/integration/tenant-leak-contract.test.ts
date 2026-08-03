// tests/integration/tenant-leak-contract.test.ts
/**
 * The standing cross-tenant leak-test contract (program spec §6), sqlite
 * lane. This file is test-first at the contract level (Global Constraints,
 * Wave A): it enumerates every adversarial case from spec §6 that has a
 * sqlite-reachable shape (1-9, 11-12) as a named `it()`. Case 10
 * (concurrency) needs a real concurrent-writer db and lives only in the pg
 * twin (tenant-leak-contract.pg.test.ts) — it already landed there via M7's
 * usePgTestSchema isolated-schema harness, so it is not "pending" anywhere;
 * sqlite's single-writer model has no equivalent case to assert.
 *
 * Wave B1-B4 landed SessionStore/FactStore/CodeExemplarStore/SignalStore/
 * WorkstreamStore/EntityStore/OutcomeStore threading, so cases 1-6 flip here
 * to real assertions against the fixture's real (tenant-threaded) stores and
 * the service-layer functions built directly on them (rollupWorkstream,
 * buildWorkDigest, buildFailureModeBlock).
 *
 * Wave C1's surface threading + Wave C4's guard test complete cases 9 and 11
 * (below). M3 flips case 8 (token-swap auth) to a real assertion against the
 * real HTTP app + TeamTokenStore. Case 7 (ingest attribution) is M4's job.
 * M6 Tasks 1-4 tenant-threaded the file-state modules (memo, hook-log,
 * query/citation/miss logs, supersedence-log, etc.) and un-gated the
 * M6-FILTER hosted routes, so Task 3 here flips case 12 (file-state
 * isolation) to a real assertion too. Every enumerated case (1-9, 11, 12) is
 * now real in this file — none remain `it.todo`.
 *
 * The pg twin (tenant-leak-contract.pg.test.ts, Wave C5) mirrors the sqlite
 * cases that have pg-reachable shapes plus case 10. Case 12 is deliberately
 * NOT duplicated there: the file-state modules are plain local-filesystem
 * JSONL writers with no sqlite/pg involvement at all, so the pg lane would
 * assert nothing the sqlite case doesn't already cover — see the one-line
 * pointer comment in that file instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTenantCorpus, type SeededTenantCorpus } from "../helpers/seed-tenant-corpus.js";
import { rollupWorkstream } from "../../src/core/workstream/rollup.js";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import { buildFailureModeBlock } from "../../src/core/signals/failure-mode-recall.js";
import { getSessionHandler } from "../../src/mcp/server.js";
import { createApp } from "../../src/http/app.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FixedEmbedder, StubClassifier, StubEmbedder } from "../fixtures/llm-stubs.js";
import { SourceRegistry } from "../../src/core/sources/source-registry.js";
import { TeamTokenStore } from "../../src/core/tenancy/team-token-store.js";
import { hashTeamToken } from "../../src/core/tenancy/team-auth.js";
import type { Signal } from "../../src/shared/types.js";
import { loadSurfaced, recordSurfaced } from "../../src/core/hook/memo.js";
import { logQuery, readQueryLog, recallStats, type LogEntry } from "../../src/core/recall/query-log.js";
import { appendCitation, readCitationLog, citationStats, type CitationEntry } from "../../src/core/recall/citation-log.js";
import { appendMiss, missStats, type MissEntry } from "../../src/core/recall/miss-log.js";
import { appendHookLog, type HookLogEntry } from "../../src/core/hook/hook-log.js";
import { appendSupersedence, readSupersedenceLog } from "../../src/core/storage/supersedence-log.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("tenant leak-test contract (spec §6, sqlite lane)", () => {
  let fixture: SeededTenantCorpus;

  beforeEach(async () => {
    fixture = await seedTenantCorpus();
  });

  afterEach(() => {
    fixture.sessionStore.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  // Not one of the numbered contract cases — proves the Wave A acceptance
  // criterion "fixture seeds clean" plus the adversarial shapes it must carry.
  it("fixture: seeds two tenants with disjoint content and the named adversarial overlaps", () => {
    const { A, B } = fixture.ids;

    expect(A.sessionIds).not.toEqual(B.sessionIds);
    expect(A.factIds).not.toEqual(B.factIds);

    // Adversarial overlap 1: same entity surface form, tenant-local rows.
    expect(A.entityCanonical).toBe(B.entityCanonical);
    const entityRows = fixture.db
      .prepare("SELECT tenant_id FROM entities WHERE canonical = ? ORDER BY tenant_id")
      .all(A.entityCanonical) as Array<{ tenant_id: string }>;
    expect(entityRows.map((r) => r.tenant_id)).toEqual(["team_a", "team_b"]);

    // Adversarial overlap 2: same signal repo basename, different full path.
    expect(A.repo.split("/").pop()).toBe(B.repo.split("/").pop());
    expect(A.repo).not.toBe(B.repo);

    // Adversarial overlap 3: near-identical fact embeddings across tenants
    // (the vector-neighbor trap) — both fact pairs exist, one per tenant.
    const factCount = fixture.db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number };
    expect(factCount.n).toBe(4);
    const embeddingCount = fixture.db.prepare("SELECT COUNT(*) AS n FROM fact_embeddings").get() as { n: number };
    expect(embeddingCount.n).toBe(4);
  });

  // Case 1 (session + fact parts, store level). Store methods have no
  // "hybrid" mode of their own — hybrid merge is RecallService/
  // FactRecallService composition over these same store calls, which stay
  // tenant-blind by construction since they thread the caller's tenantId
  // straight through (recall-service.ts, fact-recall-service.ts). Exemplar
  // recall is CodeExemplarStore (unthreaded, Wave B3) and stays out of scope.
  it("case 1: recall as team A never returns a B session/fact — keyword and semantic store paths", async () => {
    const { A, B } = fixture.ids;

    // Keyword: query text ("onboarding") matches both tenants' session labels.
    const kwHits = await fixture.sessionStore.keywordSearch("team_a", "onboarding", 10);
    expect(kwHits.map((h) => h.sessionId)).toContain(A.sessionIds[0]);
    expect(kwHits.map((h) => h.sessionId)).not.toContain(B.sessionIds[0]);

    // getByIds: a mixed A+B id list resolves only the caller's own rows.
    const sessions = await fixture.sessionStore.getByIds("team_a", [...A.sessionIds, ...B.sessionIds]);
    expect(sessions.map((s) => s.id).sort()).toEqual([...A.sessionIds].sort());

    // Facts: listForRecall and getByIds are the two store-level fact read
    // paths FactRecallService composes into keyword/semantic/hybrid.
    const factsForRecall = await fixture.factStore.listForRecall("team_a", {});
    expect(factsForRecall.map((f) => f.id).sort()).toEqual([...A.factIds].sort());

    const facts = await fixture.factStore.getByIds("team_a", [...A.factIds, ...B.factIds]);
    expect(facts.map((f) => f.id).sort()).toEqual([...A.factIds].sort());
  });

  // Case 2 (fact vector-neighbor leak). The fixture seeds A's and B's first
  // fact with near-identical embeddings (epsilon apart) — a naive KNN scan
  // over the whole corpus returns B's row as A's nearest neighbor. The
  // semanticSearch → getByIds path (mirrored here exactly as
  // FactRecallService.runSemantic composes them) must still resolve only A's
  // fact, because semanticSearch re-filters candidate ids against the
  // tenant-scoped `facts` table before returning (program spec §4.3).
  it("case 2: vector-neighbor leak — a B fact embedded near an A query is not returned by A's semantic search", async () => {
    const { A, B } = fixture.ids;
    const queryVector = new Float32Array(768);
    for (let i = 0; i < 768; i++) queryVector[i] = Math.sin((i + 1) * 1); // matches A's fact-1 embedding exactly

    const neighbors = await fixture.factStore.semanticSearch("team_a", queryVector, 5);
    const neighborIds = neighbors.map((n) => n.factId);
    expect(neighborIds).toContain(A.factIds[0]);
    expect(neighborIds).not.toContain(B.factIds[0]);

    // Even resolving the raw candidate ids (as if the keyword window missed
    // them) through getByIds must not leak B's row to an A caller.
    const resolved = await fixture.factStore.getByIds("team_a", [A.factIds[0], B.factIds[0]]);
    expect(resolved.map((f) => f.id)).toEqual([A.factIds[0]]);
  });

  // Case 3 (store level). "Entity-filtered recall" composes on top of
  // getByIds/getEntities, both already tenant-filtered (case 1); this case
  // adds the entity-registry-specific assertions: the shared surface form
  // resolves to two tenant-local rows, a session's resolved entities never
  // include the other tenant's solo entity, and EntityStore.merge refuses
  // to resolve a source or target that lives only in the other tenant.
  it("case 3: entity- and kind-filtered recall as A never returns a B session; the same surface form registered as " +
      "an entity in both corpora resolves to two tenant-local entity rows, and entity-registry reads as A never " +
      "return an entity name that exists only in B", async () => {
    const { A, B } = fixture.ids;

    // Shared surface form ("shared-entity") resolves to two tenant-local rows.
    const entityRows = fixture.db
      .prepare("SELECT tenant_id FROM entities WHERE canonical = ? ORDER BY tenant_id")
      .all(A.entityCanonical) as Array<{ tenant_id: string }>;
    expect(entityRows.map((r) => r.tenant_id)).toEqual(["team_a", "team_b"]);

    // Entity-registry read (getEntities) as A never surfaces B's solo entity.
    const aEntities = await fixture.sessionStore.getEntities("team_a", A.sessionIds[1]);
    expect(aEntities).toContain(A.soloEntityCanonical);
    expect(aEntities).not.toContain(B.soloEntityCanonical);

    // Cross-tenant session id: entity-registry read returns nothing, not B's entities.
    const crossEntities = await fixture.sessionStore.getEntities("team_a", B.sessionIds[1]);
    expect(crossEntities).toEqual([]);

    // Entity-filtered session resolution: A's own sessions never carry B's solo entity.
    const aSessions = await fixture.sessionStore.getByIds("team_a", [...A.sessionIds]);
    for (const s of aSessions) expect(s.entities).not.toContain(B.soloEntityCanonical);

    // Merge refusal: A cannot resolve a source or target entity that lives only in B.
    await expect(
      fixture.entityStore.merge("team_a", B.soloEntityCanonical, A.entityCanonical),
    ).rejects.toThrow(/source entity not found/);
    await expect(
      fixture.entityStore.merge("team_a", A.soloEntityCanonical, B.soloEntityCanonical),
    ).rejects.toThrow(/target entity not found/);
  });

  // Case 4 (session + fact by-id parts, store level). The MCP/HTTP-layer
  // supersedence/continues enrichment fencing (program spec §4.6 hardening
  // 2) is Wave C scope and stays out of this store-level slice.
  it("case 4: by-id refusal — SessionStore.getById / FactStore.getById / FactStore.getHistory for a cross-tenant id return the not-found shape", async () => {
    const { A, B } = fixture.ids;

    expect(await fixture.sessionStore.getById("team_a", B.sessionIds[0])).toBeNull();
    expect(await fixture.sessionStore.getById("team_a", "nonexistent-session")).toBeNull();

    expect(await fixture.factStore.getById("team_a", B.factIds[0])).toBeNull();
    expect(await fixture.factStore.getById("team_a", "nonexistent-fact")).toBeNull();

    const bFact = await fixture.factStore.getById("team_b", B.factIds[0]);
    const bSubject = bFact!.subject;
    const chains = await fixture.factStore.getHistory("team_a", bSubject);
    expect(chains).toEqual([]);
  });

  // Case 5 (store level). recall_workstream = rollupWorkstream composed
  // directly over the tenant-threaded WorkstreamStore/SessionStore/
  // FactStore/CodeExemplarStore; list_merge_suggestions candidate scoping =
  // WorkstreamStore.candidatesByEntityOverlap; merge_workstreams/
  // rebind_session = WorkstreamStore.merge/SessionStore.setWorkstreamBinding.
  // The MCP-layer resolveWorkstream/handler wiring is Wave C scope.
  it("case 5: workstream surfaces — recall_workstream, list_merge_suggestions, merge_workstreams, rebind_session " +
      "never pair, return, or move rows across tenants", async () => {
    const { A, B } = fixture.ids;
    const rollupDeps = {
      workstreams: fixture.workstreamStore,
      sessions: fixture.sessionStore,
      facts: fixture.factStore,
      exemplars: fixture.exemplarStore,
    };

    // recall_workstream: A's own rollup contains no B content.
    const rollup = await rollupWorkstream(rollupDeps, "team_a", A.workstreamId);
    expect(rollup?.workstream.id).toBe(A.workstreamId);
    expect(rollup?.sessionIds).toEqual([A.sessionIds[0]]);
    expect(rollup?.facts.map((f) => f.id)).not.toContain(B.factIds[0]);
    expect(rollup?.exemplars.map((e) => e.id)).not.toContain(B.exemplarId);

    // B's workstream is invisible to a rollup requested as A.
    expect(await rollupWorkstream(rollupDeps, "team_a", B.workstreamId)).toBeNull();

    // list_merge_suggestions candidate scoping: overlap search as A never surfaces B's workstream.
    const candidates = await fixture.workstreamStore.candidatesByEntityOverlap("team_a", [A.entityCanonical], 10);
    expect(candidates.map((c) => c.workstreamId)).toContain(A.workstreamId);
    expect(candidates.map((c) => c.workstreamId)).not.toContain(B.workstreamId);

    // merge_workstreams refusal: A attempting to merge B's workstream is a true no-op — B's row is untouched.
    await fixture.workstreamStore.merge("team_a", B.workstreamId, A.workstreamId);
    const bWorkstream = await fixture.workstreamStore.getById("team_b", B.workstreamId);
    expect(bWorkstream?.status).toBe("active");

    // rebind_session refusal: A attempting to rebind B's session is a true no-op — B's own binding is untouched
    // and A's workstream never gains B's session.
    await fixture.sessionStore.setWorkstreamBinding("team_a", B.sessionIds[0], A.workstreamId, "classifier", 1.0);
    const bBound = await fixture.sessionStore.listSessionIdsByWorkstreams("team_b", [B.workstreamId]);
    expect(bBound).toContain(B.sessionIds[0]);
    const aBound = await fixture.sessionStore.listSessionIdsByWorkstreams("team_a", [A.workstreamId]);
    expect(aBound).not.toContain(B.sessionIds[0]);
  });

  // Case 6 (store/service level). work_summary = buildWorkDigest composed over
  // the tenant-threaded SessionStore/WorkstreamStore; failure-mode block =
  // buildFailureModeBlock/SignalStore.listForAggregation, with an adversarial
  // installScope collision inserted inline (the fixture's own signals use
  // installScope=teamId, which never collides) to prove tenant is the outer
  // mandatory filter even when install_scope (the within-tenant discriminator,
  // program spec §4.6 hardening 3) matches across tenants.
  it("case 6: digest / work_summary / failure-mode block for A contain no B content; signals with identical repo " +
      "basenames in A and B never cross", async () => {
    const { A, B } = fixture.ids;

    // work_summary: the digest window is computed from the fixture's actual
    // startedAt so the local-midnight day boundary lands correctly regardless
    // of the test runner's timezone.
    const localDate = new Date("2026-07-20T00:00:00Z");
    const dateStr = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
    const digest = await buildWorkDigest(
      { store: fixture.sessionStore, workstreams: fixture.workstreamStore },
      "team_a",
      dateStr,
    );
    expect(digest.coverage.sessions).toBe(2);
    expect(digest.coverage.sessions).not.toBe(4);

    // failure-mode / signal aggregation: identical repo basename, different full path — exact match only.
    const aSignals = await fixture.signalStore.listForAggregation("team_a", { installScope: "team_a", repo: A.repo });
    expect(aSignals.map((s) => s.id)).toEqual([A.signalId]);
    const crossRepo = await fixture.signalStore.listForAggregation("team_a", { installScope: "team_a", repo: B.repo });
    expect(crossRepo).toEqual([]);

    // Adversarial install_scope collision: two signals share both install_scope AND repo across tenants —
    // tenant must still be the outer filter (program spec §4.6 hardening 3).
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
    const bColliding = await fixture.signalStore.listForAggregation("team_b", { installScope: sharedInstallScope, repo: sharedRepo });
    expect(bColliding.map((s) => s.id)).toEqual(["collide-b"]);

    const block = await buildFailureModeBlock("team_a", fixture.signalStore, { installScope: "team_a", repo: A.repo });
    expect(block).toBe("");
  });

  // Case 7 (M4, spec §3/§8). A webhook source registered under team_b's
  // tenantId; POST /api/ingest resolves the source by its own token
  // (independent of the general gate's team_tokens auth) and stamps the
  // ingested session with the source's own tenant_id. Disabled/invalid
  // source tokens are rejected before any write.
  it("case 7: ingest attribution — a session pushed via A's source token is recallable by A, invisible to B; a " +
      "revoked token's push is rejected", async () => {
    const sources = new SourceRegistry(fixture.db);
    const bSource = await sources.insert("team_b", { kind: "webhook", name: "b-webhook", runtimeLabel: "webhook/1" });
    const token = bSource.token!;

    const app = createApp({
      recall: { search: async () => ({ query: "", mode: "keyword" as const, limit: 0, total: 0, results: [] }) } as never,
      store: fixture.sessionStore,
      sources,
      ingest: {
        classifier: new StubClassifier(),
        embedder: new StubEmbedder(),
        store: fixture.sessionStore,
      },
    });

    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: "wh_case7_session", text: "case 7 ingest body", startedAt: "2026-07-22T00:00:00Z" }),
    });
    expect(res.status).toBe(202);

    const deadline = Date.now() + 3000;
    let session = null;
    while (Date.now() < deadline) {
      session = await fixture.sessionStore.getById("team_b", "wh_case7_session");
      if (session) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(session).not.toBeNull();
    expect(await fixture.sessionStore.getById("team_a", "wh_case7_session")).toBeNull();

    // A regenerated (revoked) token no longer authenticates the source.
    const oldToken = token;
    await sources.regenerateToken("team_b", bSource.id);
    const resRevoked = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${oldToken}` },
      body: JSON.stringify({ id: "wh_case7_revoked", text: "should not ingest", startedAt: "2026-07-22T00:01:00Z" }),
    });
    expect(resRevoked.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(await fixture.sessionStore.getById("team_b", "wh_case7_revoked")).toBeNull();

    // A disabled source's (still-valid) token is rejected with no write.
    await sources.update("team_b", bSource.id, { enabled: false });
    const disabledToken = await sources.regenerateToken("team_b", bSource.id);
    const resDisabled = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${disabledToken}` },
      body: JSON.stringify({ id: "wh_case7_disabled", text: "should not ingest", startedAt: "2026-07-22T00:02:00Z" }),
    });
    expect(resDisabled.status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(await fixture.sessionStore.getById("team_b", "wh_case7_disabled")).toBeNull();
  });

  // Case 8 (M3, spec §3). NLM_HOSTED=1 exercises the strict branch (no
  // ungated fallback) so a bad/absent token really does 401 rather than
  // silently resolving to the local default team. Seeds real team_a/team_b
  // tokens via TeamTokenStore against the fixture's own db, issues the same
  // GET /api/recall request with each token, and asserts disjoint result
  // sets; a garbage or revoked token gets 401 with the recall service never
  // invoked (asserted via a spy).
  it("case 8: token-swap — the same request body issued with A's then B's token returns disjoint result sets; a " +
      "bad/absent token gets 401 with no corpus read", async () => {
    const prevHosted = process.env["NLM_HOSTED"];
    process.env["NLM_HOSTED"] = "1";
    try {
      const teamTokens = new TeamTokenStore(fixture.db);
      const tokenA = "token-team-a-case8";
      const tokenB = "token-team-b-case8";
      const tokenRevoked = "token-revoked-case8";
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
        headers: { authorization: "Bearer garbage-token-xyz" },
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

  // Case 9 (surface level, Wave C1/C2). Every MCP handler and HTTP route now
  // takes tenantId as an explicit parameter separate from the caller-
  // supplied input/query object (spec §3: "tenant is resolved from the
  // authenticated credential and from nothing else"). This proves the
  // negative directly: a crafted `tenant`/`scope: "*"` field riding along on
  // the untyped input object has zero effect — results are governed only by
  // the positional tenantId the composition root supplied.
  it("case 9: no-parameter override — a crafted tenant/scope field on the MCP input or HTTP query string never " +
      "widens results beyond the caller's tenantId", async () => {
    const { A, B } = fixture.ids;
    const deps = { recall: {} as never, store: fixture.sessionStore };

    // MCP surface: get_session's `input` is untyped at the wire (JSON args).
    // A crafted extra `tenant`/`scope` field must not override the real
    // (positional) tenantId argument, in either direction.
    const craftedOwnSession = { id: A.sessionIds[0], tenant: "team_b", scope: "*", tenantId: "team_b" };
    const ownResult = await getSessionHandler(deps, "team_a", craftedOwnSession as unknown as { id: string });
    expect(ownResult.isError).toBeUndefined();
    const ownBody = JSON.parse(ownResult.content[0]!.text) as { id: string };
    expect(ownBody.id).toBe(A.sessionIds[0]);

    const craftedCrossTenant = { id: B.sessionIds[0], tenant: "team_a", scope: "*" };
    const crossResult = await getSessionHandler(deps, "team_a", craftedCrossTenant as unknown as { id: string });
    expect(crossResult.isError).toBe(true);
    expect(crossResult.content[0]?.text).toContain("not found");

    // HTTP surface: a `?tenant=team_b`/`?scope=*` query string on a FILTER
    // route has no code path that reads it — the handler never looks at
    // anything but the fixed request path param, proving the same negative
    // over HTTP.
    const recallStub = { search: async () => ({ query: "", mode: "keyword" as const, limit: 0, total: 0, results: [] }) };
    const app = createApp({ recall: recallStub as never, store: fixture.sessionStore });
    const res = await app.request(`/api/session/${B.sessionIds[0]}?tenant=team_a&scope=*`);
    expect(res.status).toBe(404);
  });

  // Case 11 (Wave C4). The by-construction store guard lives in its own
  // dedicated file (tests/integration/tenant-guard.test.ts) so it can scan
  // the full corpus-SQL surface independently of this fixture-driven
  // contract file. Asserting its existence here keeps case 11 visibly
  // resolved in the one place spec §6 enumerates every case, without
  // duplicating the scan logic.
  it("case 11: store guard — every corpus SQL string in every store routes through tenantClause, asserted by " +
      "construction (full scan: tests/integration/tenant-guard.test.ts)", () => {
    expect(existsSync(join(ROOT, "tests/integration/tenant-guard.test.ts"))).toBe(true);
  });

  // Supplementary to case 11 above: a fast, local copy of tenant-guard.test.ts's
  // check 1 (literal scan) kept in this file too, so the contract file alone
  // still catches an inlined bind-param/string-literal `tenant_id =` even if
  // someone ever ran this file in isolation. Column-to-column equality
  // (`tenant_id = <alias>.tenant_id` / `<alias>.tenant_id = <alias2>.tenant_id`)
  // is explicitly PERMITTED — the defense-in-depth join form Wave C4 restored
  // in findContinuesPredecessor and listBackfillCandidates (sqlite + pg).
  it("case 11 (supplementary literal-scan floor): no store/actions/dataset/http SQL string inlines a bind-param or literal tenant_id =", () => {
    const scanFiles: string[] = [];
    for (const f of readdirSync(join(ROOT, "src/core/storage"))) {
      if (f.endsWith(".ts")) scanFiles.push(join(ROOT, "src/core/storage", f));
    }
    scanFiles.push(join(ROOT, "src/core/actions/actions-log.ts"));
    scanFiles.push(join(ROOT, "src/core/dataset/build-dataset.ts"));
    scanFiles.push(join(ROOT, "src/http/app.ts"));

    const columnEquality = /^\w+\.tenant_id$/;
    const offenders: string[] = [];
    for (const file of scanFiles) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        for (const m of line.matchAll(/tenant_id\s*=\s*(\S+)/g)) {
          const rhs = (m[1] ?? "").replace(/[,);'"`]+$/, "");
          if (!columnEquality.test(rhs)) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Case 12 (M6 Tasks 1-4). The file-state modules (memo, hook-log,
  // query/citation/miss logs, supersedence-log) predate per-tenant SQLite
  // rows and used to write one shared file under ~/.nlm/ — the leak this
  // case exists to close. tenantA/tenantB are unique to this case
  // (team_a_case12/team_b_case12, not the fixture's SQL-backed team_a/
  // team_b) so its real ~/.nlm/tenants/<t>/ writes can't collide with any
  // other spec file; the one exception is the amendment's HTTP-supersede
  // leg, which deliberately reuses the fixture's real team_a session ids so
  // markSuperseded has rows to operate on without fabricating a second
  // corpus.
  it("case 12: state isolation (M6) — per-conversation memo state and query/citation/miss logs never mix tenants; " +
      "a conversation-id collision across teams does not share dedup state", async () => {
    const tenantA = "team_a_case12";
    const tenantB = "team_b_case12";
    const derivedA = join(homedir(), ".nlm", "tenants", tenantA);
    const derivedB = join(homedir(), ".nlm", "tenants", tenantB);
    const supersedeDirA = join(homedir(), ".nlm", "tenants", "team_a");
    const supersedeDirB = join(homedir(), ".nlm", "tenants", "team_b");
    const legacyQueryLog = join(fixture.dir, "legacy-query-log.jsonl");
    const legacyCitationLog = join(fixture.dir, "legacy-citation-log.jsonl");
    const legacyMissLog = join(fixture.dir, "legacy-miss-log.jsonl");
    const legacyHookLog = join(fixture.dir, "legacy-hook-log.jsonl");
    const prevQueryLog = process.env["NLM_QUERY_LOG"];
    const prevCitationLog = process.env["NLM_CITATION_LOG"];
    const prevMissLog = process.env["NLM_MISS_LOG"];
    const prevHookLog = process.env["NLM_HOOK_LOG"];
    const prevHosted = process.env["NLM_HOSTED"];
    const sharedConvId = "case12-shared-conv";

    try {
      // Route the DEFAULT_TEAM_ID ("legacy") lane at temp files inside the
      // fixture dir so this test never touches the developer's real
      // ~/.nlm/query_log.jsonl etc. — mirrors the Task 1 unit-test convention.
      process.env["NLM_QUERY_LOG"] = legacyQueryLog;
      process.env["NLM_CITATION_LOG"] = legacyCitationLog;
      process.env["NLM_MISS_LOG"] = legacyMissLog;
      process.env["NLM_HOOK_LOG"] = legacyHookLog;

      // --- Memo: recordSurfaced(A, convId, [sessionA]) then loadSurfaced(B,
      // convId) is empty — a conversation-id collision across teams shares
      // no dedup state.
      recordSurfaced(tenantA, sharedConvId, ["sess_a_only"]);
      expect([...loadSurfaced(tenantB, sharedConvId)]).toEqual([]);
      expect([...loadSurfaced(tenantA, sharedConvId)]).toEqual(["sess_a_only"]);

      // --- Query log: A and B each write one distinct entry; each tenant's
      // reader/stats output contains only its own entry; the legacy
      // default-team file receives neither tenant's row.
      const queryEntry = (over: Partial<LogEntry>): LogEntry => ({
        source: "test",
        runtime: null,
        query: null,
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        nResults: 1,
        returnedIds: [],
        ...over,
      });
      await logQuery(DEFAULT_TEAM_ID, queryEntry({ query: "case12-query-default" }));
      await logQuery(tenantA, queryEntry({ query: "case12-query-a", returnedIds: ["sess_a"] }));
      await logQuery(tenantB, queryEntry({ query: "case12-query-b", returnedIds: ["sess_b"] }));

      expect((await readQueryLog(tenantA, 7)).map((e) => e.entry.query)).toEqual(["case12-query-a"]);
      expect((await readQueryLog(tenantB, 7)).map((e) => e.entry.query)).toEqual(["case12-query-b"]);

      const aStats = await recallStats(tenantA, 7);
      expect(aStats.total).toBe(1);
      expect(aStats.top_queries.map((q) => q.query)).toEqual(["case12-query-a"]);
      const bStats = await recallStats(tenantB, 7);
      expect(bStats.total).toBe(1);
      expect(bStats.top_queries.map((q) => q.query)).toEqual(["case12-query-b"]);

      const legacyQueryRaw = readFileSync(legacyQueryLog, "utf8");
      expect(legacyQueryRaw).not.toContain("case12-query-a");
      expect(legacyQueryRaw).not.toContain("case12-query-b");

      // --- Citation log. Conversation ids must be "attributable" (not
      // test-prefixed) or appendCitation drops them at the source.
      const citation = (over: Partial<CitationEntry>): CitationEntry => ({
        conversationId: "case12-cite-conv",
        citedId: "case12-cited",
        ...over,
      });
      await appendCitation(
        DEFAULT_TEAM_ID,
        citation({ conversationId: "case12-cite-conv-default", citedId: "case12-cited-default" }),
      );
      await appendCitation(tenantA, citation({ conversationId: "case12-cite-conv-a", citedId: "case12-cited-a" }));
      await appendCitation(tenantB, citation({ conversationId: "case12-cite-conv-b", citedId: "case12-cited-b" }));

      expect((await readCitationLog(tenantA, 7)).map((c) => c.citedId)).toEqual(["case12-cited-a"]);
      expect((await readCitationLog(tenantB, 7)).map((c) => c.citedId)).toEqual(["case12-cited-b"]);

      const aCiteStats = await citationStats(tenantA, 7);
      expect(aCiteStats.top_ids.map((t) => t.id)).toEqual(["case12-cited-a"]);
      const bCiteStats = await citationStats(tenantB, 7);
      expect(bCiteStats.top_ids.map((t) => t.id)).toEqual(["case12-cited-b"]);

      const legacyCitationRaw = readFileSync(legacyCitationLog, "utf8");
      expect(legacyCitationRaw).not.toContain("case12-cited-a");
      expect(legacyCitationRaw).not.toContain("case12-cited-b");

      // --- Miss log.
      const miss = (over: Partial<MissEntry>): MissEntry => ({
        conversationId: "case12-miss-conv",
        missedId: "case12-missed",
        kind: "get_session",
        surfacedCount: 0,
        ...over,
      });
      await appendMiss(
        DEFAULT_TEAM_ID,
        miss({ conversationId: "case12-miss-conv-default", missedId: "case12-missed-default" }),
      );
      await appendMiss(tenantA, miss({ conversationId: "case12-miss-conv-a", missedId: "case12-missed-a" }));
      await appendMiss(tenantB, miss({ conversationId: "case12-miss-conv-b", missedId: "case12-missed-b" }));

      const aMissStats = await missStats(tenantA, 7);
      expect(aMissStats.topIds.map((t) => t.id)).toEqual(["case12-missed-a"]);
      const bMissStats = await missStats(tenantB, 7);
      expect(bMissStats.topIds.map((t) => t.id)).toEqual(["case12-missed-b"]);

      const legacyMissRaw = readFileSync(legacyMissLog, "utf8");
      expect(legacyMissRaw).not.toContain("case12-missed-a");
      expect(legacyMissRaw).not.toContain("case12-missed-b");

      // --- Hook log. No dedicated reader export (unlike the logs above) —
      // assert the raw derived-path file content directly, mirroring
      // hook-log.test.ts's own path-contract style.
      const hookEntry = (over: Partial<HookLogEntry>): HookLogEntry => ({
        ts: new Date().toISOString(),
        conversationId: "case12-hook-conv",
        promptPreview: "p",
        gate: "evaluate",
        hits: [],
        wouldInject: [],
        estTokens: 0,
        mode: "shadow",
        ...over,
      });
      appendHookLog(DEFAULT_TEAM_ID, hookEntry({ conversationId: "case12-hook-conv-default" }));
      appendHookLog(tenantA, hookEntry({ conversationId: "case12-hook-conv-a" }));
      appendHookLog(tenantB, hookEntry({ conversationId: "case12-hook-conv-b" }));

      const aHookRaw = readFileSync(join(derivedA, "hook-log.jsonl"), "utf8");
      expect(aHookRaw).toContain("case12-hook-conv-a");
      expect(aHookRaw).not.toContain("case12-hook-conv-b");
      const bHookRaw = readFileSync(join(derivedB, "hook-log.jsonl"), "utf8");
      expect(bHookRaw).toContain("case12-hook-conv-b");
      expect(bHookRaw).not.toContain("case12-hook-conv-a");
      const legacyHookRaw = readFileSync(legacyHookLog, "utf8");
      expect(legacyHookRaw).not.toContain("case12-hook-conv-a");
      expect(legacyHookRaw).not.toContain("case12-hook-conv-b");

      // --- HTTP level: GET /api/recall/stats as token-A reflects A's write
      // only (reuses the case-8 token fixtures — NLM_HOSTED=1, TeamTokenStore
      // + hashTeamToken, no queryLogPath override so the route reads the
      // same real tenant-derived file the direct logQuery calls above wrote).
      process.env["NLM_HOSTED"] = "1";
      // team_tokens.team_id has a live FK to teams(id) — tenantA/tenantB
      // aren't part of the fixture's seeded corpus (only team_a/team_b are),
      // so they need their own teams rows before a token can reference them.
      fixture.db
        .prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)")
        .run(tenantA, tenantA);
      fixture.db
        .prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)")
        .run(tenantB, tenantB);
      const teamTokens = new TeamTokenStore(fixture.db);
      const tokenA = "token-team-a-case12";
      const tokenB = "token-team-b-case12";
      await teamTokens.insert(hashTeamToken(tokenA), tenantA);
      await teamTokens.insert(hashTeamToken(tokenB), tenantB);
      const recallStub = { search: async () => ({ query: "", mode: "keyword" as const, limit: 0, total: 0, results: [] }) };
      const app = createApp({ recall: recallStub as never, store: fixture.sessionStore, teamTokens });

      const resA = await app.request("/api/recall/stats?days=7", { headers: { authorization: `Bearer ${tokenA}` } });
      expect(resA.status).toBe(200);
      const statsA = (await resA.json()) as { total: number; top_queries: Array<{ query: string }> };
      expect(statsA.total).toBe(1);
      expect(statsA.top_queries.map((q) => q.query)).toEqual(["case12-query-a"]);

      const resB = await app.request("/api/recall/stats?days=7", { headers: { authorization: `Bearer ${tokenB}` } });
      expect(resB.status).toBe(200);
      const statsB = (await resB.json()) as { total: number; top_queries: Array<{ query: string }> };
      expect(statsB.total).toBe(1);
      expect(statsB.top_queries.map((q) => q.query)).toEqual(["case12-query-b"]);

      // --- Amendment: appendSupersedence as A then readSupersedenceLog as B
      // returns nothing for B.
      await appendSupersedence(tenantA, {
        predecessorId: "case12-sup-pred",
        successorId: "case12-sup-succ",
        reason: "case12",
      });
      expect(await readSupersedenceLog(tenantB)).toEqual([]);
      const aSupersedence = await readSupersedenceLog(tenantA);
      expect(aSupersedence.map((e) => e.predecessorId)).toEqual(["case12-sup-pred"]);

      // --- Amendment (HTTP leg): the real POST /api/session/:id/supersede
      // route invoked as token-A, asserted invisible to B at the store level
      // — the "where cheap to assert at the store level" scope the amendment
      // calls for, in place of building out a full get_session enrichment
      // round-trip. Reuses the fixture's own real team_a session ids so
      // markSuperseded has rows to operate on.
      const { A } = fixture.ids;
      const tokenSupA = "token-team-a-case12-supersede";
      await teamTokens.insert(hashTeamToken(tokenSupA), "team_a");
      const supRes = await app.request(`/api/session/${A.sessionIds[0]}/supersede`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenSupA}`, "content-type": "application/json" },
        body: JSON.stringify({ successor_id: A.sessionIds[1] }),
      });
      expect(supRes.status).toBe(200);
      // The route's appendSupersedence call is fire-and-forget (not awaited,
      // matching case 7's ingest write) — poll briefly rather than race it.
      const deadline = Date.now() + 3000;
      let teamASupersedence: Awaited<ReturnType<typeof readSupersedenceLog>> = [];
      while (Date.now() < deadline) {
        teamASupersedence = await readSupersedenceLog("team_a");
        if (teamASupersedence.some((e) => e.predecessorId === A.sessionIds[0])) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(teamASupersedence.some((e) => e.predecessorId === A.sessionIds[0])).toBe(true);
      expect(await readSupersedenceLog("team_b")).toEqual([]);
    } finally {
      if (prevQueryLog === undefined) delete process.env["NLM_QUERY_LOG"];
      else process.env["NLM_QUERY_LOG"] = prevQueryLog;
      if (prevCitationLog === undefined) delete process.env["NLM_CITATION_LOG"];
      else process.env["NLM_CITATION_LOG"] = prevCitationLog;
      if (prevMissLog === undefined) delete process.env["NLM_MISS_LOG"];
      else process.env["NLM_MISS_LOG"] = prevMissLog;
      if (prevHookLog === undefined) delete process.env["NLM_HOOK_LOG"];
      else process.env["NLM_HOOK_LOG"] = prevHookLog;
      if (prevHosted === undefined) delete process.env["NLM_HOSTED"];
      else process.env["NLM_HOSTED"] = prevHosted;
      rmSync(derivedA, { recursive: true, force: true });
      rmSync(derivedB, { recursive: true, force: true });
      rmSync(supersedeDirA, { recursive: true, force: true });
      rmSync(supersedeDirB, { recursive: true, force: true });
    }
  });
});
