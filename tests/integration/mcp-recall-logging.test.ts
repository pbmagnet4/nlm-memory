/**
 * The MCP recall handlers must write to the recall telemetry, the same way
 * the HTTP /api/recall path does. Without this, every agent recall via MCP
 * is invisible to query_log.jsonl / fact_query_log.jsonl and the Recall
 * page — which is the path that actually matters for adoption telemetry.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recallFactsHandler,
  recallSessionsHandler,
  type McpDeps,
} from "../../src/mcp/server.js";

// logQuery is fire-and-forget (void) in the handler — poll for the line.
async function waitForLine(path: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (existsSync(path)) {
      const txt = readFileSync(path, "utf8").trim();
      if (txt) return txt;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no log line written to ${path} within timeout`);
}

describe("MCP recall handlers write telemetry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-mcplog-"));
    process.env["NLM_QUERY_LOG"] = join(tmp, "query_log.jsonl");
    process.env["NLM_FACT_QUERY_LOG"] = join(tmp, "fact_query_log.jsonl");
  });

  afterEach(() => {
    delete process.env["NLM_QUERY_LOG"];
    delete process.env["NLM_FACT_QUERY_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("recall_sessions logs an mcp-source query", async () => {
    const deps = {
      recall: {
        search: async () => ({
          query: "pgvector",
          entity: null,
          kind: null,
          mode: "keyword",
          limit: 10,
          total: 2,
          results: [{ id: "s1" }, { id: "s2" }],
        }),
      },
    } as unknown as McpDeps;

    await recallSessionsHandler(deps, { query: "pgvector", mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_QUERY_LOG"] as string));
    expect(entry.source).toBe("mcp");
    expect(entry.query).toBe("pgvector");
    expect(entry.n_results).toBe(2);
    expect(entry.returned_ids).toEqual(["s1", "s2"]);
    // No runtime passed -> null (backwards compatible with existing callers).
    expect(entry.runtime).toBeNull();
  });

  it("recall_sessions records the caller runtime when attributed", async () => {
    const deps = {
      recall: {
        search: async () => ({
          query: "pgvector",
          entity: null,
          kind: null,
          mode: "keyword",
          limit: 10,
          total: 1,
          results: [{ id: "s1" }],
        }),
      },
    } as unknown as McpDeps;

    await recallSessionsHandler(deps, { query: "pgvector", mode: "keyword", limit: 10 }, "claude-code");

    const entry = JSON.parse(await waitForLine(process.env["NLM_QUERY_LOG"] as string));
    expect(entry.source).toBe("mcp");
    expect(entry.runtime).toBe("claude-code");
  });

  it("recall_facts logs an mcp-source query", async () => {
    const deps = {
      factRecall: {
        search: async () => ({
          query: "routing",
          total: 1,
          results: [{ id: "fact_x" }],
        }),
      },
    } as unknown as McpDeps;

    await recallFactsHandler(deps, { query: "routing", mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_FACT_QUERY_LOG"] as string));
    expect(entry.source).toBe("mcp");
    expect(entry.query).toBe("routing");
    expect(entry.n_results).toBe(1);
    expect(entry.returned_ids).toEqual(["fact_x"]);
    // No runtime passed -> null (backwards compatible).
    expect(entry.runtime).toBeNull();
  });

  it("recall_facts records the caller runtime when attributed", async () => {
    const deps = {
      factRecall: {
        search: async () => ({ query: "routing", total: 1, results: [{ id: "fact_x" }] }),
      },
    } as unknown as McpDeps;

    await recallFactsHandler(deps, { query: "routing", mode: "keyword", limit: 10 }, "claude-code");

    const entry = JSON.parse(await waitForLine(process.env["NLM_FACT_QUERY_LOG"] as string));
    expect(entry.source).toBe("mcp");
    expect(entry.runtime).toBe("claude-code");
  });
});

describe("MCP recall handlers log resolved conversation_id", () => {
  let tmp: string;
  let projectsDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-convid-"));
    projectsDir = join(tmp, "projects");
    mkdirSync(projectsDir, { recursive: true });
    process.env["NLM_QUERY_LOG"] = join(tmp, "query_log.jsonl");
    process.env["NLM_FACT_QUERY_LOG"] = join(tmp, "fact_query_log.jsonl");
    process.env["NLM_CLAUDE_PROJECTS_ROOT"] = projectsDir;
  });

  afterEach(() => {
    delete process.env["NLM_QUERY_LOG"];
    delete process.env["NLM_FACT_QUERY_LOG"];
    delete process.env["NLM_CLAUDE_PROJECTS_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("recall_sessions logs conversation_id when query resolves to a transcript", async () => {
    const query = "pgvector FTS5 performance index";
    const projDir = join(projectsDir, "proj-a");
    mkdirSync(projDir);
    writeFileSync(
      join(projDir, "conv-target.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "recall_sessions", input: { query } }] } }) + "\n",
    );

    const deps = {
      recall: {
        search: async () => ({ query, entity: null, kind: null, mode: "keyword", limit: 10, total: 1, results: [{ id: "s1" }] }),
      },
    } as unknown as McpDeps;

    await recallSessionsHandler(deps, { query, mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_QUERY_LOG"] as string));
    expect(entry.conversation_id).toBe("conv-target");
  });

  it("recall_sessions omits conversation_id when query does not match any transcript", async () => {
    const deps = {
      recall: {
        search: async () => ({ query: "hono middleware routing", entity: null, kind: null, mode: "keyword", limit: 10, total: 0, results: [] }),
      },
    } as unknown as McpDeps;

    await recallSessionsHandler(deps, { query: "hono middleware routing", mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_QUERY_LOG"] as string));
    expect(entry.conversation_id).toBeUndefined();
  });

  it("recall_facts logs conversation_id when query resolves to a transcript", async () => {
    const query = "qdrant collection embedding dimension";
    const projDir = join(projectsDir, "proj-b");
    mkdirSync(projDir);
    writeFileSync(
      join(projDir, "conv-facts.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "recall_facts", input: { query } }] } }) + "\n",
    );

    const deps = {
      factRecall: {
        search: async () => ({ query, total: 1, results: [{ id: "fact_1" }] }),
      },
    } as unknown as McpDeps;

    await recallFactsHandler(deps, { query, mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_FACT_QUERY_LOG"] as string));
    expect(entry.conversation_id).toBe("conv-facts");
  });

  it("recall_facts omits conversation_id when query does not match any transcript", async () => {
    const deps = {
      factRecall: {
        search: async () => ({ query: "duckdb schema table", total: 0, results: [] }),
      },
    } as unknown as McpDeps;

    await recallFactsHandler(deps, { query: "duckdb schema table", mode: "keyword", limit: 10 });

    const entry = JSON.parse(await waitForLine(process.env["NLM_FACT_QUERY_LOG"] as string));
    expect(entry.conversation_id).toBeUndefined();
  });

  it("fact log line includes conversation_id field when resolved", async () => {
    const query = "lm studio inference endpoint port number";
    const projDir = join(projectsDir, "proj-c");
    mkdirSync(projDir);
    writeFileSync(join(projDir, "conv-lm.jsonl"), `{"query":"${query}"}\n`);

    const deps = {
      factRecall: {
        search: async () => ({ query, total: 1, results: [{ id: "fact_2" }] }),
      },
    } as unknown as McpDeps;

    await recallFactsHandler(deps, { query, mode: "hybrid", limit: 5 });

    const raw = await waitForLine(process.env["NLM_FACT_QUERY_LOG"] as string);
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof entry["conversation_id"]).toBe("string");
    expect(entry["source"]).toBe("mcp");
    expect(entry["n_results"]).toBe(1);
    expect(entry["returned_ids"]).toEqual(["fact_2"]);
  });
});
