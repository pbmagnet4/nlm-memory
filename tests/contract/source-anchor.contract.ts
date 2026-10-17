import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import type { Fact } from "../../src/shared/types.js";
import { extractFacts } from "../../src/core/facts/extract-facts.js";
import { ingestSession } from "../../src/core/ingest/ingest-session.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import type { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { PgStorage } from "../../src/core/storage/pg-storage.js";
import { bodyVersion } from "../../src/core/context/source-version.js";

export interface AnchorHarness {
  readonly wiki?: boolean;
  setup(): Promise<Storage>;
  close(storage: Storage): Promise<void>;
  sql(storage: Storage, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  ingest(storage: Storage, record: IngestRecord, facts?: Fact[]): Promise<void>;
  migrate(storage: Storage): Promise<unknown[]>;
  maintain(storage: Storage, facts: Fact[]): Promise<void>;
}
const tenant = "team_local";
export function anchorRecord(body = "😀 e\u0301 chose DuckDB.", id = "anchor-session"): IngestRecord {
  return { id, runtime: "test", runtimeSessionId: id, startedAt: "2026-01-01T00:00:00Z", endedAt: null,
    durationMin: null, label: "L", summary: "S", body, status: "closed", transcriptKind: "test",
    transcriptPath: null, transcriptOffset: null, transcriptLength: null, entities: [], decisions: [], openQuestions: [], scope: null };
}
export function anchorFacts(body: string, quote = "chose DuckDB", id = "anchor-fact"): Fact[] {
  return extractFacts({ label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 1,
    facts: [{ kind: "attribute", subject: "source", predicate: "database", value: "DuckDB", sourceQuote: quote }] },
  "anchor-session", "2026-01-01T00:00:00Z", { sourceBody: body, idGenerator: () => id });
}
export function runSourceAnchorContract(h: AnchorHarness) {
  describe("persisted source integrity", () => {
    let storage: Storage;
    beforeEach(async () => { storage = await h.setup(); });
    afterEach(async () => { await h.close(storage); });
    const ingest = async (body = "😀 e\u0301 chose DuckDB.") => h.ingest(storage, anchorRecord(body), anchorFacts(body));
    const fact = () => storage.facts.getById(tenant, "anchor-fact");
    const version = async () => (await h.sql(storage, "SELECT body_version FROM sessions WHERE id = ?", ["anchor-session"]))[0]?.body_version;

    it("persists versioned UTF-16 anchors and projects them on every fact read", async () => {
      await ingest();
      const session = await storage.sessions.getById(tenant, "anchor-session");
      const anchor = (await fact())!.sourceAnchor;
      expect(anchor?.status).toBe("verified");
      expect(session!.bodyVersion).toBe(bodyVersion(session!.body));
      if (anchor?.status === "verified") {
        expect(anchor.bodyVersion).toBe(session!.bodyVersion);
        expect(session!.body.slice(anchor.start, anchor.end)).toBe((await fact())!.sourceQuote);
      }
      const reads = [await storage.facts.getByIds(tenant, ["anchor-fact"]),
        [await storage.facts.findCurrent(tenant, "source", "database")],
        await storage.facts.list(tenant, { subject: "source" }),
        await storage.facts.listBySession(tenant, "anchor-session"),
        await storage.facts.listBySessions(tenant, ["anchor-session"]),
        await storage.facts.listForRecall(tenant, { query: "DuckDB" }),
        ...(h.wiki ? [await storage.facts.listBySubjects(tenant, ["source"])] : []),
        (await storage.facts.getHistory(tenant, "source"))[0]!.history,
        (await storage.facts.getHistory(tenant, "source", "database"))[0]!.history];
      for (const rows of reads) expect(rows[0]?.sourceAnchor).toEqual(anchor);
    });
    it.each([["aaaa", "aa", "ambiguous"], ["no quote", "present", "invalid"]] as const)("versions %s negative assessments without offsets and invalidates them on source change", async (body, quote, status) => {
      await h.ingest(storage, anchorRecord(body), anchorFacts(body, quote));
      expect((await fact())!.sourceAnchor).toEqual({ status, bodyVersion: bodyVersion(body) });
      expect(await h.sql(storage, "SELECT source_start, source_end FROM facts WHERE id = ?", ["anchor-fact"]))
        .toEqual([{ source_start: null, source_end: null }]);
      await h.sql(storage, "UPDATE sessions SET body = ? WHERE id = ?", [`now ${quote} unique`, "anchor-session"]);
      expect((await fact())!.sourceAnchor).toEqual({ status: "stale" });
      expect(await version()).toBeNull();
    });
    it("versions batched session metadata and persists anchors through single/batch fact writes", async () => {
      await h.ingest(storage, anchorRecord());
      expect((await storage.sessions.getByIds(tenant, ["anchor-session"]))[0]!.bodyVersion).toBe(bodyVersion(anchorRecord().body!));
      await storage.facts.insert(tenant, anchorFacts(anchorRecord().body!, "chose DuckDB", "single")[0]!);
      await storage.facts.insertMany(tenant, anchorFacts(anchorRecord().body!, "chose DuckDB", "batch"));
      for (const id of ["single", "batch"]) expect((await storage.facts.getById(tenant, id))!.sourceAnchor?.status).toBe("verified");
    });
    it("webhook extraction verifies the capped persisted body and calls the classifier once", async () => {
      let calls = 0;
      const llm = new FixedEmbedder();
      const classifier = Object.assign(llm, { classify: async () => {
        calls++;
        return { label: "L", summary: "S", confidence: 1, entities: [], decisions: [], open: [], facts: [
          { kind: "attribute" as const, subject: "source", predicate: "database", value: "DuckDB", sourceQuote: "beyond-cap" },
        ] };
      } });
      const writable = storage as SqliteStorage | PgStorage;
      const deps = { classifier, embedder: llm, store: writable.sessions, factStore: writable.facts };
      await ingestSession({ id: "anchor-session", runtime: "test", text: "x".repeat(200_000) + "beyond-cap" }, deps, tenant);
      expect(calls).toBe(1);
      expect((await storage.sessions.getById(tenant, "anchor-session"))!.body.length).toBe(200_000);
      expect((await storage.facts.listBySession(tenant, "anchor-session"))[0]!.sourceAnchor).toEqual({ status: "invalid", bodyVersion: bodyVersion("x".repeat(200_000)) });
    });
    it("keeps unchanged reingests valid and invalidates anchors when the source changes", async () => {
      await ingest();
      const before = await version();
      await h.ingest(storage, anchorRecord());
      expect(await version()).toBe(before);
      expect((await fact())!.sourceAnchor?.status).toBe("verified");
      await h.ingest(storage, anchorRecord("new body"));
      expect(await version()).toBe(bodyVersion("new body"));
      expect((await fact())!.sourceAnchor).toEqual({ status: "stale" });
    });
    it.each(["UPDATE", "UPSERT"])("invalidates versions after an old-style %s, but preserves unchanged bodies", async (mode) => {
      await ingest();
      const change = async (body: string) => {
        if (mode === "UPDATE") await h.sql(storage, "UPDATE sessions SET body = ? WHERE id = ?", [body, "anchor-session"]);
        else await h.sql(storage, `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, body, status, tenant_id)
          VALUES (?, 'test', 'anchor-session', '2026-01-01', 'L', 'S', ?, 'closed', 'team_local')
          ON CONFLICT(id) DO UPDATE SET body = excluded.body`, ["anchor-session", body]);
      };
      await change(anchorRecord().body!);
      expect((await fact())!.sourceAnchor?.status).toBe("verified");
      await change("old binary changed source");
      expect(await version()).toBeNull();
      expect((await fact())!.sourceAnchor).toEqual({ status: "stale" });
    });
    it("keeps nullable legacy rows readable without read-side writes; migration runner is idempotent", async () => {
      await ingest();
      await h.sql(storage, "UPDATE sessions SET body_version = NULL WHERE id = ?", ["anchor-session"]);
      await h.sql(storage, "UPDATE facts SET source_start = NULL, source_end = NULL, source_body_version = NULL, source_quote_status = NULL WHERE id = ?", ["anchor-fact"]);
      expect((await fact())!.sourceAnchor).toEqual({ status: "missing" });
      expect(await version()).toBeNull();
      expect(await h.migrate(storage)).toEqual([]);
    });
    it("explicit bounded fact maintenance versions legacy sources atomically", async () => {
      await ingest();
      await h.sql(storage, "UPDATE sessions SET body_version = NULL WHERE id = ?", ["anchor-session"]);
      const facts = anchorFacts(anchorRecord().body!);
      await expect(h.maintain(storage, [...facts, ...facts])).rejects.toThrow();
      expect(await version()).toBeNull();
      await h.maintain(storage, facts);
      expect(await version()).toBe(bodyVersion(anchorRecord().body!));
      expect((await fact())!.sourceAnchor?.status).toBe("verified");
    });
    it("rolls back source body/version and facts together when a fact insert fails", async () => {
      await ingest();
      const before = await version();
      const facts = anchorFacts("replacement", "replacement");
      await expect(h.ingest(storage, anchorRecord("replacement"), [...facts, ...facts])).rejects.toThrow();
      expect(await version()).toBe(before);
      expect((await fact())!.sourceAnchor?.status).toBe("verified");
    });
    it("refuses to trust a source belonging to another tenant", async () => {
      await ingest();
      await h.sql(storage, "INSERT INTO teams(id, name) VALUES ('other', 'Other')");
      expect(await storage.facts.getById("other", "anchor-fact")).toBeNull();
      await h.sql(storage, "UPDATE sessions SET tenant_id = 'other' WHERE id = ?", ["anchor-session"]);
      expect((await fact())!.sourceAnchor).toEqual({ status: "stale" });
      await storage.facts.insert(tenant, anchorFacts(anchorRecord().body!, "absent quote", "foreign-negative")[0]!);
      expect((await storage.facts.getById(tenant, "foreign-negative"))!.sourceAnchor).toEqual({ status: "stale" });
      expect(await storage.facts.listForRecall(tenant, {})).toEqual([]);
    });
    it("roundtrips malformed surrogates and quotes through actual UTF-8 storage", async () => {
      const body = "x".repeat(199_999) + "\ud83d";
      await h.ingest(storage, anchorRecord(body), anchorFacts(body, "x\ud83d"));
      const s = await storage.sessions.getById(tenant, "anchor-session");
      const f = (await fact())!;
      expect(s!.body.endsWith("�")).toBe(true);
      expect(f.sourceQuote).toBe("x�");
      expect(f.sourceAnchor?.status).toBe("verified");
      if (f.sourceAnchor?.status === "verified") {
        expect(s!.body.slice(f.sourceAnchor.start, f.sourceAnchor.end)).toBe(f.sourceQuote);
        expect(f.sourceAnchor.bodyVersion).toBe(bodyVersion(s!.body));
      }
    });
  });
}
