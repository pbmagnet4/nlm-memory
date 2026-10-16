import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { getSessionHandler, recallContextHandler, recallSessionsHandler } from "../../src/mcp/server.js";
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
  afterEach(async () => { await storage.close(); rmSync(dir, { recursive: true, force: true }); });

  it("retrieves an old fact beyond the newest 500 without an embedder call", async () => {
    await storage.facts.insertMany(tenant, [makeFact({ id: "gold", sourceSessionId: "source",
      subject: "store", predicate: "framework", value: "SQLite", createdAt: "2020-01-01T00:00:00Z" }),
      ...Array.from({ length: 600 }, (_, i) => makeFact({ id: `noise_${i}`, sourceSessionId: "source",
        subject: `noise-${i}`, value: "unrelated", createdAt: "2026-10-16T00:00:00Z" }))]);
    const result = await deps.factRecall!.search(tenant, { query: "SQLite", mode: "keyword" });
    expect(result.results[0]?.id).toBe("gold");
    const exact = await recallContextHandler(deps, tenant, { query: "which framework", subject: "store", predicate: "framework" });
    const payload = JSON.parse(exact.content[0]!.text);
    expect(exact.isError).toBeUndefined();
    expect(payload.facts[0].value).toBe("SQLite");
    expect(payload.sessions).toEqual([]);
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
