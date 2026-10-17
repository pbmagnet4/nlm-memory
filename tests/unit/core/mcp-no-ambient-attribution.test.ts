import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { recallContextHandler, recallFactsHandler, recallSessionsHandler, recallWorkstreamHandler, citeSessionHandler, type McpDeps } from "../../../src/mcp/server.js";
import { logQuery } from "../../../src/core/recall/query-log.js";
import { logFactQuery } from "../../../src/core/recall-facts/fact-query-log.js";
import { appendCitation } from "../../../src/core/recall/citation-log.js";

const scans = vi.hoisted(() => ({ readdir: vi.fn(() => { throw new Error("ambient filesystem would hang over millions of entries"); }), stat: vi.fn(() => { throw new Error("ambient stat would hang"); }) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), readdirSync: scans.readdir, statSync: scans.stat }));
vi.mock("../../../src/core/recall/query-log.js", () => ({ logQuery: vi.fn(async () => undefined) }));
vi.mock("../../../src/core/recall-facts/fact-query-log.js", () => ({ logFactQuery: vi.fn(async () => undefined) }));
vi.mock("../../../src/core/recall/citation-log.js", () => ({ appendCitation: vi.fn(async () => true) }));
vi.mock("../../../src/core/hook/memo.js", () => ({ resolveConversationForSession: vi.fn(() => null) }));
afterEach(() => vi.clearAllMocks());
const query = "a long query with enough text to trigger the former ambient transcript scan";
function deps(requestContext?: McpDeps["requestContext"]): McpDeps {
  return { recall: { search: vi.fn(async () => ({ results: [], total: 0 })) }, factRecall: { search: vi.fn(async () => ({ results: [], total: 0 })) },
    store: { getByIds: vi.fn(async () => []), getById: vi.fn(async () => null), resolveSuccessors: vi.fn(async () => new Map()) },
    workstreams: { store: { getById: vi.fn(async () => null), findByNormalizedLabel: vi.fn(async () => null) } },
    ...(requestContext ? { requestContext } : {}) } as unknown as McpDeps;
}
it("all MCP attribution paths have no transcript scanner dependency", () => {
  const source = readFileSync(new URL("../../../src/mcp/server.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/resolveConversationByQuery|resolve-conversation-by-query|readdirSync|statSync/);
});
it("long recall queries ignore large/hanging ambient filesystems, still log, and start no background work", async () => {
  const abort = new AbortController();
  const wired = deps({ tenantId: "a", signal: abort.signal });
  for (const result of [
    await recallContextHandler(wired, "a", { query, mode: "keyword" }),
    await recallSessionsHandler(wired, "a", { query, rewrite: false }),
    await recallFactsHandler(wired, "a", { query }),
    await recallWorkstreamHandler(wired, "a", { idOrLabel: query }),
    await citeSessionHandler("a", { id: "source_123456789" }),
  ]) expect(result.isError).toBeUndefined();
  expect(scans.readdir).not.toHaveBeenCalled(); expect(scans.stat).not.toHaveBeenCalled();
  expect(logQuery).toHaveBeenCalledTimes(2); expect(logFactQuery).toHaveBeenCalledTimes(2);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  for (const [, entry] of vi.mocked(logQuery).mock.calls) expect(entry).not.toHaveProperty("conversationId");
});
it("trusted context attributes only its authenticated tenant and preserves explicit citation semantics", async () => {
  const trusted = { tenantId: "a", conversationId: "trusted-conversation" };
  await recallContextHandler(deps(trusted), "a", { query, mode: "keyword" });
  expect(vi.mocked(logQuery).mock.lastCall?.[1].conversationId).toBe("trusted-conversation");
  await recallSessionsHandler(deps(trusted), "b", { query });
  await recallFactsHandler(deps(trusted), "b", { query });
  expect(vi.mocked(logQuery).mock.lastCall?.[1].conversationId).toBeUndefined();
  expect(vi.mocked(logFactQuery).mock.lastCall?.[1].conversationId).toBeUndefined();
  await citeSessionHandler("a", { id: "source_123456789" }, trusted);
  expect(vi.mocked(appendCitation).mock.lastCall?.[1].conversationId).toBe("trusted-conversation");
  await citeSessionHandler("b", { id: "source_123456789" }, trusted);
  expect(vi.mocked(appendCitation).mock.lastCall?.[1].conversationId).toBe("mcp_tool");
  await citeSessionHandler("a", { id: "source_123456789", conversation_id: "explicit" }, trusted);
  expect(vi.mocked(appendCitation).mock.lastCall?.[1].conversationId).toBe("explicit");
});
