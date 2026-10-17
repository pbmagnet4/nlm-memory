import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { getFactHistoryHandler, getSessionHandler, recallContextHandler, recallSessionsHandler } from "../../src/mcp/server.js";
import { makeSession } from "../fixtures/sessions.js";
import { makeFact } from "../fixtures/facts.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import { boundedFormat } from "../../src/mcp/response-budget.js";

const migrationsDir = resolve(__dirname, "../../migrations");
const tenant = "team_local";

describe("bounded structured memory context", () => {
  let dir: string;
  let storage: SqliteStorage;
  let deps: Parameters<typeof recallContextHandler>[0];
  const rationale = "Chose SQLite because a single writer keeps local operation simple.";
  const body = "irrelevant setup\n".repeat(3_000) + rationale + "\nclosing details\n".repeat(1_000);
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-context-"));
    storage = await SqliteStorage.create({ dbPath: join(dir, "test.sqlite"), migrationsDir });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "source", label: "SQLite choice",
      summary: "Selected SQLite for local storage.", body, decisions: [rationale] }), tenant);
    const llm = new FixedEmbedder();
    deps = { store: storage.sessions, factStore: storage.facts,
      recall: new RecallService({ store: storage.sessions, llm }),
      factRecall: new FactRecallService({ factStore: storage.facts, llm }) };
  });
  afterEach(async () => { vi.unstubAllEnvs(); await storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("scopes both evidence lanes, expansion arguments, and history against current bindings", async () => {
    await storage.workstreams.create(tenant, { id: "ws_scope", label: "SQLite project", scope: null });
    await storage.workstreams.create(tenant, { id: "ws_other", label: "Other project", scope: null });
    await storage.workstreams.create("team_foreign", { id: "ws_foreign", label: "Foreign project", scope: null });
    await storage.sessions.setWorkstreamBinding(tenant, "source", "ws_scope", "operator", 1);
    storage.sessions.insertSessionForTest(makeSession({ id: "noise", label: "SQLite noise", body: "SQLite OTHER SECRET" }), tenant);
    await storage.sessions.setWorkstreamBinding(tenant, "noise", "ws_other", "operator", 1);
    await storage.facts.insertMany(tenant, [
      makeFact({ id: "wanted", sourceSessionId: "source", subject: "store", predicate: "framework", value: "SQLite", sourceQuote: rationale }),
      makeFact({ id: "outside", sourceSessionId: "noise", subject: "store", predicate: "framework", value: "OTHER SECRET", sourceQuote: "SQLite OTHER SECRET" }),
    ]);
    const wired = { ...deps, workstreams: { store: storage.workstreams, sessions: storage.sessions,
      facts: storage.facts, exemplars: storage.exemplars } };
    const result = await recallContextHandler(wired, tenant, { query: "SQLite", mode: "keyword", workstream: "SQLite project" });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.scope).toEqual({ status: "resolved", workstreamIds: ["ws_scope"], workstream: "SQLite project" });
    expect(payload.facts.map((f: { id: string }) => f.id)).toEqual(["wanted"]);
    expect(payload.sessions.map((f: { id: string }) => f.id)).toEqual(["source"]);
    expect(result.content[0]!.text).not.toContain("OTHER SECRET");
    for (const expansion of [...payload.expand, ...payload.facts.map((f: { expand: object }) => f.expand), ...payload.sessions.map((s: { expand: object }) => s.expand)]) {
      expect(expansion.workstream).toBe("SQLite project");
    }
    const historyInput = { subject: "store", predicate: "framework", workstream: "SQLite project" };
    const history = JSON.parse((await getFactHistoryHandler(wired, tenant, historyInput)).content[0]!.text);
    expect(history.chains.flatMap((c: { history: { id: string }[] }) => c.history.map((f) => f.id))).toEqual(["wanted"]);
    const context = JSON.parse((await getSessionHandler(wired, tenant, { id: "source", workstream: "SQLite project" })).content[0]!.text);
    expect(context.expand.workstream).toBe("SQLite project");
    const page = JSON.parse((await getSessionHandler(wired, tenant, { ...context.expand, maxChars: 2_000 })).content[0]!.text);
    expect(page.next.workstream).toBe("SQLite project");
    await storage.sessions.setWorkstreamBinding(tenant, "source", "ws_other", "operator", 1);
    for (const expansion of [context.expand, page.next]) {
      const blocked = await getSessionHandler(wired, tenant, expansion);
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0]!.text).not.toContain(rationale);
    }
    expect(JSON.parse((await getFactHistoryHandler(wired, tenant, historyInput)).content[0]!.text).chains).toEqual([]);
    for (const workstream of ["unknown", "ws_foreign"]) {
      const empty = JSON.parse((await recallContextHandler(wired, tenant, { query: "SQLite", mode: "keyword", workstream })).content[0]!.text);
      expect(empty.scope.status).toBe("not_found");
      expect(empty.facts).toEqual([]); expect(empty.sessions).toEqual([]);
    }
    const noResolver = JSON.parse((await recallContextHandler(deps, tenant, { query: "SQLite", mode: "keyword", workstream: "SQLite project" })).content[0]!.text);
    expect(noResolver.scope.status).toBe("not_found");
    expect(noResolver.facts).toEqual([]); expect(noResolver.sessions).toEqual([]);
  });

  it("retrieves an old fact beyond the newest 500 without an embedder call", async () => {
    await storage.facts.insertMany(tenant, [makeFact({ id: "gold", sourceSessionId: "source",
      subject: "store", predicate: "framework", value: "SQLite", createdAt: "2020-01-01T00:00:00Z" }),
      ...Array.from({ length: 600 }, (_, i) => makeFact({ id: `noise_${i}`, sourceSessionId: "source",
        subject: `noise-${i}`, value: "unrelated", createdAt: "2026-10-16T00:00:00Z" }))]);
    const result = await deps.factRecall!.search(tenant, { query: "SQLite", mode: "keyword" });
    expect(result.results[0]?.id).toBe("gold");
    await storage.facts.insert(tenant, makeFact({ id: "gold_copy", sourceSessionId: "source",
      subject: "store", predicate: "framework", value: "SQLite" }));
    const sessionSearch = vi.spyOn(deps.recall, "search");
    vi.stubEnv("NLM_QUERY_LOG", join(dir, "session-queries.jsonl"));
    vi.stubEnv("NLM_FACT_QUERY_LOG", join(dir, "fact-queries.jsonl"));
    const exact = await recallContextHandler(deps, tenant, { query: "which framework", subject: "store", predicate: "framework" });
    const payload = JSON.parse(exact.content[0]!.text);
    expect(exact.isError).toBeUndefined();
    expect(payload.facts[0].value).toBe("SQLite");
    expect(payload.sessions).toEqual([]);
    expect(sessionSearch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(existsSync(join(dir, "fact-queries.jsonl"))).toBe(true));
    expect(JSON.parse(readFileSync(join(dir, "fact-queries.jsonl"), "utf8")).returned_ids).toEqual(["gold_copy"]);
    expect(existsSync(join(dir, "session-queries.jsonl"))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("proves ambiguity across the complete eligible corpus and surfaces the hidden alternative", async () => {
    await storage.facts.insertMany(tenant, [makeFact({ id: "old_b", sourceSessionId: "source", subject: "store", predicate: "framework", value: "B", createdAt: "2020-01-01T00:00:00Z" }),
      ...Array.from({ length: 601 }, (_, i) => makeFact({ id: `duplicate_${i}`, sourceSessionId: "source", subject: "store", predicate: "framework", value: "A" }))]);
    const search = vi.spyOn(deps.recall, "search");
    const result = await recallContextHandler(deps, tenant, { query: "store framework", subject: "store", predicate: "framework" });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.lookup).toEqual({ distinctValueCount: 2, complete: true, sourceSessionCount: 1,
      omittedAlternatives: 0, expand: { subject: "store", predicate: "framework" } });
    expect(payload.facts.map((f: { value: string }) => f.value).sort()).toEqual(["A", "B"]);
    expect(payload.facts.every((f: { multipleValues: boolean; multipleValuesScope: string }) => f.multipleValues && f.multipleValuesScope === "corpus")).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });

  it("cannot infer uniqueness when the complete probe is interrupted", async () => {
    await storage.facts.insert(tenant, makeFact({ id: "only", sourceSessionId: "source", subject: "store", predicate: "framework", value: "A" }));
    vi.spyOn(storage.facts, "summarizeCurrentValues").mockRejectedValue(new Error("statement timeout"));
    const search = vi.spyOn(deps.recall, "search");
    const result = await recallContextHandler(deps, tenant, { query: "store framework", subject: "store", predicate: "framework" });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.lookup.distinctValueCount).toBeNull();
    expect(payload.lookup.complete).toBe(false);
    expect(payload.facts[0].multipleValuesScope).toBe("candidates");
    expect(search).toHaveBeenCalledOnce();
  });

  it("uses the fact lane confidence floor for uniqueness", async () => {
    await storage.facts.insertMany(tenant, [makeFact({ id: "high", sourceSessionId: "source", subject: "store", predicate: "framework", value: "A" }),
      makeFact({ id: "low", sourceSessionId: "source", subject: "store", predicate: "framework", value: "B", confidence: 0.59 })]);
    const search = vi.spyOn(deps.recall, "search");
    const payload = JSON.parse((await recallContextHandler(deps, tenant, { query: "store framework", subject: "store", predicate: "framework" })).content[0]!.text);
    expect(payload.lookup.complete).toBe(true); expect(payload.lookup.distinctValueCount).toBe(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("reports omitted alternatives and scoped history without truncating oversized facts", async () => {
    await storage.workstreams.create(tenant, { id: "ws_large", label: "Large values", scope: null });
    await storage.sessions.setWorkstreamBinding(tenant, "source", "ws_large", "operator", 1);
    await storage.facts.insertMany(tenant, ["A", "B", "C"].map((value) => makeFact({ id: `large_${value}`, sourceSessionId: "source",
      subject: "store", predicate: "framework", value: value.repeat(4_000), sourceQuote: rationale })));
    const wired = { ...deps, workstreams: { store: storage.workstreams, sessions: storage.sessions, facts: storage.facts, exemplars: storage.exemplars } };
    const result = await recallContextHandler(wired, tenant, { query: "store framework", subject: "store", predicate: "framework", workstream: "Large values", maxChars: 2_000 });
    const payload = JSON.parse(result.content[0]!.text);
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(2_000);
    expect(payload.facts).toEqual([]);
    expect(payload.lookup).toEqual({ distinctValueCount: 3, sourceSessionCount: 1, complete: true, omittedAlternatives: 3,
      expand: { subject: "store", predicate: "framework", workstream: "Large values" } });
    expect(payload.truncated).toBeUndefined();
  });

  it("labels general search multiplicity as a candidate observation and keeps exact tuple groups separate", async () => {
    await storage.facts.insertMany(tenant, [
      makeFact({ id: "tuple_a", sourceSessionId: "source", subject: "a b", predicate: "c", value: "A" }),
      makeFact({ id: "tuple_b", sourceSessionId: "source", subject: "a", predicate: "b c", value: "B" }),
    ]);
    const payload = JSON.parse((await recallContextHandler(deps, tenant, { query: "a b c", intent: "history", mode: "keyword" })).content[0]!.text);
    expect(payload.lookup).toBeUndefined(); expect(payload.facts).toHaveLength(2);
    expect(payload.facts.every((f: { multipleValues: boolean; multipleValuesScope: string }) => !f.multipleValues && f.multipleValuesScope === "candidates")).toBe(true);
  });

  it("returns mid-transcript rationale as exact source evidence within budget", async () => {
    const result = await recallContextHandler(deps, tenant, { query: "why SQLite single writer", mode: "keyword" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(8_000);
    const payload = JSON.parse(text);
    expect(payload.intent).toBe("decision");
    expect(payload.sessions[0].decisions).toContain(rationale);
    const passages = payload.sessions[0].passages;
    expect(passages.some((p: { text: string }) => p.text.includes(rationale))).toBe(true);
    for (const p of passages) expect(p.text).toBe(body.slice(p.offset, p.end));
  });

  it("preserves semantic-only evidence when the question uses different words", async () => {
    const vector = new Float32Array(768); vector[0] = 1;
    storage.sessions.insertChunkEmbeddingForTest("source", 10, vector);
    const llm = new FixedEmbedder(vector);
    const recall = new RecallService({ store: storage.sessions, llm });
    const hits = await recall.search(tenant, { query: "database durability", mode: "semantic" });
    expect(hits.results[0]?.chunkIndex).toBe(10);
    const response = await recallContextHandler({ ...deps, recall }, tenant, { query: "database durability", mode: "semantic" });
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0]!.text);
    expect(result.sessions[0].passages.some((p: { text: string }) => p.text.includes(rationale))).toBe(true);
    expect(response.content[0]!.text.length).toBeLessThanOrEqual(8_000);
  });

  it("keeps conflicting active values visible and does not run generative rewriting", async () => {
    await storage.facts.insertMany(tenant, ["SQLite", "Postgres"].map((value) => makeFact({
      id: `fact_${value}`, sourceSessionId: "source", subject: "store", predicate: "framework", value,
    })));
    const search = vi.spyOn(deps.recall, "search");
    const result = await recallContextHandler(deps, tenant, { query: "store framework", subject: "store", predicate: "framework", mode: "keyword" });
    expect(JSON.parse(result.content[0]!.text).facts.map((f: { value: string }) => f.value).sort()).toEqual(["Postgres", "SQLite"]);
    expect(search.mock.calls[0]?.[1].rewrite).toBe(false);
  });

  it("returns useful context for oversized sessions and losslessly pages original text", async () => {
    const result = await getSessionHandler(deps, tenant, { id: "source", query: "SQLite single writer" });
    const context = JSON.parse(result.content[0]!.text);
    expect(context.decisions).toContain(rationale);
    expect(context.passages[0].text).toContain(rationale);
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(8_000);
    let offset = 0;
    let recovered = "";
    for (;;) {
      const page = await getSessionHandler(deps, tenant, { id: "source", view: "transcript", offset });
      const p = JSON.parse(page.content[0]!.text);
      recovered += p.body;
      if (!p.next) break;
      expect(p.next.offset).toBeGreaterThan(offset);
      offset = p.next.offset;
    }
    expect(recovered).toBe(body);
  });

  it("fits escaped Unicode transcript pages and rejects a changed source version", async () => {
    const original = ('"\\\n😀' + "details ").repeat(2_000);
    storage.sessions.insertSessionForTest(makeSession({ id: "unicode", body: original }));
    let next: Parameters<typeof getSessionHandler>[2] | null = { id: "unicode", view: "transcript", maxChars: 2_000 };
    let recovered = "";
    let version: string | undefined;
    while (next) {
      const response = await getSessionHandler(deps, tenant, next);
      expect(response.isError).toBeUndefined();
      expect(response.content[0]!.text.length).toBeLessThanOrEqual(2_000);
      const page = JSON.parse(response.content[0]!.text);
      recovered += page.body;
      version = page.version;
      next = page.next;
    }
    expect(recovered).toBe(original);
    storage.rawDb().prepare("UPDATE sessions SET body = ? WHERE id = ?").run(original + "changed", "unicode");
    expect((await getSessionHandler(deps, tenant, { id: "unicode", view: "transcript", version })).isError).toBe(true);
  });

  it("retrieves short identifiers without spending the match cap on substrings", async () => {
    const text = "build instructions\n".repeat(100) + "The UI uses keyboard navigation.";
    storage.sessions.insertSessionForTest(makeSession({ id: "short-id", body: text }));
    const response = await getSessionHandler(deps, tenant, { id: "short-id", query: "UI" });
    expect(JSON.parse(response.content[0]!.text).passages[0].text).toContain("The UI uses keyboard navigation.");
  });

  it("keeps a tight context budget useful and rejects unbounded requests", async () => {
    const response = await recallContextHandler(deps, tenant, { query: "why SQLite", mode: "keyword", maxChars: 2_000 });
    expect(response.isError).toBeUndefined();
    expect(response.content[0]!.text.length).toBeLessThanOrEqual(2_000);
    const context = JSON.parse(response.content[0]!.text);
    expect(context.sessions.length + context.expand.length).toBeGreaterThan(0);
    expect((await recallContextHandler(deps, tenant, { query: "SQLite", maxChars: 200_000 })).isError).toBe(true);
  });

  it("enforces tenant boundaries and validates expansion offsets", async () => {
    const result = await getSessionHandler(deps, "team_other", { id: "source" });
    expect(result.isError).toBe(true);
    const context = await recallContextHandler(deps, "team_other", { query: "SQLite", mode: "keyword" });
    expect(JSON.parse(context.content[0]!.text).sessions).toEqual([]);
    expect((await getSessionHandler(deps, tenant, { id: "source", offset: -1 })).isError).toBe(true);
  });

  it("never replaces oversized search results with an empty error notice", async () => {
    const data = { results: [{ id: "source", summary: "x".repeat(40_000), decisions: [rationale] }] };
    const result = JSON.parse(boundedFormat(data, JSON.stringify));
    expect(result.results[0].id).toBe("source");
    expect(result.results[0].decisions).toContain(rationale);
    expect(result.truncated).toBe(true);
    const recalled = await recallSessionsHandler(deps, tenant, { query: "SQLite", mode: "keyword" });
    expect(recalled.isError).toBeUndefined();
  });
});
