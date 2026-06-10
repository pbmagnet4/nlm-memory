import { describe, expect, it } from "vitest";
import { LLMUnreachableError } from "../../../../src/ports/llm-client.js";
import { parseRewriteJson } from "../../../../src/core/recall/rewrite-prompt.js";

describe("parseRewriteJson", () => {
  it("parses well-formed JSON output", () => {
    const result = parseRewriteJson(
      '{"keywordQuery":"pgvector","semanticQuery":"pgvector decision","rationale":"stripped filler"}',
      "ollama",
    );
    expect(result.keywordQuery).toBe("pgvector");
    expect(result.semanticQuery).toBe("pgvector decision");
    expect(result.rationale).toBe("stripped filler");
  });

  it("strips a leading code fence the model leaked", () => {
    const result = parseRewriteJson(
      '```json\n{"keywordQuery":"pgvector","semanticQuery":"pgvector"}\n```',
      "ollama",
    );
    expect(result.keywordQuery).toBe("pgvector");
  });

  it("trims whitespace inside fields", () => {
    const result = parseRewriteJson(
      '{"keywordQuery":"  pgvector  ","semanticQuery":"  pgvector decision  "}',
      "deepseek",
    );
    expect(result.keywordQuery).toBe("pgvector");
    expect(result.semanticQuery).toBe("pgvector decision");
  });

  it("makes rationale optional", () => {
    const result = parseRewriteJson(
      '{"keywordQuery":"a","semanticQuery":"a"}',
      "ollama",
    );
    expect(result.rationale).toBeUndefined();
  });

  it("throws LLMUnreachableError on non-JSON", () => {
    expect(() => parseRewriteJson("not json", "ollama")).toThrow(LLMUnreachableError);
  });

  it("throws LLMUnreachableError on missing keywordQuery", () => {
    expect(() => parseRewriteJson('{"semanticQuery":"x"}', "ollama")).toThrow(
      LLMUnreachableError,
    );
  });

  it("throws LLMUnreachableError on empty keywordQuery", () => {
    expect(() => parseRewriteJson('{"keywordQuery":"","semanticQuery":"x"}', "ollama"))
      .toThrow(LLMUnreachableError);
  });

  it("throws LLMUnreachableError on non-object payload", () => {
    expect(() => parseRewriteJson("null", "ollama")).toThrow(LLMUnreachableError);
    expect(() => parseRewriteJson('"a string"', "ollama")).toThrow(LLMUnreachableError);
  });
});
