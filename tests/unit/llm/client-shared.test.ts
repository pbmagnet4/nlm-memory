import { describe, expect, it, vi } from "vitest";
import { ClassifierSchemaError, LLMUnreachableError } from "../../../src/ports/llm-client.js";
import { classifyWithRetry, parseClassifierContent, rewriteTimeoutMs } from "../../../src/llm/client-shared.js";

const VALID_JSON = JSON.stringify({
  label: "NLM",
  summary: "session summary",
  entities: ["NLM", "Ollama"],
  decisions: ["use shared module"],
  open: [],
  confidence: 0.9,
  facts: [],
});

const FENCED_JSON = "```json\n" + VALID_JSON + "\n```";

describe("parseClassifierContent", () => {
  it("accepts plain JSON and returns a coerced ClassifyResult", () => {
    const result = parseClassifierContent(VALID_JSON, "ollama");
    expect(result.label).toBe("NLM");
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("accepts fenced JSON after stripping fences", () => {
    const result = parseClassifierContent(FENCED_JSON, "deepseek");
    expect(result.label).toBe("NLM");
  });

  it("trims whitespace before stripping fences", () => {
    const result = parseClassifierContent("  " + FENCED_JSON + "  ", "ollama");
    expect(result.label).toBe("NLM");
  });

  it("throws ClassifierSchemaError with provider label for non-JSON content", () => {
    expect(() => parseClassifierContent("not json at all", "ollama")).toThrow(
      "ollama returned non-JSON content",
    );
    expect(() => parseClassifierContent("not json at all", "ollama")).toThrow(ClassifierSchemaError);
  });

  it("throws ClassifierSchemaError with deepseek label for non-JSON content", () => {
    expect(() => parseClassifierContent("bad content", "deepseek")).toThrow(
      "deepseek returned non-JSON content",
    );
  });

  it("throws ClassifierSchemaError with provider label for missing required keys", () => {
    const partial = JSON.stringify({ label: "x", summary: "y" });
    expect(() => parseClassifierContent(partial, "ollama")).toThrow(
      "ollama response missing required keys",
    );
    expect(() => parseClassifierContent(partial, "deepseek")).toThrow(
      "deepseek response missing required keys",
    );
  });
});

describe("classifyWithRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const once = vi.fn().mockResolvedValue({ label: "X", summary: "", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] });
    const result = await classifyWithRetry(3, once);
    expect(result.label).toBe("X");
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("retries exactly N times on ClassifierSchemaError then throws the last error", async () => {
    const err = new ClassifierSchemaError("bad json");
    const once = vi.fn().mockRejectedValue(err);
    await expect(classifyWithRetry(3, once)).rejects.toBe(err);
    expect(once).toHaveBeenCalledTimes(3);
  });

  it("retries on LLMUnreachableError", async () => {
    const unreachable = new LLMUnreachableError("ollama", "connection refused");
    const success = { label: "Y", summary: "", entities: [], decisions: [], open: [], confidence: 1, facts: [] };
    const once = vi.fn()
      .mockRejectedValueOnce(unreachable)
      .mockResolvedValue(success);
    const result = await classifyWithRetry(3, once);
    expect(result.label).toBe("Y");
    expect(once).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on a plain Error (propagates immediately)", async () => {
    const boom = new Error("unexpected internal failure");
    const once = vi.fn().mockRejectedValue(boom);
    await expect(classifyWithRetry(3, once)).rejects.toBe(boom);
    expect(once).toHaveBeenCalledTimes(1);
  });
});

describe("rewriteTimeoutMs", () => {
  it("returns 5000 when the env var is not set", () => {
    delete process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
    expect(rewriteTimeoutMs()).toBe(5_000);
  });

  it("returns the parsed value when set to a valid positive integer", () => {
    process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"] = "10000";
    expect(rewriteTimeoutMs()).toBe(10_000);
    delete process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  });

  it("returns 5000 for a non-numeric value", () => {
    process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"] = "notanumber";
    expect(rewriteTimeoutMs()).toBe(5_000);
    delete process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  });

  it("returns 5000 for zero or negative values", () => {
    process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"] = "0";
    expect(rewriteTimeoutMs()).toBe(5_000);
    process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"] = "-100";
    expect(rewriteTimeoutMs()).toBe(5_000);
    delete process.env["NLM_RECALL_REWRITE_TIMEOUT_MS"];
  });
});
