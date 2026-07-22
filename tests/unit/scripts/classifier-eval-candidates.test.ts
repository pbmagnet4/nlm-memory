import { describe, expect, it } from "vitest";
import { buildCandidates, candidatesFromEnv } from "../../../scripts/eval/classifier-eval.js";

describe("candidatesFromEnv", () => {
  it("builds an ollama candidate from a spec", () => {
    const candidates = candidatesFromEnv(
      JSON.stringify([{ name: "custom ollama", provider: "ollama", model: "qwen3:8b" }]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.key).toBe("ollama:qwen3:8b");
    expect(candidates[0]!.label).toBe("custom ollama");
  });

  it("builds an openai-compatible candidate from a spec", () => {
    const candidates = candidatesFromEnv(
      JSON.stringify([
        { name: "custom studio", provider: "openai-compatible", baseUrl: "http://x:8000/v1", model: "Foo-9B" },
      ]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.key).toBe("openai-compatible:Foo-9B");
    expect(candidates[0]!.label).toBe("custom studio");
  });

  it("builds multiple candidates in order", () => {
    const candidates = candidatesFromEnv(
      JSON.stringify([
        { name: "a", provider: "ollama", model: "m1" },
        { name: "b", provider: "openai-compatible", model: "m2" },
      ]),
    );
    expect(candidates.map((c) => c.label)).toEqual(["a", "b"]);
  });

  it("throws on invalid JSON", () => {
    expect(() => candidatesFromEnv("not json")).toThrow(/invalid JSON/);
  });

  it("throws on an empty array", () => {
    expect(() => candidatesFromEnv("[]")).toThrow(/non-empty/);
  });

  it("throws on a non-array value", () => {
    expect(() => candidatesFromEnv('{"name":"a"}')).toThrow(/non-empty/);
  });

  it("throws when a spec is missing a required field", () => {
    expect(() => candidatesFromEnv(JSON.stringify([{ name: "a", provider: "ollama" }]))).toThrow(
      /requires "name", "provider", and "model"/,
    );
  });

  it("throws on an unknown provider", () => {
    expect(() =>
      candidatesFromEnv(JSON.stringify([{ name: "a", provider: "bogus", model: "m1" }])),
    ).toThrow(/unknown provider/);
  });
});

describe("buildCandidates", () => {
  it("falls back to the hardcoded default list when NLM_EVAL_CANDIDATES is unset", () => {
    const prev = process.env["NLM_EVAL_CANDIDATES"];
    delete process.env["NLM_EVAL_CANDIDATES"];
    try {
      const candidates = buildCandidates();
      expect(candidates).toHaveLength(3);
      expect(candidates.map((c) => c.key)).toContain("studio:Qwen3.5-9B-MLX-8bit");
    } finally {
      if (prev !== undefined) process.env["NLM_EVAL_CANDIDATES"] = prev;
    }
  });

  it("uses NLM_EVAL_CANDIDATES when set, replacing the hardcoded list", () => {
    const prev = process.env["NLM_EVAL_CANDIDATES"];
    process.env["NLM_EVAL_CANDIDATES"] = JSON.stringify([
      { name: "only one", provider: "ollama", model: "solo:1b" },
    ]);
    try {
      const candidates = buildCandidates();
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.label).toBe("only one");
    } finally {
      if (prev === undefined) delete process.env["NLM_EVAL_CANDIDATES"];
      else process.env["NLM_EVAL_CANDIDATES"] = prev;
    }
  });
});
