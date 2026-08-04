import { afterEach, describe, expect, it, vi } from "vitest";
import { chatOnce } from "../../../scripts/eval/lib/chat-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(capture: { body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      capture.body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "VERDICT" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("chatOnce", () => {
  it("sends max_tokens and temperature", async () => {
    const cap: { body?: any } = {};
    stubFetch(cap);
    await chatOnce(
      { baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 400 },
      "sys",
      "usr",
    );
    expect(cap.body.max_tokens).toBe(400);
    expect(cap.body.temperature).toBe(0);
    expect(cap.body.model).toBe("m");
  });

  it("sends stream: false, matching the original inline request body", async () => {
    const cap: { body?: any } = {};
    stubFetch(cap);
    await chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u");
    expect(cap.body.stream).toBe(false);
  });

  it("omits reasoning_effort when unset and includes it when set", async () => {
    const cap: { body?: any } = {};
    stubFetch(cap);
    await chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u");
    expect("reasoning_effort" in cap.body).toBe(false);

    await chatOnce(
      { baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10, reasoningEffort: "none" },
      "s",
      "u",
    );
    expect(cap.body.reasoning_effort).toBe("none");
  });

  it("returns the assistant content", async () => {
    stubFetch({});
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).resolves.toBe("VERDICT");
  });

  it("throws on a non-2xx response that fails on retry too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).rejects.toThrow(/500/);
  });

  it("throws when the model returns empty content on both attempts, rather than returning a silent blank", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
            status: 200,
          }),
      ),
    );
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).rejects.toThrow(/empty/i);
  });

  it("normalises a trailing slash on baseUrl", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        });
      }),
    );
    await chatOnce({ baseUrl: "http://x/v1/", model: "m", temperature: 0, maxTokens: 1 }, "s", "u");
    expect(calls[0]).toBe("http://x/v1/chat/completions");
  });

  it("retries once on transport/HTTP failure and returns the retry's content, matching recall-impact-replay.ts's callChat", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response("server hiccup", { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "RETRIED" } }] }), {
          status: 200,
        });
      }),
    );
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).resolves.toBe("RETRIED");
    expect(calls).toBe(2);
  });

  it("retries once on an empty-content response and returns the retry's content", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        const content = calls === 1 ? "" : "RETRIED";
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
        });
      }),
    );
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).resolves.toBe("RETRIED");
    expect(calls).toBe(2);
  });

  it("does not retry more than once (fails after exactly two attempts)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("nope", { status: 500 });
      }),
    );
    await expect(
      chatOnce({ baseUrl: "http://x/v1", model: "m", temperature: 0, maxTokens: 10 }, "s", "u"),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
