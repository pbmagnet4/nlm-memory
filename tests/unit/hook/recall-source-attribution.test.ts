// tests/unit/hook/recall-source-attribution.test.ts
//
// Regression (b69db02, "hook shared-helper dedup"): the session-start hook had
// its own recallOverHttp that sent `x-recall-source: session-start-hook`. The
// dedup replaced it with the shared helper, which hardcodes "hook" for every
// caller, so session-start recalls have been logged as prompt-hook traffic ever
// since. The query log shows the bucket dying on exactly that schedule: 670 in
// June, 31 in July, 0 in August, while the hook itself kept firing hundreds of
// times a month. Per-source recall precision cannot separate the two paths
// while they share a label, and they have very different achievable ceilings:
// prompt recall queries a real user prompt, session-start queries a derived
// project name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recallOverHttp } from "../../../src/hook/recall-over-http.js";

const QUERY = "nlm recall source attribution";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
  vi.stubGlobal("fetch", f);
  return f;
}

function sourceHeaderFrom(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.["x-recall-source"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recallOverHttp source attribution", () => {
  it("defaults to hook so existing prompt-recall callers are unchanged", async () => {
    const f = stubFetch();
    await recallOverHttp(QUERY);
    expect(sourceHeaderFrom(f)).toBe("hook");
  });

  it("sends the caller-supplied source", async () => {
    const f = stubFetch();
    await recallOverHttp(QUERY, "claude-code", undefined, "hybrid", "session-start-hook");
    expect(sourceHeaderFrom(f)).toBe("session-start-hook");
  });

  it("still sends the runtime alongside a custom source", async () => {
    const f = stubFetch();
    await recallOverHttp(QUERY, "claude-code", undefined, "hybrid", "session-start-hook");
    const init = f.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.["x-recall-runtime"]).toBe("claude-code");
  });
});
