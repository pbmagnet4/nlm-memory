/**
 * Regression guard for the code-exemplar lane's recall_code MCP tool.
 *
 * v0.13.1 fixed recall_code silently missing on the token-gated POST /mcp
 * transport: the start-action mcpDeps omitted exemplarStore/codeEmbedder/
 * installScope, so createMcpServer never registered the tool there even
 * though the stdio `nlm mcp` path did. The POST /mcp route is a thin
 * `createMcpServer(mcpDeps)` forward, so the registration gate exercised
 * here is exactly what that transport depends on.
 *
 * Tools are listed through a real in-memory MCP client rather than by
 * introspecting the server, so this asserts the tool is actually reachable
 * over the protocol.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpDeps } from "../../src/mcp/server.js";
import type { CodeExemplarStore } from "../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../src/ports/code-embedder.js";

function fakeExemplarStore(): CodeExemplarStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async insertMany() { return 0; },
    async upsertEmbedding() { /* no-op */ },
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
    async listBySessions() { return []; },
  };
}

function fakeCodeEmbedder(): CodeEmbedder {
  return { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };
}

const BASE: McpDeps = {
  recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
  store: {} as never,
};

async function toolNames(deps: McpDeps): Promise<string[]> {
  const server = createMcpServer(deps, "team_local");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("recall_code MCP tool registration (mcpDeps parity guard)", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => { delete process.env["NLM_CODE_EXEMPLARS_ENABLED"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("registers recall_code when exemplarStore + installScope are wired and the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const names = await toolNames({
      ...BASE,
      exemplarStore: fakeExemplarStore(),
      codeEmbedder: fakeCodeEmbedder(),
      installScope: "install-test",
    });
    expect(names).toContain("recall_code");
    // base tools still present
    expect(names).toContain("recall_sessions");
  });

  it("omits recall_code when the flag is off, even with the store wired", async () => {
    const names = await toolNames({
      ...BASE,
      exemplarStore: fakeExemplarStore(),
      codeEmbedder: fakeCodeEmbedder(),
      installScope: "install-test",
    });
    expect(names).not.toContain("recall_code");
    expect(names).toContain("recall_sessions");
  });

  it("omits recall_code when the exemplar deps are dropped from mcpDeps (the v0.13.1 regression)", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const names = await toolNames(BASE);
    expect(names).not.toContain("recall_code");
  });

  it("omits recall_code when installScope is missing", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const names = await toolNames({ ...BASE, exemplarStore: fakeExemplarStore() });
    expect(names).not.toContain("recall_code");
  });
});
