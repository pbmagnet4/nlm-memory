import { recallContext } from "../../src/core/context/recall-context.js";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { createApp } from "../../src/http/app.js";
import { recallFactsHandler, recallContextHandler, getFactHistoryHandler, type McpDeps } from "../../src/mcp/server.js";
import { sessionRecallInput, readRecallCursor } from "../../src/mcp/session-recall-page.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";
import { anchorRecord } from "../contract/source-anchor.contract.js";
import { locateSourceAnchor } from "../../src/core/facts/source-anchor.js";

describe("property recall surfaces", () => {
  let tmp: string; let storage: SqliteStorage; let deps: McpDeps;
  beforeEach(async () => {
    vi.stubEnv("NLM_PROPERTY_ASSOCIATIONS", "1"); vi.stubEnv("NLM_FORMAT", "json");
    tmp = mkdtempSync(join(tmpdir(), "nlm-property-surfaces-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "db.sqlite"), migrationsDir: resolve("migrations") });
    await storage.properties.import("team_local", [{ slug: "nxtseo", label: "NxtSEO" }, { slug: "nxtads", label: "NxtAds" }]);
    await storage.sessions.insertSession("team_local", anchorRecord("API project discussion", "s1"), null, null, { factStore: storage.facts, facts: [
      ...["nxtseo", "nxtads"].map((slug) => ({ id: slug, kind: "attribute" as const, subject: "api", predicate: "port", value: slug === "nxtseo" ? "3940" : "8000", sourceSessionId: "s1", sourceQuote: null,
        createdAt: "2026-01-01T00:00:00Z", supersededBy: null, confidence: 1, property: { slug, source: "explicit" as const, evidence: "task" } })),
    ] });
    const llm = new FixedEmbedder();
    deps = { store: storage.sessions, factStore: storage.facts, properties: storage.properties,
      recall: new RecallService({ store: storage.sessions, llm, properties: storage.properties }),
      factRecall: new FactRecallService({ factStore: storage.facts, llm, properties: storage.properties }) };
  });
  afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const value = (result: Awaited<ReturnType<typeof recallFactsHandler>>) => JSON.parse((result.content[0] as { text: string }).text);
  it("carries explicit filters through MCP facts, context and history", async () => {
    expect(value(await recallFactsHandler(deps, "team_local", { subject: "api", property: "nxtseo", mode: "keyword" })).results.map((f: { id: string }) => f.id)).toEqual(["nxtseo"]);
    const context = value(await recallContextHandler(deps, "team_local", { query: "api port", subject: "api", predicate: "port", property: "nxtads", mode: "keyword" }));
    expect(context.facts.map((f: { id: string }) => f.id)).toEqual(["nxtads"]);
    expect(context.scope.property).toBe("nxtads");
    expect(value(await getFactHistoryHandler(deps, "team_local", { subject: "api", property: "nxtseo" })).chains).toHaveLength(1);
    expect((await recallFactsHandler(deps, "team_local", { subject: "api", property: "missing" })).isError).toBe(true);
  });
  it("labels inferred associations with their source in MCP and HTTP output", async () => {
    vi.stubEnv("NLM_PROPERTY_INFERENCE", "1"); vi.stubEnv("NLM_SESSION_PROPERTY_INFERENCE", "1");
    const body = "[user] NxtSEO keeps a draft queue.";
    const quote = "NxtSEO keeps a draft queue";
    await storage.sessions.insertSession("team_local", { ...anchorRecord(body, "s2"), entities: ["NxtSEO"] }, null, null, { factStore: storage.facts, facts: [
      { id: "inferred", kind: "attribute", subject: "queue", predicate: "kind", value: "draft", sourceSessionId: "s2", sourceQuote: quote, sourceAnchor: locateSourceAnchor(body, quote),
        createdAt: "2026-01-01T00:00:00Z", supersededBy: null, confidence: 1 },
    ] });
    const mcp = value(await recallFactsHandler(deps, "team_local", { subject: "queue", property: "nxtseo", mode: "keyword" })).results;
    expect(mcp.map((f: { id: string; property?: { source: string } }) => [f.id, f.property?.source])).toEqual([["inferred", "source-quote"]]);
    const explicit = value(await recallFactsHandler(deps, "team_local", { subject: "api", property: "nxtseo", mode: "keyword" })).results;
    expect(explicit.map((f: { property?: { source: string } }) => f.property?.source)).toEqual(["explicit"]);
    const response = await createApp(deps).request("/api/recall/facts?subject=queue&property=nxtseo", { headers: { host: "localhost" } });
    expect(((await response.json()) as { results: { id: string; property?: { source: string } }[] }).results.map((f) => [f.id, f.property?.source])).toEqual([["inferred", "source-quote"]]);
    expect((await storage.sessions.keywordSearch("team_local", "draft", 5, { property: "nxtseo" })).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(await storage.sessions.keywordSearch("team_local", "draft", 5, { property: "nxtads" })).toEqual([]);
  });
  it("validates HTTP selectors without broadening an unknown property", async () => {
    const app = createApp(deps);
    const response = await app.request("/api/recall/facts?subject=api&property=nxtseo", { headers: { host: "localhost" } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { results: { id: string }[] }).results.map((f: { id: string }) => f.id)).toEqual(["nxtseo"]);
    const unknown = await app.request("/api/recall/facts?subject=api&property=missing", { headers: { host: "localhost" } });
    expect(unknown.status).toBe(400);
  });
  it("bounds property validation by the context request deadline", async () => {
    await expect(recallContext("team_local", { query: "api", property: "nxtseo", timeoutMs: 20 }, {
      ...deps, properties: { list: () => new Promise(() => {}) },
    })).rejects.toThrow("recall cancelled");
  });
  it("binds recall cursors to their property selector", () => {
    const args = sessionRecallInput.parse({ query: "api", property: "nxtseo" });
    const cursor = Buffer.from(JSON.stringify({ offset: 1, request: readRecallCursor(args, "team_local").request, ranking: "0123456789abcdef" })).toString("base64url");
    expect(() => readRecallCursor({ ...args, property: "nxtads", cursor }, "team_local")).toThrow("does not match");
  });
});
