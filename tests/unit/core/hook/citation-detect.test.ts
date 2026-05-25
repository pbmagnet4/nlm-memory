import { describe, expect, it } from "vitest";
import {
  detectCitations,
  detectCitedIds,
} from "../../../../src/core/hook/citation-detect.js";

describe("detectCitedIds (back-compat prose-only)", () => {
  it("returns IDs that appear as substrings in the response", () => {
    const surfaced = new Set([
      "cc_sub_a139f4ab7ca5aa909",
      "hm_20260427_6ff562",
    ]);
    const text = "Per cc_sub_a139f4ab7ca5aa909 and hm_20260427_6ff562 we chose FTS5.";
    expect(detectCitedIds(text, surfaced).sort()).toEqual(
      ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"].sort(),
    );
  });

  it("returns empty when no surfaced IDs appear", () => {
    expect(detectCitedIds("unrelated", new Set(["cc_sub_abc123def456"]))).toEqual([]);
  });

  it("ignores IDs shorter than the minimum length", () => {
    expect(detectCitedIds("a ab abc abcdef", new Set(["a", "ab", "abc"]))).toEqual([]);
  });
});

describe("detectCitations (combined tool_use + prose)", () => {
  it("emits a tool_use citation when an NLM MCP tool input references a surfaced ID", () => {
    const result = detectCitations({
      responseText: "Let me look at that.",
      toolUses: [
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"],
    });
    expect(result).toEqual([
      { id: "cc_sub_a139f4ab7ca5aa909", kind: "tool_use" },
    ]);
  });

  it("emits a prose citation when only the response text mentions the ID", () => {
    const result = detectCitations({
      responseText: "We decided on FTS5 per cc_sub_a139f4ab7ca5aa909.",
      toolUses: [],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([
      { id: "cc_sub_a139f4ab7ca5aa909", kind: "prose" },
    ]);
  });

  it("prefers tool_use over prose when both fire on the same ID", () => {
    const result = detectCitations({
      responseText: "Per cc_sub_a139f4ab7ca5aa909, here is the answer.",
      toolUses: [
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([
      { id: "cc_sub_a139f4ab7ca5aa909", kind: "tool_use" },
    ]);
  });

  it("ignores non-NLM tool_use blocks even when they happen to contain the ID", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "Bash",
          input: { command: "grep cc_sub_a139f4ab7ca5aa909 /tmp/log" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([]);
  });

  it("handles multiple NLM tool calls in one turn", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "hm_20260427_6ff562" },
        },
      ],
      surfacedIds: [
        "cc_sub_a139f4ab7ca5aa909",
        "hm_20260427_6ff562",
        "cc_unused_id_xyz",
      ],
    });
    expect(result.map((c) => c.id).sort()).toEqual(
      ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"].sort(),
    );
    expect(result.every((c) => c.kind === "tool_use")).toBe(true);
  });

  it("recognizes recall_sessions tool calls with query+limit (no direct id) — does not emit when no ID present in input", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__recall_sessions",
          input: { query: "FTS5 vs pgvector", limit: 5 },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([]);
  });
});
