/**
 * The MCP recall handlers must write to the recall telemetry, the same way
 * the HTTP /api/recall path does. Without this, every agent recall via MCP
 * is invisible to query_log.jsonl / fact_query_log.jsonl and the Recall
 * page — which is the path that actually matters for adoption telemetry.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  });
});
