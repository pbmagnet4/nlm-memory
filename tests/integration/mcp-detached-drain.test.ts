import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkTracker } from "../../src/core/lifecycle/work-tracker.js";

const mocks = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("../../src/core/storage/supersedence-log.js", async (importOriginal) => ({
  ...await importOriginal<object>(), appendSupersedence: mocks.append,
}));
import { createMcpServer } from "../../src/mcp/server.js";

describe("MCP detached work", () => {
  it("drains a supersedence audit write after the tool returned", async () => {
    const tracker = new WorkTracker();
    let release!: () => void;
    mocks.append.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    const server = createMcpServer({
      workTracker: tracker,
      recall: {} as never,
      store: { markSuperseded: async () => {} } as never,
    }, "team_local");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "mark_superseded", arguments: {
        predecessor_id: "synthetic-old-session", successor_id: "synthetic-new-session",
      } });
      expect(result.isError).not.toBe(true);
      expect(mocks.append).toHaveBeenCalledOnce();
      tracker.stopAdmission();
      let drained = false;
      const drain = tracker.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      await drain;
      expect(drained).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
