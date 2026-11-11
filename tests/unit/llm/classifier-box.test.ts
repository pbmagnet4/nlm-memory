import { describe, expect, it, vi } from "vitest";
import { ClassifierBox } from "../../../src/llm/classifier-box.js";
import { resolveClassifierTuning, NO_STORED_SETTINGS } from "../../../src/core/classifier/tuning.js";
import { formatPointerBlock } from "../../../src/core/hook/pointer-block.js";
import type { ClassifyResult, LLMClient } from "../../../src/ports/llm-client.js";

describe("ClassifierBox.classify", () => {
  it("strips the injected recall pointer block before delegating to the inner classifier", async () => {
    const box = new ClassifierBox({ provider: "ollama", model: "qwen3:4b-instruct" });
    let seen = "";
    const empty: ClassifyResult = {
      label: "", summary: "", entities: [], decisions: [], open: [], confidence: 0.9, facts: [],
    };
    const fakeInner: LLMClient = {
      classify: async (t: string) => { seen = t; return empty; },
      embed: async () => { throw new Error("unused"); },
      rewriteForRecall: async () => { throw new Error("unused"); },
      nameWorkstream: async () => { throw new Error("unused"); },
    };
    (box as unknown as { inner: LLMClient }).inner = fakeInner;

    const block = formatPointerBlock([{ id: "pi_1", label: "Prior", startedAt: "2026-06-16" }]);
    await box.classify(`${block}\n\nreal user message`);

    expect(seen).not.toContain("NLM tools:");
    expect(seen).not.toContain("Possibly-relevant prior sessions");
    expect(seen).toContain("real user message");
  });
});

describe("ClassifierBox — openai provider", () => {
  it("constructs with no API key (local OpenAI-compatible endpoints are keyless)", () => {
    const box = new ClassifierBox({
      provider: "openai",
      model: "qwen3.5-4b-mlx",
      baseUrl: "http://localhost:1234/v1",
    });
    expect(box.provider).toBe("openai");
    expect(box.model).toBe("qwen3.5-4b-mlx");
  });

  it("throws a clear error when the openai provider has no baseUrl", () => {
    expect(() => new ClassifierBox({ provider: "openai", model: "qwen3.5-4b-mlx" })).toThrow(
      /baseUrl/i,
    );
  });
});

describe("ClassifierBox.nameWorkstream", () => {
  it("delegates to the inner client and returns its answer", async () => {
    const box = new ClassifierBox({ provider: "openai", model: "qwen3.5-4b-mlx", baseUrl: "http://x/v1" });
    // @ts-expect-error - reach past the wrapper to stub the inner client for the test
    box["inner"] = { nameWorkstream: async () => "NLM" };
    const out = await box.nameWorkstream("some session text", [{ label: "NLM" }]);
    expect(out).toBe("NLM");
  });
});

function tuning(stored: Partial<typeof NO_STORED_SETTINGS> = {}) {
  return resolveClassifierTuning({ ...NO_STORED_SETTINGS, ...stored }, {});
}

/** Fake fetch answering both gateway shapes; records each request body. */
function recordingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const content = JSON.stringify({ label: "l", summary: "s", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] });
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], message: { content } }), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

describe("ClassifierBox thinking tuning", () => {
  const base = { model: "gemma", baseUrl: "http://gw/v1", apiKey: "k" } as const;

  it("openai + thinking off sends chat_template_kwargs.enable_thinking=false", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const box = new ClassifierBox({ provider: "openai", ...base, tuning: tuning({ thinking: "off" }), fetchImpl });
    await box.classify("[user] hi");
    expect(bodies[0]?.["chat_template_kwargs"]).toEqual({ enable_thinking: false });
  });

  it("openai + thinking on sends no chat_template_kwargs", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const box = new ClassifierBox({ provider: "openai", ...base, tuning: tuning({ thinking: "on" }), fetchImpl });
    await box.classify("[user] hi");
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
  });

  it("ollama + thinking off sets think:false; on omits it", async () => {
    const off = recordingFetch();
    await new ClassifierBox({ provider: "ollama", model: "m", tuning: tuning({ thinking: "off" }), fetchImpl: off.fetchImpl }).classify("[user] hi");
    expect(off.bodies[0]?.["think"]).toBe(false);
    const on = recordingFetch();
    await new ClassifierBox({ provider: "ollama", model: "m", tuning: tuning({ thinking: "on" }), fetchImpl: on.fetchImpl }).classify("[user] hi");
    expect(on.bodies[0]).not.toHaveProperty("think");
  });

  it("deepseek sends neither thinking field in either mode", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    for (const thinking of ["off", "on"] as const) {
      const { bodies, fetchImpl } = recordingFetch();
      const box = new ClassifierBox({ provider: "deepseek", model: "deepseek-v4-flash", tuning: tuning({ thinking }), fetchImpl });
      await box.classify("[user] hi");
      expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
      expect(bodies[0]).not.toHaveProperty("think");
    }
    vi.unstubAllEnvs();
  });

  it("retune rebuilds the client: off -> on drops the field, and exposes the new timeout", async () => {
    const { bodies, fetchImpl } = recordingFetch();
    const box = new ClassifierBox({ provider: "openai", ...base, tuning: tuning({ thinking: "off" }), fetchImpl });
    box.retune(tuning({ thinking: "on", timeoutMs: 300_000 }));
    await box.classify("[user] hi");
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
    expect(box.timeoutMs).toBe(300_000);
  });

  it("sends max_tokens only from a setting; the client default otherwise", async () => {
    const dflt = recordingFetch();
    await new ClassifierBox({ provider: "openai", ...base, tuning: tuning(), fetchImpl: dflt.fetchImpl }).classify("[user] hi");
    expect(dflt.bodies[0]?.["max_tokens"]).toBe(8192);
    const set = recordingFetch();
    await new ClassifierBox({ provider: "openai", ...base, tuning: tuning({ maxTokens: 2048 }), fetchImpl: set.fetchImpl }).classify("[user] hi");
    expect(set.bodies[0]?.["max_tokens"]).toBe(2048);
  });
});

/**
 * T679 Part 4: a daemon with NLM_CLASSIFIER=openai (model litellm-classifier on a
 * LiteLLM gateway) logged "LLM unreachable: deepseek", because the `openai`
 * provider rides DeepSeekClient — a generic OpenAI-compatible transport — and that
 * class named itself in every error. The label must be the configured provider, or
 * the operator debugs the wrong lane.
 */
describe("ClassifierBox provider label in errors", () => {
  const base = { model: "litellm-classifier", baseUrl: "http://gw/v1", apiKey: "k" } as const;

  function statusFetch(status: number) {
    return (async () => new Response("upstream unavailable", { status })) as unknown as typeof fetch;
  }
  const networkDownFetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  it("names the openai provider on an HTTP failure, not the transport class", async () => {
    const box = new ClassifierBox({ provider: "openai", ...base, fetchImpl: statusFetch(503) });
    const err = await box.classify("[user] hi").catch((e: unknown) => e);
    expect(String(err)).toContain("LLM unreachable: openai (status 503");
    expect(String(err)).not.toMatch(/deepseek/i);
  });

  it("names the openai provider on a network failure", async () => {
    const box = new ClassifierBox({ provider: "openai", ...base, fetchImpl: networkDownFetch });
    const err = await box.classify("[user] hi").catch((e: unknown) => e);
    expect(String(err)).toContain("LLM unreachable: openai");
    expect(String(err)).not.toMatch(/deepseek/i);
  });

  it("labels rewrite and complete with the openai provider too", async () => {
    const box = new ClassifierBox({ provider: "openai", ...base, fetchImpl: statusFetch(502) });
    await expect(box.rewriteForRecall("what did we decide"))
      .rejects.toThrow(/LLM unreachable: openai-rewrite \(status 502/);
    await expect(box.complete("sys", "user")).rejects.toThrow(/LLM unreachable: openai-complete/);
  });

  it("labels an unparseable response with the openai provider", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const box = new ClassifierBox({ provider: "openai", ...base, fetchImpl });
    await expect(box.classify("[user] hi")).rejects.toThrow(/openai returned non-JSON content/);
  });

  it("still says deepseek when the deepseek provider is the one configured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const box = new ClassifierBox({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fetchImpl: statusFetch(503),
    });
    await expect(box.classify("[user] hi")).rejects.toThrow(/LLM unreachable: deepseek \(status 503/);
    vi.unstubAllEnvs();
  });

  it("keeps the label after a runtime provider swap", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    const box = new ClassifierBox({ provider: "openai", ...base, fetchImpl: statusFetch(503) });
    box.swap("deepseek", "deepseek-v4-flash");
    await expect(box.classify("[user] hi")).rejects.toThrow(/LLM unreachable: deepseek/);
    box.swap("openai", "litellm-classifier");
    await expect(box.classify("[user] hi")).rejects.toThrow(/LLM unreachable: openai/);
    vi.unstubAllEnvs();
  });
});
