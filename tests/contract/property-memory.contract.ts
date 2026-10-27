import type { LLMClient } from "../../src/ports/llm-client.js";
import { locateSourceAnchor } from "../../src/core/facts/source-anchor.js";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { Fact } from "../../src/shared/types.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { recallContext } from "../../src/core/context/recall-context.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import { corroborationKey } from "../../src/ports/fact-store.js";
import { anchorRecord } from "./source-anchor.contract.js";

export function runPropertyMemoryContract(h: { attributeSession(s: Storage, tenantId: string, record: { id: string; entities: readonly string[] }): Promise<void>; maintain(s: Storage, sessionId: string, facts: readonly Fact[], embedder: LLMClient): Promise<void>; setup(): Promise<Storage>; close(s: Storage): Promise<void>; ingest(s: Storage, record: IngestRecord, facts: readonly Fact[], embedder?: LLMClient): Promise<void> }) {
  describe("property memory", () => {
    let storage: Storage;
    const tenant = "team_local";
    const catalog = [{ slug: "nxtseo", label: "NxtSEO", aliases: ["SEO app"] }, { slug: "nxtads", label: "NxtAds" }];
    const fact = (id: string, session: string, slug?: string): Fact => ({ id, kind: "attribute", subject: "api", predicate: "port", value: id,
      sourceSessionId: session, sourceQuote: null, createdAt: "2026-01-01T00:00:00Z", confidence: 1, supersededBy: null,
      ...(slug ? { property: { slug, source: "explicit", evidence: "test task" } } : {}) });
    const ingest = async (id: string, facts: readonly Fact[]) => h.ingest(storage, anchorRecord("mixed project conversation", id), facts);
    beforeEach(async () => { vi.stubEnv("NLM_PROPERTY_ASSOCIATIONS", "1"); vi.stubEnv("NLM_PROPERTY_INFERENCE", "1"); storage = await h.setup(); await storage.properties.import(tenant, catalog); });
    afterEach(async () => { vi.unstubAllEnvs(); await h.close(storage); });
    it("keeps unvalidated inference disabled while explicit associations remain usable", async () => {
      vi.stubEnv("NLM_PROPERTY_INFERENCE", "0");
      await storage.properties.import(tenant, [{ slug: "nxtads", label: "NxtAds", repositories: ["/nonexistent-property-test/nxtads"] }]);
      const body = "A fresh desktop install must have NxtSEO or degrade gracefully.";
      await h.ingest(storage, { ...anchorRecord(body, "s1"), entities: ["NxtSEO"], projectDir: "/nonexistent-property-test/nxtads/task" }, [
        { ...fact("unproven", "s1"), subject: "NxtSEO", sourceQuote: body, sourceAnchor: locateSourceAnchor(body, body) },
        fact("explicit", "s1", "nxtads"),
      ]);
      expect((await storage.facts.getById(tenant, "unproven"))?.property).toBeUndefined();
      expect((await storage.facts.getById(tenant, "explicit"))?.property?.slug).toBe("nxtads");
      expect(await storage.sessions.keywordSearch(tenant, "desktop", 5, { property: "nxtseo" })).toEqual([]);
      expect(await storage.sessions.keywordSearch(tenant, "desktop", 5, { property: "nxtads" })).toHaveLength(1);
      await expect(storage.properties.backfill(tenant, true)).rejects.toThrow("has not passed");
      await storage.properties.associateSession(tenant, "s1", ["nxtseo"]);
      expect(await storage.sessions.keywordSearch(tenant, "desktop", 5, { property: "nxtseo" })).toHaveLength(1);
    });
    it("removes rejected automatic attribution during backfill and disabled re-ingestion", async () => {
      const body = "NxtSEO uses 3940.";
      const automatic = { ...fact("old", "s1"), subject: "api", property: { slug: "nxtseo", source: "subject" as const, evidence: "api" } };
      await h.ingest(storage, anchorRecord(body, "s1"), [automatic]);
      await storage.facts.insert(tenant, { ...automatic, id: "legacy" });
      expect(await storage.properties.backfill(tenant, false)).toContainEqual({ factId: "legacy", slug: null, source: null });
      expect((await storage.facts.getById(tenant, "legacy"))?.property?.slug).toBe("nxtseo");
      await storage.properties.backfill(tenant, true);
      expect((await storage.facts.getById(tenant, "legacy"))?.property).toBeUndefined();
      expect(await storage.properties.backfill(tenant, true)).toEqual([]);
      const restorable = { ...automatic, sourceQuote: body, sourceAnchor: locateSourceAnchor(body, body) };
      await storage.facts.insert(tenant, { ...restorable, id: "legacy-again" });
      vi.stubEnv("NLM_PROPERTY_INFERENCE", "0");
      await h.ingest(storage, anchorRecord(body, "s1"), [{ ...restorable, id: "reingested", property: undefined }]);
      expect((await storage.facts.getById(tenant, "reingested"))?.property).toBeUndefined();
    });
    it("isolates same-key collapse within a batch and across properties", async () => {
      await ingest("s1", [fact("seo-old", "s1", "nxtseo"), fact("ads", "s1", "nxtads")]);
      await ingest("s2", [fact("seo-new", "s2", "nxtseo")]);
      expect((await storage.facts.getById(tenant, "ads"))?.supersededBy).toBeNull();
      expect((await storage.facts.getById(tenant, "seo-old"))?.supersededBy).toBe("seo-new");
      expect((await storage.facts.listForRecall(tenant, { property: "nxtads" })).map((f) => f.id)).toEqual(["ads"]);
    });
    it("unresolved assertions cannot overwrite known or unresolved assertions", async () => {
      await ingest("s1", [fact("known", "s1", "nxtseo")]);
      await ingest("s2", [fact("unknown", "s2"), fact("unknown2", "s2")]);
      expect((await storage.facts.getById(tenant, "known"))?.supersededBy).toBeNull();
      expect((await storage.facts.getById(tenant, "unknown"))?.supersededBy).toBeNull();
    });
    it("attributes grounded subjects independently in a mixed session", async () => {
      const body = "SEO app uses port 3940. NxtAds uses port 8000.";
      await h.ingest(storage, anchorRecord(body, "s1"), [
        { ...fact("seo", "s1"), subject: "SEO app", value: "3940", sourceQuote: "SEO app uses port 3940", sourceAnchor: locateSourceAnchor(body, "SEO app uses port 3940") },
        { ...fact("ads", "s1"), subject: "NxtAds", value: "8000", sourceQuote: "NxtAds uses port 8000", sourceAnchor: locateSourceAnchor(body, "NxtAds uses port 8000") }, fact("unknown", "s1"),
      ]);
      expect((await storage.facts.getById(tenant, "seo"))?.property?.slug).toBe("nxtseo");
      expect((await storage.facts.getById(tenant, "ads"))?.property?.slug).toBe("nxtads");
      expect((await storage.facts.getById(tenant, "unknown"))?.property).toBeUndefined();
    });
    it("embeds facts using their resolved contexts rather than the original unassigned batch", async () => {
      const body = "NxtSEO API uses 3940. NxtAds API uses 8000.";
      const llm = new FixedEmbedder();
      await h.ingest(storage, anchorRecord(body, "s1"), [
        { ...fact("seo", "s1"), value: "3940", sourceQuote: "NxtSEO API uses 3940", sourceAnchor: locateSourceAnchor(body, "NxtSEO API uses 3940") },
        { ...fact("ads", "s1"), value: "8000", sourceQuote: "NxtAds API uses 8000", sourceAnchor: locateSourceAnchor(body, "NxtAds API uses 8000") },
      ], llm);
      const query = (await llm.embed()).vector;
      expect((await storage.facts.semanticSearch(tenant, query, 5, { property: "nxtseo" })).map((f) => f.factId)).toEqual(["seo"]);
      expect((await storage.facts.semanticSearch(tenant, query, 5, { property: "nxtads" })).map((f) => f.factId)).toEqual(["ads"]);
    });
    it("embeds maintained facts using stored corrections even with inference disabled", async () => {
      const body = "API port 3940. API port 8000.";
      const llm = new FixedEmbedder();
      const raw = [
        { ...fact("seo", "s1"), value: "3940", sourceQuote: "API port 3940", sourceAnchor: locateSourceAnchor(body, "API port 3940") },
        { ...fact("ads", "s1"), value: "8000", sourceQuote: "API port 8000", sourceAnchor: locateSourceAnchor(body, "API port 8000") },
      ];
      await h.ingest(storage, anchorRecord(body, "s1"), raw);
      await storage.properties.correctFact(tenant, "seo", "nxtseo");
      await storage.properties.correctFact(tenant, "ads", "nxtads");
      vi.stubEnv("NLM_PROPERTY_ASSOCIATIONS", "0");
      await h.maintain(storage, "s1", raw.map((f) => ({ ...f, id: f.id + "-new" })), llm);
      const query = (await llm.embed()).vector;
      expect((await storage.facts.semanticSearch(tenant, query, 5, { property: "nxtseo" })).map((f) => f.factId)).toEqual(["seo-new"]);
      expect((await storage.facts.semanticSearch(tenant, query, 5, { property: "nxtads" })).map((f) => f.factId)).toEqual(["ads-new"]);
    });
    it("keeps corrections through new fact IDs, and reports changed assertions as pending", async () => {
      const original = { ...fact("original", "s1"), value: "3940" };
      await ingest("s1", [original]);
      await storage.properties.correctFact(tenant, "original", "nxtads");
      await ingest("s1", [{ ...original, id: "replacement" }]);
      expect((await storage.facts.getById(tenant, "replacement"))?.property).toMatchObject({ slug: "nxtads", source: "operator" });
      expect(await storage.properties.pendingCorrections(tenant)).toEqual([]);
      await ingest("s1", [{ ...original, id: "changed", value: "9999" }]);
      expect((await storage.facts.getById(tenant, "changed"))?.property).toBeUndefined();
      expect(await storage.properties.pendingCorrections(tenant)).toHaveLength(1);
    });
    it("does not transfer an unquoted correction into a changed source context", async () => {
      const original = { ...fact("original", "s1"), value: "3940" };
      await ingest("s1", [original]);
      await storage.properties.correctFact(tenant, "original", "nxtseo");
      await h.ingest(storage, anchorRecord("The discussion now concerns a different project", "s1"), [{ ...original, id: "replacement" }]);
      expect((await storage.facts.getById(tenant, "replacement"))?.property).toBeUndefined();
      expect(await storage.properties.pendingCorrections(tenant)).toHaveLength(1);
    });
    it("suppresses rejected associations across re-ingestion", async () => {
      const original = { ...fact("original", "s1"), subject: "NxtSEO" };
      await ingest("s1", [original]); await storage.properties.correctFact(tenant, "original", null);
      await ingest("s1", [{ ...original, id: "replacement" }]);
      expect((await storage.facts.getById(tenant, "replacement"))?.property).toMatchObject({ slug: null, source: "operator" });
    });
    it("rejects alias collisions, foreign fact corrections and duplicate assertion corrections", async () => {
      await expect(storage.properties.import(tenant, [{ slug: "other", label: "NxtSEO" }])).rejects.toThrow("Ambiguous");
      await ingest("s1", [fact("one", "s1"), { ...fact("one", "s1"), id: "two" }]);
      await expect(storage.properties.correctFact(tenant, "one", "nxtseo")).rejects.toThrow("Ambiguous");
      await expect(storage.properties.correctFact("another-tenant", "one", null)).rejects.toThrow("not found");
      expect(await storage.properties.list("another-tenant")).toEqual([]);
    });
    it("filters semantic eligibility before top-k under unrelated-vector competition", async () => {
      await ingest("s1", [fact("wanted", "s1", "nxtseo"), ...Array.from({ length: 30 }, (_, i) => ({ ...fact(`noise-${i}`, "s1", "nxtads"), subject: `noise-${i}` }))]);
      const query = new Float32Array(768); query[0] = 1;
      const wanted = new Float32Array(768); wanted[1] = 1;
      await storage.facts.upsertEmbedding(tenant, "wanted", wanted);
      for (let i = 0; i < 30; i++) await storage.facts.upsertEmbedding(tenant, `noise-${i}`, query);
      expect((await storage.facts.semanticSearch(tenant, query, 1, { property: "nxtseo" })).map((n) => n.factId)).toEqual(["wanted"]);
    });
    it("keeps corroboration, history and exact context lookups within their property", async () => {
      await ingest("s1", [{ ...fact("seo", "s1", "nxtseo"), value: "3940" }, { ...fact("ads", "s1", "nxtads"), value: "3940" }]);
      await ingest("s2", [{ ...fact("ads2", "s2", "nxtads"), value: "3940" }]);
      const counts = await storage.facts.corroborationCounts(tenant, [{ subject: "api", predicate: "port", value: "3940", property: "nxtseo" }]);
      expect(counts.get(corroborationKey("api", "port", "3940", "nxtseo"))).toBe(1);
      const histories = await storage.facts.getHistory(tenant, "api", "port");
      expect(histories).toHaveLength(2);
      expect(await storage.facts.getHistory(tenant, "api", "port", "nxtseo")).toHaveLength(1);
      const llm = new FixedEmbedder();
      const factRecall = new FactRecallService({ factStore: storage.facts, llm, properties: storage.properties });
      const recall = new RecallService({ store: storage.sessions, llm, properties: storage.properties });
      const deps = { factRecall, recall, factStore: storage.facts, store: storage.sessions, properties: storage.properties };
      const result = await recallContext(tenant, { query: "api port", subject: "api", predicate: "port", property: "nxtseo", mode: "keyword", timeoutMs: 5000 }, deps);
      expect(result.facts.map((f) => f.id)).toEqual(["seo"]);
      expect(result.lookup?.sourceSessionCount).toBe(1);
      const hits = await factRecall.search(tenant, { subject: "api", property: "nxtseo", mode: "keyword" });
      expect(hits.results[0]?.corroborationCount).toBe(1);
      await expect(factRecall.search(tenant, { subject: "api", property: "missing" })).rejects.toThrow("Unknown property");
    });
    it("rejects a foreign source session at the attribution write boundary", async () => {
      await ingest("s1", []);
      await storage.properties.import("other-tenant", catalog);
      await expect(h.attributeSession(storage, "other-tenant", { id: "s1", entities: ["NxtSEO"] })).rejects.toThrow("Source session not found");
    });
    it("associates sessions without assigning ownership to their facts", async () => {
      await h.ingest(storage, { ...anchorRecord("mixed project conversation", "s1"), entities: ["NxtSEO", "NxtAds"] }, [fact("unknown", "s1")]);
      expect((await storage.sessions.keywordSearch(tenant, "mixed", 5, { property: "nxtseo" })).map((s) => s.sessionId)).toEqual(["s1"]);
      expect((await storage.sessions.keywordSearch(tenant, "mixed", 5, { property: "nxtads" })).map((s) => s.sessionId)).toEqual(["s1"]);
      expect((await storage.facts.getById(tenant, "unknown"))?.property).toBeUndefined();
      await ingest("s2", []);
      await storage.properties.associateSession(tenant, "s2", ["nxtseo"]);
      expect((await storage.sessions.keywordSearch(tenant, "mixed", 5, { property: "nxtseo" })).map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
      await storage.properties.associateSession(tenant, "s2", []);
      expect((await storage.sessions.keywordSearch(tenant, "mixed", 5, { property: "nxtseo" })).map((s) => s.sessionId)).toEqual(["s1"]);
      await expect(storage.properties.associateSession("other-tenant", "s1", ["nxtseo"])).rejects.toThrow("not found");
    });
    it("does not cascade a session supersession across assertion contexts", async () => {
      await ingest("s1", [fact("seo", "s1", "nxtseo")]);
      await ingest("s2", [fact("ads", "s2", "nxtads")]);
      await storage.sessions.markSuperseded(tenant, "s1", "s2");
      expect((await storage.facts.getById(tenant, "seo"))?.supersededBy).toBeNull();
    });
    it("backfills attribution without changing lifecycle, defaults to dry-run and is idempotent", async () => {
      vi.stubEnv("NLM_PROPERTY_ASSOCIATIONS", "0");
      const body = "NxtSEO uses port 3940.";
      await h.ingest(storage, anchorRecord(body, "s1"), [{ ...fact("legacy", "s1"), subject: "NxtSEO", sourceQuote: body, sourceAnchor: locateSourceAnchor(body, body) }]);
      expect(await storage.properties.backfill(tenant, false)).toEqual([{ factId: "legacy", slug: "nxtseo", source: "subject" }]);
      expect((await storage.facts.getById(tenant, "legacy"))?.property).toBeUndefined();
      await storage.properties.backfill(tenant, true);
      expect((await storage.facts.getById(tenant, "legacy"))?.supersededBy).toBeNull();
      expect(await storage.properties.backfill(tenant, true)).toEqual([]);
    });
  });
}
