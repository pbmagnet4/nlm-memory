import { describe, it, expect, vi } from "vitest";
import { recallSessionsHandler, recallFactsHandler, mcpRuntimeFromClient } from "../../../src/mcp/server.js";

describe("MCP recall default modes", () => {
  it("recall_sessions defaults to keyword when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallSessionsHandler({ recall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "keyword" }));
  });

  it("recall_facts defaults to hybrid when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallFactsHandler({ factRecall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "hybrid" }));
  });
});

describe("mcpRuntimeFromClient", () => {
  // The MCP client identifies itself in the initialize handshake (clientInfo).
  // We attribute recall pulls to that runtime so the query-log can tell an
  // agent-initiated recall (claude-code/cursor/hermes) from a manual/unknown
  // one — the missing signal that made the pull-usage backtest inconclusive.
  it("returns null when no client info is present", () => {
    expect(mcpRuntimeFromClient(undefined)).toBeNull();
  });

  it("returns null when the client name is blank", () => {
    expect(mcpRuntimeFromClient({ name: "   " })).toBeNull();
  });

  it("normalizes a reported client name (trim + lowercase)", () => {
    expect(mcpRuntimeFromClient({ name: " Cursor " })).toBe("cursor");
    expect(mcpRuntimeFromClient({ name: "claude-code" })).toBe("claude-code");
  });
});
