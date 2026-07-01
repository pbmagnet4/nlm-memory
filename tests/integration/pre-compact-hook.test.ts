import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPreCompact } from "../../src/hook/pre-compact-hook.js";
import { recordSurfaced } from "../../src/core/hook/memo.js";

describe("runPreCompact", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-pre-compact-hook-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    vi.unstubAllGlobals();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns posted:true when the daemon returns 200", async () => {
    const result = await runPreCompact(
      { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    expect(result.conversationId).toBe("conv-abc");
    expect(result.posted).toBe(true);
  });

  it("posts to http://127.0.0.1, not localhost", async () => {
    await runPreCompact(
      { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("sends the correct endpoint path", async () => {
    await runPreCompact(
      { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/api/hook/pre-compact");
  });

  it("includes Authorization header when NLM_MCP_TOKEN is set", async () => {
    process.env["NLM_MCP_TOKEN"] = "test-token-123";
    try {
      await runPreCompact(
        { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
        "3940",
      );
      const mockFetch = vi.mocked(globalThis.fetch);
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["authorization"]).toBe("Bearer test-token-123");
    } finally {
      delete process.env["NLM_MCP_TOKEN"];
    }
  });

  it("returns posted:false when the daemon is unreachable (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await runPreCompact(
      { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    expect(result.posted).toBe(false);
  });

  it("returns posted:false when the daemon returns non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 500 })));
    const result = await runPreCompact(
      { conversationId: "conv-abc", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    expect(result.posted).toBe(false);
  });

  it("includes surfaced IDs in the payload when they exist", async () => {
    recordSurfaced("conv-with-ids", ["sess_a", "sess_b"]);
    await runPreCompact(
      { conversationId: "conv-with-ids", transcriptPath: "/tmp/t.jsonl" },
      "3940",
    );
    const mockFetch = vi.mocked(globalThis.fetch);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(init?.body as string) as {
      surfaced_set: string[];
      conversation_id: string;
    };
    expect(body["conversation_id"]).toBe("conv-with-ids");
    expect(body["surfaced_set"].sort()).toEqual(["sess_a", "sess_b"].sort());
  });

  it("does not throw when fetch throws (fail-open guarantee)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    await expect(
      runPreCompact({ conversationId: "conv-err", transcriptPath: "" }, "3940"),
    ).resolves.toBeDefined();
  });
});
