import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentStart } from "../../src/hook/subagent-start-hook.js";

describe("runSubagentStart", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-subagent-start-hook-"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns posted:true when the daemon returns 200", async () => {
    const result = await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "test task",
      },
      "3940",
    );
    expect(result.parentConversationId).toBe("conv-parent");
    expect(result.subagentSessionId).toBe("conv-sub");
    expect(result.posted).toBe(true);
  });

  it("posts to http://127.0.0.1, not localhost", async () => {
    await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "task",
      },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("sends the correct endpoint path", async () => {
    await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "task",
      },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/hook/subagent-start");
  });

  it("includes Authorization header when NLM_MCP_TOKEN is set", async () => {
    process.env["NLM_MCP_TOKEN"] = "my-token-xyz";
    try {
      await runSubagentStart(
        {
          parentConversationId: "conv-parent",
          subagentSessionId: "conv-sub",
          subagentDescription: "task",
        },
        "3940",
      );
      const mockFetch = vi.mocked(globalThis.fetch);
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["authorization"]).toBe("Bearer my-token-xyz");
    } finally {
      delete process.env["NLM_MCP_TOKEN"];
    }
  });

  it("returns posted:false when the daemon is unreachable (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "task",
      },
      "3940",
    );
    expect(result.posted).toBe(false);
  });

  it("returns posted:false when the daemon returns non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 500 })));
    const result = await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "task",
      },
      "3940",
    );
    expect(result.posted).toBe(false);
  });

  it("includes all three fields in the POST payload", async () => {
    await runSubagentStart(
      {
        parentConversationId: "conv-parent",
        subagentSessionId: "conv-sub",
        subagentDescription: "audit skill",
      },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as {
      parent_conversation_id: string;
      subagent_session_id: string;
      subagent_description: string;
    };
    expect(body["parent_conversation_id"]).toBe("conv-parent");
    expect(body["subagent_session_id"]).toBe("conv-sub");
    expect(body["subagent_description"]).toBe("audit skill");
  });

  it("does not throw when fetch throws (fail-open guarantee)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(
      runSubagentStart(
        {
          parentConversationId: "conv-err",
          subagentSessionId: "conv-sub-err",
          subagentDescription: "",
        },
        "3940",
      ),
    ).resolves.toBeDefined();
  });
});
