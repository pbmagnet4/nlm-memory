// tests/integration/tenant-leak-contract.test.ts
/**
 * The standing cross-tenant leak-test contract (program spec §6), sqlite
 * lane. This file is test-first at the contract level (Global Constraints,
 * Wave A): it enumerates every adversarial case from spec §6 (1-9, 11-12;
 * case 10 is concurrency and lands with M7's harness) as a named `it()`
 * before store-layer tenant threading exists (that's Wave B/C). A case that
 * cannot pass yet is `it.todo` with its exact case text — visibly red-by-
 * design, never deleted, never silently skipped. Wave B/C flip cases to real
 * assertions as threading lands; the pg twin
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

  beforeEach(() => {
    fixture = seedTenantCorpus();
  });

  afterEach(() => {
    fixture.db.close();
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

  it.todo(
    "case 1: recall as team A never returns a B session/fact/exemplar — keyword, semantic, AND hybrid modes",
  );

  it.todo(
    "case 2: vector-neighbor leak — a B fact embedded as the nearest neighbor of an A query is not returned by " +
      "semantic or hybrid recall as A, even outside the keyword candidate window (the semanticSearch → getByIds path)",
  );

  it.todo(
    "case 3: entity- and kind-filtered recall as A never returns a B session; the same surface form registered as " +
      "an entity in both corpora resolves to two tenant-local entity rows, and entity-registry reads as A never " +
      "return an entity name that exists only in B",
  );

  it.todo(
    "case 4: by-id refusal — get_session / /api/session/:id / get_fact_history for a B id as A returns the " +
      "not-found shape identical to a nonexistent id; supersedence/continues enrichment omits cross-tenant links",
  );

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
