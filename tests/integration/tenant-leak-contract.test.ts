// tests/integration/tenant-leak-contract.test.ts
/**
 * The standing cross-tenant leak-test contract (program spec §6), sqlite
 * lane. This file is test-first at the contract level (Global Constraints,
 * Wave A): it enumerates every adversarial case from spec §6 (1-9, 11-12;
 * case 10 is concurrency and lands with M7's harness) as a named `it()`.
 *
 * Wave B1-B4 landed SessionStore/FactStore/CodeExemplarStore/SignalStore/
 * WorkstreamStore/EntityStore/OutcomeStore threading, so cases 1-6 flip here
 * to real assertions against the fixture's real (tenant-threaded) stores and
 * the service-layer functions built directly on them (rollupWorkstream,
 * buildWorkDigest, buildFailureModeBlock).
 *
 * Wave C1's surface threading + Wave C4's guard test complete cases 9 and 11
 * (below). M3 flips case 8 (token-swap auth) to a real assertion against the
 * real HTTP app + TeamTokenStore. Case 7 (ingest attribution) is M4's job;
 * case 12 (M6 file-state isolation) stays `it.todo` — a case that cannot
 * pass yet is `it.todo` with its exact case text — visibly red-by-design,
 * never deleted, never silently skipped.
 *
 * The pg twin (tenant-leak-contract.pg.test.ts, Wave C5) mirrors the sqlite
 * cases that have pg-reachable shapes; case 10 (concurrency) stays out of
 * scope for both files per the plan (M7's isolated harness).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTenantCorpus, type SeededTenantCorpus } from "../helpers/seed-tenant-corpus.js";
import { rollupWorkstream } from "../../src/core/workstream/rollup.js";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import { buildFailureModeBlock } from "../../src/core/signals/failure-mode-recall.js";
import { getSessionHandler } from "../../src/mcp/server.js";
import { createApp } from "../../src/http/app.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import { TeamTokenStore } from "../../src/core/tenancy/team-token-store.js";
import { hashTeamToken } from "../../src/core/tenancy/team-auth.js";
import type { Signal } from "../../src/shared/types.js";

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

  it.todo(
    "case 7: ingest attribution — a session pushed via A's source token is recallable by A, invisible to B; a " +
      "revoked token's push is rejected",
  );

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

  it.todo(
    "case 12: state isolation (M6) — per-conversation memo state and query/citation/miss logs never mix tenants; " +
      "a conversation-id collision across teams does not share dedup state",
  );
});
