/**
 * recall_voice MCP tool registration (T2438 piece D).
 *
 * Guards the NLM_VOICE_ENABLED=1 gate the same way the recall_code tool test
 * guards its flag: the tool is reachable over the protocol only when the
 * writing-sample store is wired and the flag is on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpDeps } from "../../src/mcp/server.js";
import type { WritingSampleStore } from "../../src/ports/writing-sample-store.js";

function fakeWritingSamples(): WritingSampleStore {
  return {
    async insert() { return { id: "x", skipped: false }; },
    async upsertEmbedding() { /* no-op */ },
    async missingEmbeddings() { return []; },
    async search() { return []; },
    async latest() { return []; },
  };
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

describe("recall_voice MCP tool registration", () => {
  const prev = process.env["NLM_VOICE_ENABLED"];
  beforeEach(() => { delete process.env["NLM_VOICE_ENABLED"]; });
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_VOICE_ENABLED"];
    else process.env["NLM_VOICE_ENABLED"] = prev;
  });

  it("registers recall_voice when the store is wired and the flag is on", async () => {
    process.env["NLM_VOICE_ENABLED"] = "1";
    const names = await toolNames({ ...BASE, writingSamples: fakeWritingSamples() });
    expect(names).toContain("recall_voice");
    expect(names).toContain("recall_sessions");
  });

  it("omits recall_voice when the flag is off, even with the store wired", async () => {
    const names = await toolNames({ ...BASE, writingSamples: fakeWritingSamples() });
    expect(names).not.toContain("recall_voice");
    expect(names).toContain("recall_sessions");
  });

  it("omits recall_voice when the store is not wired", async () => {
    process.env["NLM_VOICE_ENABLED"] = "1";
    const names = await toolNames(BASE);
    expect(names).not.toContain("recall_voice");
  });
});
