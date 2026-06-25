import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../../../src/llm/deepseek-client.js";

const VALID_CLASSIFY_JSON = JSON.stringify({
  label: "x",
  summary: "y",
  entities: [],
  decisions: [],
  open: [],
  confidence: 0.9,
  facts: [],
});

/** Build a fetch mock that records the last request and returns a valid
 *  OpenAI-shaped classify response. */
function recordingFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: VALID_CLASSIFY_JSON } }] }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("DeepSeekClient — OpenAI-compatible request shaping", () => {
  it("omits response_format when responseFormat is 'none' (LM Studio MLX rejects json_object)", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new DeepSeekClient({
      apiKey: "local",
      baseUrl: "http://localhost:1234/v1",
      classifyModel: "qwen3.5-4b-mlx",
      responseFormat: "none",
      fetchImpl,
    });
    await client.classify("some transcript");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).not.toHaveProperty("response_format");
  });

  it("sends response_format json_object by default (DeepSeek behavior preserved)", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new DeepSeekClient({ apiKey: "k", classifyModel: "deepseek-v4-flash", fetchImpl });
    await client.classify("some transcript");
    expect(calls[0]!.body).toHaveProperty("response_format");
    expect((calls[0]!.body as { response_format: { type: string } }).response_format.type).toBe(
      "json_object",
    );
  });

  it("hits the configured baseUrl with the configured model", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new DeepSeekClient({
      apiKey: "local",
      baseUrl: "http://localhost:1234/v1",
      classifyModel: "qwen3.5-4b-mlx",
      responseFormat: "none",
      fetchImpl,
    });
    await client.classify("t");
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("qwen3.5-4b-mlx");
  });

  it("honors a custom classifyMaxTokens (headroom for thinking models that can't disable CoT)", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new DeepSeekClient({
      apiKey: "local",
      baseUrl: "http://h:1234/v1",
      classifyModel: "m",
      responseFormat: "none",
      classifyMaxTokens: 16384,
      fetchImpl,
    });
    await client.classify("t");
    expect(calls[0]!.body.max_tokens).toBe(16384);
  });

  it("accepts an explicit apiKey so keyless local endpoints work without DEEPSEEK_API_KEY", () => {
    expect(
      () =>
        new DeepSeekClient({
          apiKey: "local",
          baseUrl: "http://h:1234/v1",
          classifyModel: "m",
          responseFormat: "none",
        }),
    ).not.toThrow();
  });
});

function fakeFetch(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
    })) as unknown as typeof fetch;
}

describe("DeepSeekClient.nameWorkstream", () => {
  const cands = [
    { label: "NLM", aliases: ["nlm-memory"] },
    { label: "Acme", aliases: [] },
  ];
  it("returns the matched candidate label from a chatty (thinking) response", async () => {
    const c = new DeepSeekClient({
      baseUrl: "http://x/v1",
      apiKey: "local",
      classifyModel: "qwen3.5-4b-mlx",
      fetchImpl: fakeFetch("<reasoning...>\n\nNLM"),
    });
    expect(
      await c.nameWorkstream("Finding insertion points for nlm-memory files\nsummary", cands),
    ).toBe("NLM");
  });
  it("returns null when the model answers none", async () => {
    const c = new DeepSeekClient({
      baseUrl: "http://x/v1",
      apiKey: "local",
      classifyModel: "qwen3.5-4b-mlx",
      fetchImpl: fakeFetch("none"),
    });
    expect(await c.nameWorkstream("Zephyr persona work\nsummary", cands)).toBeNull();
  });
});
