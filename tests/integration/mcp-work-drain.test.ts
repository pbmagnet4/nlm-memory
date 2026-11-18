import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkTracker } from "../../src/core/lifecycle/work-tracker.js";
import { createMcpServer } from "../../src/mcp/server.js";

describe("MCP work tracking", () => {
  it("keeps a tool tracked after its client disconnects", async () => {
    const tracker = new WorkTracker();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const server = createMcpServer({
      workTracker: tracker,
      recall: { search: async () => {
        markStarted();
        await pending;
        return { query: "synthetic", mode: "keyword", limit: 1, total: 0, results: [] };
      } } as never,
      store: {} as never,
    }, "team_local");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const call = client.callTool({ name: "recall_sessions", arguments: { query: "synthetic", mode: "keyword", rewrite: false } });
    void call.catch(() => {});
    await started;
    tracker.stopAdmission();
    const denied = await client.callTool({ name: "recall_sessions", arguments: { query: "another", mode: "keyword", rewrite: false } });
    expect(denied.isError).toBe(true);
    await client.close();
    let drained = false;
    const draining = tracker.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
    await server.close();
  });
});
