import { describe, it, expect, vi } from "vitest";
import { recallSessionsHandler, recallFactsHandler } from "../../../src/mcp/server.js";

describe("MCP recall default modes", () => {
  it("recall_sessions defaults to keyword when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallSessionsHandler({ recall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: "keyword" }));
  });

  it("recall_facts defaults to hybrid when mode is omitted", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, results: [] });
    await recallFactsHandler({ factRecall: { search } } as never, { query: "x" });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid" }));
  });
});
