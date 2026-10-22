import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallSessionsHandler, type McpDeps } from "../../src/mcp/server.js";
import type { RecallHit, RecallResult } from "../../src/shared/types.js";

function hit(id: string): RecallHit {
  return { id, label: "Storage decision", startedAt: "2026-10-21T00:00:00Z", status: "closed",
    summary: "setup ".repeat(8_000), entities: Array.from({ length: 100 }, (_, i) => `entity-${i}`),
    decisions: [...Array.from({ length: 40 }, (_, i) => `unrelated choice ${i}`), "Use SQLite for single-writer storage"],
    open: ["SQLite cutover?", "Other question?"], matchScore: 1, matchedIn: ["decisions"], supersededBy: null };
}

const parse = (response: Awaited<ReturnType<typeof recallSessionsHandler>>) => {
  expect(response.isError).toBeUndefined();
  const text = response.content[0]!.text;
  return (process.env.NLM_FORMAT === "toon" ? decode(text) : JSON.parse(text)) as {
    results: (RecallHit & { omitted: { entities: number; decisions: number; shortenedText: boolean }; expand: { id: string; workstream?: string; query?: string } })[];
    nextCursor: string | null; has_more: boolean; total: number; omittedResults: number; availableResults: number;
  };
};

describe("compact MCP session recall", () => {
  let dir: string;
  let candidates: RecallHit[];
  let deps: McpDeps;
  const input = { query: "SQLite", rewrite: false, maxChars: 2_000, limit: 5, candidateLimit: 100 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-budget-"));
    vi.stubEnv("NLM_QUERY_LOG", join(dir, "queries.jsonl"));
    vi.stubEnv("NLM_FORMAT", "json");
    candidates = Array.from({ length: 13 }, (_, i) => hit(`s-${i}`));
    deps = { recall: { search: vi.fn(async () => ({ query: input.query, entity: null, kind: null,
      mode: "keyword", limit: 100, total: candidates.length, results: candidates } as RecallResult)) } } as unknown as McpDeps;
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
  });

  it.each(["json", "toon"])("keeps evidence and pages every candidate within the %s budget", async (format) => {
    vi.stubEnv("NLM_FORMAT", format);
    candidates[0] = { ...candidates[0]!, status: "superseded", supersededBy: "successor" };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await recallSessionsHandler(deps, "team_local", { ...input, ...(cursor ? { cursor } : {}) });
      expect(response.content[0]!.text.length).toBeLessThanOrEqual(input.maxChars);
      const page = parse(response);
      expect(page.results.length).toBeGreaterThan(0);
      if (!cursor) {
        expect(page.results[0]!.supersededBy).toBe("successor");
        expect(page.results[0]!.decisions[0]).toContain("SQLite");
        expect(page.results[0]!.omitted).toMatchObject({ entities: 100, decisions: 39, shortenedText: true });
        expect(page.results[0]!.expand).toEqual({ id: "s-0", query: "SQLite" });
      }
      seen.push(...page.results.map((r) => r.id));
      expect(page.omittedResults).toBe(candidates.length - seen.length);
      expect(page.has_more).toBe(page.nextCursor !== null);
      cursor = page.nextCursor ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(candidates.length);
    } while (cursor);
    expect(seen).toEqual(candidates.map((r) => r.id));
  });

  it("defaults to five hits and 8000 characters without changing candidate order", async () => {
    const result = await recallSessionsHandler(deps, "team_local", { query: "SQLite", rewrite: false });
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(8_000);
    expect(parse(result).results.map((r) => r.id)).toEqual(candidates.slice(0, 5).map((r) => r.id));
    expect(deps.recall.search).toHaveBeenCalledWith("team_local", expect.objectContaining({ limit: 10, includeSuperseded: true }));
  });

  it("rejects malformed, cross-query and cross-tenant cursors", async () => {
    const cursor = parse(await recallSessionsHandler(deps, "team_local", input)).nextCursor!;
    for (const [tenant, args] of [
      ["team_local", { ...input, cursor: "bad" }],
      ["team_other", { ...input, cursor }],
      ["team_local", { ...input, cursor, query: "Postgres" }],
      ["team_local", { ...input, cursor, workstream: "other" }],
      ["team_local", { ...input, cursor, candidateLimit: 50 }],
    ] as const) {
      expect((await recallSessionsHandler(deps, tenant, args)).isError).toBe(true);
    }
  });

  it("requires a restart when ranked candidates change", async () => {
    const cursor = parse(await recallSessionsHandler(deps, "team_local", input)).nextCursor!;
    candidates.reverse();
    const response = await recallSessionsHandler(deps, "team_local", { ...input, cursor });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("results changed");
  });

  it("keeps workstream scope on source expansions and permits page-size changes", async () => {
    const args = { ...input, workstream: "ws-storage" };
    const first = parse(await recallSessionsHandler(deps, "team_local", args));
    expect(first.results[0]!.expand.workstream).toBe("ws-storage");
    const second = parse(await recallSessionsHandler(deps, "team_local", {
      ...args, cursor: first.nextCursor!, limit: 1, maxChars: 8_000,
    }));
    expect(second.results[0]!.id).toBe(candidates[first.results.length]!.id);
  });

  it("returns an empty complete page for no matches", async () => {
    candidates = [];
    expect(parse(await recallSessionsHandler(deps, "team_local", input))).toMatchObject({ results: [], has_more: false, nextCursor: null });
  });

  it("keeps a fetchable first hit when escaped text exceeds the smallest budget", async () => {
    candidates = [{ ...hit("escaped"), summary: "\\".repeat(10_000),
      decisions: ["\\".repeat(1_000), "\\".repeat(1_000)], open: ["\\".repeat(1_000)] }];
    const result = await recallSessionsHandler(deps, "team_local", { ...input, query: "x".repeat(2_000) });
    const payload = parse(result);
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(2_000);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.expand).toEqual({ id: "escaped" });
    expect(payload.results[0]!.omitted.decisions).toBe(2);
  });

  it("preserves explicit semantic-lane degradation and outside-window counts", async () => {
    deps = { recall: { search: async () => ({ mode: "semantic", entity: null, kind: null,
      total: 20, results: [hit("only")], modeUnavailable: "ollama_unreachable" }) } } as unknown as McpDeps;
    const result = await recallSessionsHandler(deps, "team_local", { query: "SQLite", mode: "semantic", rewrite: false });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ modeUnavailable: "ollama_unreachable",
      availableResults: 1, outsideWindow: 19, has_more: false, nextCursor: null });
  });

  it("validates budgets and limits at the handler boundary", async () => {
    for (const args of [{ maxChars: 100 }, { limit: -1 }, { limit: 101 }, { query: "x".repeat(2_001) }]) {
      expect((await recallSessionsHandler(deps, "team_local", args)).isError).toBe(true);
    }
  });
});
