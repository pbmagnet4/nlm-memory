import { describe, expect, it } from "vitest";
import { ClassifierBox, classifierNeedsThinkDisabled } from "../../../src/llm/classifier-box.js";
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

describe("classifierNeedsThinkDisabled", () => {
  it("returns true for qwen3.5:4b", () => {
    expect(classifierNeedsThinkDisabled("qwen3.5:4b")).toBe(true);
  });

  it("returns true for qwen3.5:9b", () => {
    expect(classifierNeedsThinkDisabled("qwen3.5:9b")).toBe(true);
  });

  it("returns false for qwen3:4b-instruct-2507-q4_K_M", () => {
    expect(classifierNeedsThinkDisabled("qwen3:4b-instruct-2507-q4_K_M")).toBe(false);
  });

  it("returns false for deepseek-v4-flash", () => {
    expect(classifierNeedsThinkDisabled("deepseek-v4-flash")).toBe(false);
  });
});
