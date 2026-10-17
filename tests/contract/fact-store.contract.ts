/**
 * Backend-agnostic contract test for the FactStore port.
 *
 * Each adapter integration test imports runFactStoreContract and supplies a
 * harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend. That is the only proof
 * that a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets
 * each integration test file own its own describe naming.
 *
 * Note on `seedSession`: the SessionStore port has no public `insert(session)`
 * because production sessions arrive through the heavier `insertSession`
 * ingest path. Tests need a thin seed that bypasses extraction. Each backend
 * supplies that seed helper through the harness so this contract stays
 * adapter-agnostic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/shared/types.js";
import type { Storage } from "../../src/ports/storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

export interface FactStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  seedTenant(storage: Storage, tenantId: string): Promise<void>;
  /** Test-only session seed; bypasses ingest extraction. */
  seedSession(storage: Storage, session: Session): Promise<void>;
}

export function runFactStoreContract(h: FactStoreContractHarness): void {
  describe(`FactStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await h.seedSession(
        storage,
        makeSession({ id: "sess_parent", label: "Parent session" }),
      );
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    it("applies source membership before lexical LIMIT and treats empty scope as no eligible facts", async () => {
      await h.seedSession(storage, makeSession({ id: "scope_source", label: "Eligible" }));
      await storage.workstreams.create("team_local", { id: "ws_fact_scope", label: "Fact scope", scope: null });
      await storage.sessions.setWorkstreamBinding("team_local", "scope_source", "ws_fact_scope", "operator", 1);
      await storage.facts.insertMany("team_local", [
        makeFact({ id: "eligible", sourceSessionId: "scope_source", value: "migration sqlite", sourceQuote: "eligible quote", createdAt: "2020-01-01T00:00:00Z" }),
        ...Array.from({ length: 510 }, (_, i) => makeFact({ id: `unbound_${i}`, sourceSessionId: "sess_parent", value: "migration migration migration secret", createdAt: "2026-01-01T00:00:00Z" })),
      ]);
      const facts = await storage.facts.listForRecall("team_local", { query: "migration", limit: 1, workstreamIds: ["ws_fact_scope"] });
      expect(facts.map((f) => [f.id, f.value, f.sourceQuote])).toEqual([["eligible", "migration sqlite", "eligible quote"]]);
      expect(await storage.facts.listForRecall("team_local", { workstreamIds: [] })).toEqual([]);
      expect(await storage.facts.listForRecall("team_local", { workstreamIds: ["foreign"] })).toEqual([]);
      expect((await storage.facts.listForRecall("team_local", {})).some((f) => f.id.startsWith("unbound_"))).toBe(true);
      await storage.workstreams.create("team_local", { id: "ws_other_scope", label: "Other scope", scope: null });
      await storage.sessions.setWorkstreamBinding("team_local", "scope_source", "ws_other_scope", "operator", 1);
      expect(await storage.facts.listForRecall("team_local", { workstreamIds: ["ws_fact_scope"] })).toEqual([]);
    });

    describe("complete current-value summaries", () => {
      it("counts an older alternative beyond 600 duplicates before limiting examples", async () => {
        await h.seedSession(storage, makeSession({ id: "second_source" }));
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "older_b", sourceSessionId: "second_source", value: "B", createdAt: "2020-01-01T00:00:00Z" }),
          ...Array.from({ length: 601 }, (_, i) => makeFact({ id: `copy_${i}`, sourceSessionId: "sess_parent", value: "A" })),
          makeFact({ id: "third", sourceSessionId: "sess_parent", value: "C" }),
        ]);
        expect(await storage.facts.summarizeCurrentValues("team_local", { subject: "nlm-memory-ts", predicate: "framework" }))
          .toEqual({ distinctValueCount: 3, sourceSessionCount: 2, examples: [
            { value: "A", sourceSessionId: "sess_parent" }, { value: "B", sourceSessionId: "second_source" },
          ] });
      });

      it("excludes a fact whose source belongs to a different tenant in both probe and fact lane", async () => {
        await h.seedTenant(storage, "team_foreign");
        await storage.facts.insert("team_foreign", makeFact({ id: "cross_source", sourceSessionId: "sess_parent" }));
        expect(await storage.facts.summarizeCurrentValues("team_foreign", { subject: "nlm-memory-ts", predicate: "framework", minConfidence: 0.6 }))
          .toEqual({ distinctValueCount: 0, sourceSessionCount: 0, examples: [] });
        expect(await storage.facts.listForRecall("team_foreign", { subject: "nlm-memory-ts", predicate: "framework", minConfidence: 0.6 })).toEqual([]);
        const vector = new Float32Array(768); vector[0] = 1;
        await storage.facts.upsertEmbedding("team_foreign", "cross_source", vector);
        expect(await storage.facts.semanticSearch("team_foreign", vector, 3, { subject: "nlm-memory-ts", predicate: "framework", minConfidence: 0.6 })).toEqual([]);
      });

      it("deduplicates repeated values and counts distinct eligible sources", async () => {
        await h.seedSession(storage, makeSession({ id: "second_source" }));
        await storage.facts.insertMany("team_local", Array.from({ length: 601 }, (_, i) => makeFact({
          id: `same_${i}`, sourceSessionId: i % 2 ? "second_source" : "sess_parent", value: "A",
        })));
        const summary = await storage.facts.summarizeCurrentValues("team_local", { subject: "nlm-memory-ts", predicate: "framework" });
        expect(summary.distinctValueCount).toBe(1);
        expect(summary.sourceSessionCount).toBe(2);
        expect(summary.examples).toEqual([{ value: "A", sourceSessionId: "second_source" }]);
      });

      it("matches scope, lifecycle, confidence, kind, and exact tuple eligibility", async () => {
        await h.seedSession(storage, makeSession({ id: "outside_source" }));
        await storage.workstreams.create("team_local", { id: "ws_values", label: "Values", scope: null });
        await storage.sessions.setWorkstreamBinding("team_local", "sess_parent", "ws_values", "operator", 1);
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "current_a", sourceSessionId: "sess_parent", value: "A" }),
          makeFact({ id: "low", sourceSessionId: "sess_parent", value: "low", confidence: 0.59 }),
          makeFact({ id: "retired", sourceSessionId: "sess_parent", value: "retired" }),
          makeFact({ id: "old", sourceSessionId: "sess_parent", value: "old", supersededBy: "current_a" }),
          makeFact({ id: "outside", sourceSessionId: "outside_source", value: "outside" }),
          makeFact({ id: "other_kind", sourceSessionId: "sess_parent", value: "note", kind: "attribute" }),
          makeFact({ id: "other_tuple", sourceSessionId: "sess_parent", subject: "nlm-memory-ts framework", predicate: "", value: "other" }),
        ]);
        await storage.facts.retire("team_local", "retired");
        const query = { subject: "nlm-memory-ts", predicate: "framework", kind: "decision" as const, minConfidence: 0.6, workstreamIds: ["ws_values"] };
        expect(await storage.facts.summarizeCurrentValues("team_local", query)).toEqual({ distinctValueCount: 1,
          sourceSessionCount: 1, examples: [{ value: "A", sourceSessionId: "sess_parent" }] });
        for (const [tenant, workstreamIds] of [["team_local", []], ["team_local", ["foreign"]], ["foreign", ["ws_values"]]] as const) {
          expect(await storage.facts.summarizeCurrentValues(tenant, { ...query, workstreamIds }))
            .toEqual({ distinctValueCount: 0, sourceSessionCount: 0, examples: [] });
        }
        expect((await storage.facts.summarizeCurrentValues("team_local", { ...query, minConfidence: 0 })).distinctValueCount).toBe(2);
        await storage.facts.insert("team_local", makeFact({ id: "facet", sourceSessionId: "sess_parent", value: "legitimate facet" }));
        expect((await storage.facts.summarizeCurrentValues("team_local", query)).distinctValueCount).toBe(2);
      });
    });

    it("inserts and retrieves a fact round-trip", async () => {
      const fact = makeFact({ id: "fact_1", sourceSessionId: "sess_parent" });
      await storage.facts.insert("team_local", fact);
      const fetched = await storage.facts.getById("team_local", "fact_1");
      expect(fetched).toEqual({ ...fact, sourceAnchor: { status: "missing" } });
    });

    it("returns null for missing ids", async () => {
      expect(await storage.facts.getById("team_local", "nonexistent")).toBeNull();
    });

    it("insertMany commits atomically", async () => {
      await storage.facts.insertMany("team_local", [
        makeFact({ id: "fact_a", subject: "alpha", sourceSessionId: "sess_parent" }),
        makeFact({ id: "fact_b", subject: "beta", sourceSessionId: "sess_parent" }),
      ]);
      expect(await storage.facts.getById("team_local", "fact_a")).not.toBeNull();
      expect(await storage.facts.getById("team_local", "fact_b")).not.toBeNull();
    });

    it("insertMany rolls back the whole batch on duplicate id", async () => {
      await storage.facts.insert("team_local", 
        makeFact({ id: "fact_existing", sourceSessionId: "sess_parent" }),
      );
      await expect(
        storage.facts.insertMany("team_local", [
          makeFact({ id: "fact_new", subject: "alpha", sourceSessionId: "sess_parent" }),
          makeFact({ id: "fact_existing", subject: "beta", sourceSessionId: "sess_parent" }),
        ]),
      ).rejects.toThrow();
      expect(await storage.facts.getById("team_local", "fact_new")).toBeNull();
    });

    it("findCurrent returns only non-superseded facts", async () => {
      await storage.facts.insert("team_local", 
        makeFact({
          id: "fact_old",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Fastify",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-18T10:00:00Z",
        }),
      );
      await storage.facts.insert("team_local", 
        makeFact({
          id: "fact_new",
          subject: "nlm-memory-ts",
          predicate: "framework",
          value: "Hono",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:00:00Z",
        }),
      );
      await storage.facts.markSuperseded("team_local", "fact_old", "fact_new");

      const current = await storage.facts.findCurrent("team_local", "nlm-memory-ts", "framework");
      expect(current?.id).toBe("fact_new");
      expect(current?.value).toBe("Hono");
    });

    it("findCurrent returns null when no current fact exists", async () => {
      expect(await storage.facts.findCurrent("team_local", "nlm-memory-ts", "framework")).toBeNull();
    });

    it("list filters by subject and excludes superseded by default", async () => {
      await storage.facts.insertMany("team_local", [
        makeFact({
          id: "f1",
          subject: "mac-pro",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:00:00Z",
        }),
        makeFact({
          id: "f2",
          subject: "mac-pro",
          predicate: "model",
          value: "qwen2.5-3b",
          sourceSessionId: "sess_parent",
          createdAt: "2026-05-19T10:05:00Z",
        }),
        makeFact({
          id: "f3",
          subject: "other",
          predicate: "framework",
          value: "Hono",
          sourceSessionId: "sess_parent",
        }),
      ]);
      await storage.facts.markSuperseded("team_local", "f1", "f2");

      const current = await storage.facts.list("team_local", { subject: "mac-pro" });
      expect(current.map((f) => f.id)).toEqual(["f2"]);

      const all = await storage.facts.list("team_local", {
        subject: "mac-pro",
        includeSuperseded: true,
      });
      expect(all.map((f) => f.id)).toEqual(["f2", "f1"]); // created_at DESC
    });

    it("list with predicate narrows further", async () => {
      await storage.facts.insertMany("team_local", [
        makeFact({ id: "f1", subject: "x", predicate: "alpha", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f2", subject: "x", predicate: "beta", sourceSessionId: "sess_parent" }),
      ]);
      const out = await storage.facts.list("team_local", { subject: "x", predicate: "beta" });
      expect(out.map((f) => f.id)).toEqual(["f2"]);
    });

    it("listBySession returns all facts (including superseded) for a session", async () => {
      await h.seedSession(storage, makeSession({ id: "sess_other" }));
      await storage.facts.insertMany("team_local", [
        makeFact({ id: "f1", subject: "a", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f2", subject: "b", sourceSessionId: "sess_parent" }),
        makeFact({ id: "f3", subject: "c", sourceSessionId: "sess_other" }),
      ]);
      await storage.facts.markSuperseded("team_local", "f1", "f2");

      const out = await storage.facts.listBySession("team_local", "sess_parent");
      expect(out.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
    });

    it("markSuperseded throws when either id is missing", async () => {
      await storage.facts.insert("team_local", makeFact({ id: "real", sourceSessionId: "sess_parent" }));
      await expect(storage.facts.markSuperseded("team_local", "nope", "real")).rejects.toThrow(/not found/);
      await expect(storage.facts.markSuperseded("team_local", "real", "nope")).rejects.toThrow(/not found/);
    });

    it("markSuperseded rejects self-supersedence", async () => {
      await storage.facts.insert("team_local", makeFact({ id: "self", sourceSessionId: "sess_parent" }));
      await expect(storage.facts.markSuperseded("team_local", "self", "self")).rejects.toThrow(/itself/);
    });

    it("markSuperseded with null reverses an earlier supersedence", async () => {
      await storage.facts.insertMany("team_local", [
        makeFact({ id: "a", subject: "s", predicate: "p", value: "v1", sourceSessionId: "sess_parent" }),
        makeFact({ id: "b", subject: "s", predicate: "p", value: "v2", sourceSessionId: "sess_parent" }),
      ]);
      await storage.facts.markSuperseded("team_local", "a", "b");
      expect((await storage.facts.getById("team_local", "a"))?.supersededBy).toBe("b");
      await storage.facts.markSuperseded("team_local", "a", null);
      expect((await storage.facts.getById("team_local", "a"))?.supersededBy).toBeNull();
    });

    describe("retire", () => {
      it("hides a retired fact from findCurrent, list, and listForRecall", async () => {
        await storage.facts.insert("team_local", 
          makeFact({
            id: "f_bad",
            subject: "acme-app",
            predicate: "owner",
            value: "user",
            confidence: 0.9,
            sourceSessionId: "sess_parent",
          }),
        );

        await storage.facts.retire("team_local", "f_bad");

        expect(await storage.facts.findCurrent("team_local", "acme-app", "owner")).toBeNull();
        expect((await storage.facts.list("team_local", { subject: "acme-app" })).map((f) => f.id)).toEqual([]);
        expect(
          (await storage.facts.listForRecall("team_local", { subject: "acme-app", minConfidence: 0 })).map((f) => f.id),
        ).toEqual([]);
      });

      it("keeps a retired fact visible when includeSuperseded is set (audit trail)", async () => {
        await storage.facts.insert("team_local", 
          makeFact({ id: "f_bad", subject: "acme-app", predicate: "owner", value: "user", sourceSessionId: "sess_parent" }),
        );
        await storage.facts.retire("team_local", "f_bad");

        const all = await storage.facts.list("team_local", { subject: "acme-app", includeSuperseded: true });
        expect(all.map((f) => f.id)).toEqual(["f_bad"]);
        // getById is an unfiltered primitive — retired facts remain fetchable by id.
        expect(await storage.facts.getById("team_local", "f_bad")).not.toBeNull();
      });

      it("removes the embedding so semanticSearch no longer surfaces a retired fact", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_bad", sourceSessionId: "sess_parent" }));
        const vec = new Float32Array(768);
        vec[0] = 1;
        await storage.facts.upsertEmbedding("team_local", "f_bad", vec);

        await storage.facts.retire("team_local", "f_bad");

        const query = new Float32Array(768);
        query[0] = 1;
        const neighbors = await storage.facts.semanticSearch("team_local", query, 5);
        expect(neighbors.map((n) => n.factId)).not.toContain("f_bad");
      });

      it("throws when the fact does not exist", async () => {
        await expect(storage.facts.retire("team_local", "nope")).rejects.toThrow(/not found/);
      });

      it("is idempotent — retiring an already-retired fact is a no-op", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_bad", sourceSessionId: "sess_parent" }));
        await storage.facts.retire("team_local", "f_bad");
        await expect(storage.facts.retire("team_local", "f_bad")).resolves.toBeUndefined();
      });
    });

    describe("retired_at column visibility across read methods", () => {
      it("getById returns retiredAt null for a live fact", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_live", subject: "ra_sub", sourceSessionId: "sess_parent" }));
        const f = await storage.facts.getById("team_local", "f_ra_live");
        expect(f!.retiredAt).toBeNull();
      });

      it("getById returns non-null retiredAt after retire", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_getbyid", sourceSessionId: "sess_parent" }));
        await storage.facts.retire("team_local", "f_ra_getbyid");
        const f = await storage.facts.getById("team_local", "f_ra_getbyid");
        expect(f!.retiredAt).not.toBeNull();
      });

      it("findCurrent returns retiredAt null for a live fact", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_fc", subject: "ra_fc_sub", predicate: "ra_fc_pred", sourceSessionId: "sess_parent" }));
        const f = await storage.facts.findCurrent("team_local", "ra_fc_sub", "ra_fc_pred");
        expect(f!.retiredAt).toBeNull();
      });

      it("list returns retiredAt null for live facts", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_list", subject: "ra_list_sub", sourceSessionId: "sess_parent" }));
        const facts = await storage.facts.list("team_local", { subject: "ra_list_sub" });
        expect(facts[0]!.retiredAt).toBeNull();
      });

      it("list with includeSuperseded returns non-null retiredAt for retired facts", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_list_ret", subject: "ra_list_ret_sub", sourceSessionId: "sess_parent" }));
        await storage.facts.retire("team_local", "f_ra_list_ret");
        const facts = await storage.facts.list("team_local", { subject: "ra_list_ret_sub", includeSuperseded: true });
        const f = facts.find((x) => x.id === "f_ra_list_ret");
        expect(f!.retiredAt).not.toBeNull();
      });

      it("listBySession returns retiredAt null for live facts", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_lbs", subject: "ra_lbs_sub", sourceSessionId: "sess_parent" }));
        const facts = await storage.facts.listBySession("team_local", "sess_parent");
        const f = facts.find((x) => x.id === "f_ra_lbs");
        expect(f!.retiredAt).toBeNull();
      });

      it("listForRecall returns retiredAt null for live facts", async () => {
        await storage.facts.insert("team_local", makeFact({ id: "f_ra_lfr", subject: "ra_lfr_sub", sourceSessionId: "sess_parent" }));
        const facts = await storage.facts.listForRecall("team_local", { subject: "ra_lfr_sub" });
        expect(facts[0]!.retiredAt).toBeNull();
      });
    });

    it("CHECK constraints reject invalid kind", async () => {
      await expect(
        storage.facts.insert("team_local", 
          // @ts-expect-error: exercising the CHECK constraint at runtime
          makeFact({ id: "bad", kind: "garbage", sourceSessionId: "sess_parent" }),
        ),
      ).rejects.toThrow();
    });

    it("CHECK constraints reject confidence out of [0, 1]", async () => {
      await expect(
        storage.facts.insert("team_local", 
          makeFact({ id: "bad", confidence: 1.5, sourceSessionId: "sess_parent" }),
        ),
      ).rejects.toThrow();
    });

    it("FK constraint rejects facts pointing at missing sessions", async () => {
      await expect(
        storage.facts.insert("team_local", 
          makeFact({ id: "orphan", sourceSessionId: "no_such_session" }),
        ),
      ).rejects.toThrow();
    });

    describe("listForRecall", () => {
      beforeEach(async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({
            id: "f_hono", subject: "nlm-memory-ts", predicate: "framework",
            value: "Hono", confidence: 0.9, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_endpoint", kind: "attribute", subject: "mac-pro", predicate: "endpoint",
            value: "http://macpro:8080/v1", confidence: 0.85, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_low", subject: "x", predicate: "other", value: "y",
            confidence: 0.5, sourceSessionId: "sess_parent",
          }),
          makeFact({
            id: "f_fastify", subject: "nlm-memory-ts", predicate: "framework",
            value: "Fastify", confidence: 0.9, sourceSessionId: "sess_parent",
          }),
        ]);
        await storage.facts.markSuperseded("team_local", "f_fastify", "f_hono");
      });

      it("filters by subject + predicate, excluding superseded by default", async () => {
        const out = await storage.facts.listForRecall("team_local", {
          subject: "nlm-memory-ts",
          predicate: "framework",
        });
        expect(out.map((f) => f.id)).toEqual(["f_hono"]);
      });

      it("applies minConfidence at the SQL layer", async () => {
        const all = await storage.facts.listForRecall("team_local", { minConfidence: 0 });
        expect(all.map((f) => f.id).sort()).toEqual(["f_endpoint", "f_hono", "f_low"]);
        const high = await storage.facts.listForRecall("team_local", { minConfidence: 0.8 });
        expect(high.map((f) => f.id).sort()).toEqual(["f_endpoint", "f_hono"]);
      });

      it("finds matching old facts before the candidate limit in both backends", async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "old_lexical", subject: "archive", predicate: "framework", value: "Zebradb",
            sourceSessionId: "sess_parent", createdAt: "2020-01-01T00:00:00Z" }),
          ...Array.from({ length: 501 }, (_, i) => makeFact({ id: `recent_${i}`, subject: `recent-${i}`,
            value: "noise", sourceSessionId: "sess_parent", createdAt: "2026-10-16T00:00:00Z" })),
        ]);
        const rows = await storage.facts.listForRecall("team_local", { query: "Zebradb", limit: 1 });
        expect(rows.map((f) => f.id)).toEqual(["old_lexical"]);
        expect(await storage.facts.listForRecall("other_team", { query: "Zebradb", limit: 1 })).toEqual([]);
      });

      it("treats lexical query syntax as text and applies structured lifecycle filters", async () => {
        const rows = await storage.facts.listForRecall("team_local", {
          query: '"Hono" OR :*', subject: "nlm-memory-ts", minConfidence: 0.8,
        });
        expect(rows.map((f) => f.id)).toEqual(["f_hono"]);
        expect(await storage.facts.listForRecall("team_local", { query: "Fastify" })).toEqual([]);
        expect(await storage.facts.listForRecall("team_local", { query: "***" })).toEqual([]);
      });

      it("kind filter restricts the result set", async () => {
        const out = await storage.facts.listForRecall("team_local", { kind: "attribute" });
        expect(out.map((f) => f.id)).toEqual(["f_endpoint"]);
      });
    });

    describe("getHistory", () => {
      it("returns one chain per predicate when only subject is given", async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({
            id: "f1", subject: "s", predicate: "framework", value: "Fastify",
            sourceSessionId: "sess_parent", createdAt: "2026-05-18T00:00:00Z",
          }),
          makeFact({
            id: "f2", subject: "s", predicate: "framework", value: "Hono",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
          makeFact({
            id: "f3", subject: "s", predicate: "endpoint", value: ":8080",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
        ]);
        await storage.facts.markSuperseded("team_local", "f1", "f2");

        const chains = await storage.facts.getHistory("team_local", "s");
        expect(chains).toHaveLength(2);
        const framework = chains.find((c) => c.predicate === "framework");
        expect(framework?.history.map((f) => f.id)).toEqual(["f2", "f1"]);
        const endpoint = chains.find((c) => c.predicate === "endpoint");
        expect(endpoint?.history.map((f) => f.id)).toEqual(["f3"]);
      });

      it("narrows to a single chain when predicate is provided", async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({
            id: "a", subject: "s", predicate: "framework", value: "v1",
            sourceSessionId: "sess_parent", createdAt: "2026-05-18T00:00:00Z",
          }),
          makeFact({
            id: "b", subject: "s", predicate: "framework", value: "v2",
            sourceSessionId: "sess_parent", createdAt: "2026-05-19T00:00:00Z",
          }),
          makeFact({
            id: "c", subject: "s", predicate: "endpoint", value: ":8080",
            sourceSessionId: "sess_parent",
          }),
        ]);
        const chains = await storage.facts.getHistory("team_local", "s", "framework");
        expect(chains).toHaveLength(1);
        expect(chains[0]?.history.map((f) => f.id)).toEqual(["b", "a"]);
      });

      it("returns empty array when no matches", async () => {
        const chains = await storage.facts.getHistory("team_local", "nonexistent");
        expect(chains).toEqual([]);
      });
    });

    describe("corroborationCounts", () => {
      it("returns 0 for triples never asserted", async () => {
        const counts = await storage.facts.corroborationCounts("team_local", [
          { subject: "x", predicate: "y", value: "z" },
        ]);
        expect(counts.get("x y z")).toBe(0);
      });

      it("counts a single assertion as 1", async () => {
        await storage.facts.insert("team_local", 
          makeFact({
            id: "f1",
            subject: "beacon",
            predicate: "uses",
            value: "duckdb",
            sourceSessionId: "sess_parent",
          }),
        );
        const counts = await storage.facts.corroborationCounts("team_local", [
          { subject: "beacon", predicate: "uses", value: "duckdb" },
        ]);
        expect(counts.get("beacon uses duckdb")).toBe(1);
      });

      it("counts distinct sessions across the full history (including superseded)", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_a", label: "A" }));
        await h.seedSession(storage, makeSession({ id: "sess_b", label: "B" }));
        await h.seedSession(storage, makeSession({ id: "sess_c", label: "C" }));
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "f_a", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_a" }),
          makeFact({ id: "f_b", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_b" }),
          makeFact({ id: "f_c", subject: "p", predicate: "u", value: "duckdb", sourceSessionId: "sess_c" }),
        ]);
        // Mark earlier ones as superseded — the contract is that they STILL count.
        await storage.facts.markSuperseded("team_local", "f_a", "f_c");
        await storage.facts.markSuperseded("team_local", "f_b", "f_c");
        const counts = await storage.facts.corroborationCounts("team_local", [
          { subject: "p", predicate: "u", value: "duckdb" },
        ]);
        expect(counts.get("p u duckdb")).toBe(3);
      });

      it("does not double-count multiple facts from the same session", async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "f1", subject: "x", predicate: "y", value: "v", sourceSessionId: "sess_parent" }),
          makeFact({ id: "f2", subject: "x", predicate: "y", value: "v", sourceSessionId: "sess_parent" }),
        ]);
        const counts = await storage.facts.corroborationCounts("team_local", [
          { subject: "x", predicate: "y", value: "v" },
        ]);
        // Distinct sessions, so 2 rows from one session = 1
        expect(counts.get("x y v")).toBe(1);
      });

      it("returns the empty map for empty input", async () => {
        const counts = await storage.facts.corroborationCounts("team_local", []);
        expect(counts.size).toBe(0);
      });

      it("batches multiple triples in a single call", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_a", label: "A" }));
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "f1", subject: "x", predicate: "y", value: "a", sourceSessionId: "sess_parent" }),
          makeFact({ id: "f2", subject: "x", predicate: "y", value: "a", sourceSessionId: "sess_a" }),
          makeFact({ id: "f3", subject: "x", predicate: "y", value: "b", sourceSessionId: "sess_a" }),
        ]);
        const counts = await storage.facts.corroborationCounts("team_local", [
          { subject: "x", predicate: "y", value: "a" },
          { subject: "x", predicate: "y", value: "b" },
          { subject: "x", predicate: "y", value: "never-asserted" },
        ]);
        expect(counts.get("x y a")).toBe(2);
        expect(counts.get("x y b")).toBe(1);
        expect(counts.get("x y never-asserted")).toBe(0);
      });
    });

    describe("semanticSearch", () => {
      it("returns nearest neighbors by L2 distance over fact_embeddings", async () => {
        await storage.facts.insertMany("team_local", [
          makeFact({ id: "near", sourceSessionId: "sess_parent" }),
          makeFact({ id: "far", subject: "other", sourceSessionId: "sess_parent" }),
        ]);
        // Unit vectors: nearVec aligned with query, farVec orthogonal. Use
        // ordering assertion only (distance, lower is better) so a PG
        // adapter with a different distance literal still passes.
        const near = new Float32Array(768);
        near[0] = 1;
        const far = new Float32Array(768);
        far[1] = 1;
        await storage.facts.upsertEmbedding("team_local", "near", near);
        await storage.facts.upsertEmbedding("team_local", "far", far);

        const query = new Float32Array(768);
        query[0] = 1;
        const neighbors = await storage.facts.semanticSearch("team_local", query, 5);
        expect(neighbors[0]?.factId).toBe("near");
        expect(neighbors[0]!.distance).toBeLessThan(neighbors[1]!.distance);
      });
    });

    describe("ingestSessionFacts", () => {
      it("inserts new facts attributed to the session", async () => {
        const f1 = makeFact({
          id: "f1",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", [f1]);
        const stored = await storage.facts.getById("team_local", "f1");
        expect(stored?.value).toBe("red");
      });

      it("deletes prior facts for the same session before re-ingesting", async () => {
        const original = makeFact({
          id: "orig",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", [original]);
        const replacement = makeFact({
          id: "new",
          subject: "alpha",
          predicate: "color",
          value: "blue",
          sourceSessionId: "sess_parent",
        });
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", [replacement]);
        expect(await storage.facts.getById("team_local", "orig")).toBeNull();
        expect((await storage.facts.getById("team_local", "new"))?.value).toBe("blue");
      });

      it("supersedes a current fact from another session on (subject,predicate) collision", async () => {
        await h.seedSession(storage, makeSession({ id: "sess_other", label: "Other" }));
        const older = makeFact({
          id: "older",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_other",
        });
        const newer = makeFact({
          id: "newer",
          subject: "alpha",
          predicate: "color",
          value: "blue",
          sourceSessionId: "sess_parent",
        });
        await storage.facts.ingestSessionFacts("team_local", "sess_other", [older]);
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", [newer]);
        const olderFetched = await storage.facts.getById("team_local", "older");
        expect(olderFetched?.supersededBy).toBe("newer");
        const current = await storage.facts.findCurrent("team_local", "alpha", "color");
        expect(current?.id).toBe("newer");
      });

      it("is a no-op for empty fact array but still deletes prior session facts", async () => {
        const f = makeFact({
          id: "to-delete",
          subject: "alpha",
          predicate: "color",
          value: "red",
          sourceSessionId: "sess_parent",
        });
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", [f]);
        await storage.facts.ingestSessionFacts("team_local", "sess_parent", []);
        expect(await storage.facts.getById("team_local", "to-delete")).toBeNull();
      });
    });
  });
}
