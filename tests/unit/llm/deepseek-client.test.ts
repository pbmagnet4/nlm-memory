import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../../../src/llm/deepseek-client.js";
import { ClassifierSchemaError, LLMUnreachableError } from "../../../src/ports/llm-client.js";

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

describe("DeepSeekClient cancellation", () => {
  it("a caller abort cancels the in-flight request and is not retried", async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "http://gw/v1", classifyModel: "m", classifyAttempts: 3, fetchImpl });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    await expect(client.classify("transcript", { signal: caller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

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
    { label: "NLM" },
    { label: "Acme" },
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

const FALLBACK_PRIMARY = "http://192.168.2.2:4000/v1";
const FALLBACK_BASE = "http://100.87.184.75:4000/v1";

function okClassifyResponse(): Response {
  return okClassifyEnvelope(VALID_CLASSIFY_JSON);
}

function okClassifyEnvelope(content: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => content,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function errClassifyResponse(status: number, body = ""): Response {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response;
}

function stubClassifyFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

function fallbackClientFor(fetchImpl: typeof fetch, fallbackBaseUrl?: string) {
  return new DeepSeekClient({
    apiKey: "test-key",
    baseUrl: FALLBACK_PRIMARY,
    fetchImpl,
    classifyModel: "litellm-classifier",
    responseFormat: "none",
    classifyTimeoutMs: 5_000,
    ...(fallbackBaseUrl ? { fallbackBaseUrl } : {}),
  });
}

describe("DeepSeekClient gateway fallback", () => {
  it("fails over to the fallback base on primary network error", async () => {
    const seen: string[] = [];
    const fetchImpl = stubClassifyFetch((url) => {
      seen.push(url);
      if (url.startsWith(FALLBACK_PRIMARY)) throw new TypeError("fetch failed");
      return okClassifyResponse();
    });
    const out = await fallbackClientFor(fetchImpl, FALLBACK_BASE).classify("hello");
    expect(out.summary).toBe("y");
    expect(seen).toEqual([`${FALLBACK_PRIMARY}/chat/completions`, `${FALLBACK_BASE}/chat/completions`]);
  });

  it("fails over on primary HTTP 500", async () => {
    const seen: string[] = [];
    const fetchImpl = stubClassifyFetch((url) => {
      seen.push(url);
      if (url.startsWith(FALLBACK_PRIMARY)) return errClassifyResponse(500, "tunnel down");
      return okClassifyResponse();
    });
    const out = await fallbackClientFor(fetchImpl, FALLBACK_BASE).classify("hello");
    expect(out.summary).toBe("y");
    expect(seen.some((u) => u.startsWith(FALLBACK_BASE))).toBe(true);
  });

  it("does not fail over on primary HTTP 401", async () => {
    const seen: string[] = [];
    const fetchImpl = stubClassifyFetch((url) => {
      seen.push(url);
      return errClassifyResponse(401, "unauthorized");
    });
    await expect(fallbackClientFor(fetchImpl, FALLBACK_BASE).classify("hello")).rejects.toBeInstanceOf(
      LLMUnreachableError,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.startsWith(FALLBACK_PRIMARY))).toBe(true);
  });

  it("does not fail over on classifier schema errors", async () => {
    const seen: string[] = [];
    const fetchImpl = stubClassifyFetch((url) => {
      seen.push(url);
      return okClassifyEnvelope("not json at all");
    });
    await expect(fallbackClientFor(fetchImpl, FALLBACK_BASE).classify("hello")).rejects.toBeInstanceOf(
      ClassifierSchemaError,
    );
    expect(seen.every((u) => u.startsWith(FALLBACK_PRIMARY))).toBe(true);
  });

  it("rejects without a fallback configured (existing behavior)", async () => {
    const fetchImpl = stubClassifyFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fallbackClientFor(fetchImpl).classify("hello")).rejects.toBeInstanceOf(
      LLMUnreachableError,
    );
  });
});

describe("DeepSeekClient.complete thinking switch", () => {
  /** Fetch mock recording complete() bodies; replies with a plain string. */
  function recordingComplete() {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as unknown as Response;
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  const base = { apiKey: "local", baseUrl: "http://localhost:1234/v1", classifyModel: "m" };

  it("merges chat_template_kwargs enable_thinking:false on per-call request", async () => {
    const { calls, fetchImpl } = recordingComplete();
    const client = new DeepSeekClient({ ...base, fetchImpl });
    await expect(client.complete("sys", "user", { enable_thinking: false })).resolves.toBe("ok");
    expect(calls[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("sends no thinking switch when the call passes nothing", async () => {
    const { calls, fetchImpl } = recordingComplete();
    const client = new DeepSeekClient({ ...base, fetchImpl });
    await client.complete("sys", "user");
    expect(calls[0]).not.toHaveProperty("chat_template_kwargs");
  });

  it("per-call false preserves other construction-time template kwargs", async () => {
    const { calls, fetchImpl } = recordingComplete();
    const client = new DeepSeekClient({
      ...base,
      fetchImpl,
      extraBody: { chat_template_kwargs: { other: 1 } },
    });
    await client.complete("sys", "user", { enable_thinking: false });
    expect(calls[0]).toMatchObject({ chat_template_kwargs: { other: 1, enable_thinking: false } });
  });
});
