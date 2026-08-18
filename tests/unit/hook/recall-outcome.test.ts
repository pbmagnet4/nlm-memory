// tests/unit/hook/recall-outcome.test.ts
//
// Regression: for two weeks the daemon answered every hook recall with
// results while the hook logged `hits: []`, because recallOverHttp collapsed
// timeout / unreachable / http-error / genuinely-empty into one empty result.
// Every diagnostic surface then read a dead recall path as "found nothing".
// The outcome discriminator is what makes those four distinguishable.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recallOverHttp } from "../../../src/hook/recall-over-http.js";

const QUERY = "nlm recall latency investigation";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recallOverHttp outcome", () => {
  it("reports ok when the daemon returns results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      results: [{ id: "s1", label: "L", startedAt: "2026-08-18T00:00:00Z", matchScore: 1 }],
    })));
    const res = await recallOverHttp(QUERY);
    expect(res.outcome).toBe("ok");
    expect(res.hits).toHaveLength(1);
  });

  it("distinguishes a genuinely empty result from a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ results: [] })));
    const res = await recallOverHttp(QUERY);
    expect(res.outcome).toBe("ok");
    expect(res.hits).toHaveLength(0);
  });

  it("reports timeout when the request aborts on the deadline", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    const res = await recallOverHttp(QUERY);
    expect(res.outcome).toBe("timeout");
    expect(res.hits).toHaveLength(0);
  });

  it("reports unreachable when the daemon refuses the connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const res = await recallOverHttp(QUERY);
    expect(res.outcome).toBe("unreachable");
  });

  it("reports http-error on a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const res = await recallOverHttp(QUERY);
    expect(res.outcome).toBe("http-error");
  });

  it("reports skipped when the prompt is too thin to build a query", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await recallOverHttp("ok thanks");
    expect(res.outcome).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
