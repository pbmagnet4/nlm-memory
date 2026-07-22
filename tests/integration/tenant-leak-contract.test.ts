// tests/integration/tenant-leak-contract.test.ts
/**
 * The standing cross-tenant leak-test contract (program spec §6), sqlite
 * lane. This file is test-first at the contract level (Global Constraints,
 * Wave A): it enumerates every adversarial case from spec §6 (1-9, 11-12;
 * case 10 is concurrency and lands with M7's harness) as a named `it()`.
 * Wave B lands SessionStore + FactStore threading, so cases 1, 2, and the
 * session/fact by-id slice of case 4 flip here to real assertions against
 * the fixture's real (now tenant-threaded) SqliteSessionStore/SqliteFactStore.
 * Cases 3, 5, 6, 7, 8, 9, 12 stay `it.todo` — they exercise
 * EntityStore/WorkstreamStore/SignalStore/source-token auth/M6 state, none
 * of which are threaded yet (Wave B3-B6, later work). A case that cannot
 * pass yet is `it.todo` with its exact case text — visibly red-by-design,
 * never deleted, never silently skipped. The pg twin
 * (tenant-leak-contract.pg.test.ts) is written in Wave C.
 *
 * The pg twin and case 10 are out of scope here per the plan.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedTenantCorpus, type SeededTenantCorpus } from "../helpers/seed-tenant-corpus.js";

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

  it.todo(
    "case 3: entity- and kind-filtered recall as A never returns a B session; the same surface form registered as " +
      "an entity in both corpora resolves to two tenant-local entity rows, and entity-registry reads as A never " +
      "return an entity name that exists only in B",
  );

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

  it.todo(
    "case 5: workstream surfaces — recall_workstream, list_merge_suggestions, merge_workstreams, rebind_session " +
      "never pair, return, or move rows across tenants",
  );

  it.todo(
    "case 6: digest / work_summary / failure-mode block for A contain no B content; signals with identical repo " +
      "basenames in A and B never cross",
  );

  it.todo(
    "case 7: ingest attribution — a session pushed via A's source token is recallable by A, invisible to B; a " +
      "revoked token's push is rejected",
  );

  it.todo(
    "case 8: token-swap — the same request body issued with A's then B's token returns disjoint result sets; a " +
      "bad/absent token gets 401 with no corpus read",
  );

  it.todo(
    "case 9: no-parameter override — no API/MCP input (tenant, scope: '*', or any other arg) widens results " +
      "beyond the token's team; tenant identity is auth-only",
  );

  it.todo(
    "case 11: store guard — every corpus SQL string in every store routes through tenantClause, asserted by " +
      "construction or by scanning prepared statements, so a future read path cannot forget the filter",
  );

  // Pre-threading floor for case 11, checkable today at the raw-source level
  // (no store behavior required): the literal `tenant_id =` must not appear
  // inline anywhere in the files Wave C's full guard test
  // (tests/integration/tenant-guard.test.ts) will scan. It is vacuously true
  // before Wave B threading starts and stays true only if every future WHERE
  // fragment routes through tenantClause instead of inlining the column.
  it("case 11 (pre-threading floor): no store/actions/dataset/http SQL string inlines the literal tenant_id =", () => {
    const scanFiles: string[] = [];
    for (const f of readdirSync(join(ROOT, "src/core/storage"))) {
      if (f.endsWith(".ts")) scanFiles.push(join(ROOT, "src/core/storage", f));
    }
    scanFiles.push(join(ROOT, "src/core/actions/actions-log.ts"));
    scanFiles.push(join(ROOT, "src/core/dataset/build-dataset.ts"));
    scanFiles.push(join(ROOT, "src/http/app.ts"));

    const offenders = scanFiles.filter((file) => /tenant_id\s*=/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it.todo(
    "case 12: state isolation (M6) — per-conversation memo state and query/citation/miss logs never mix tenants; " +
      "a conversation-id collision across teams does not share dedup state",
  );
});
