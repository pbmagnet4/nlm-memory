/**
 * cite_session tool_use handling in the Stop hook detector.
 *
 * The MCP server's citeSessionHandler already calls appendCitation() directly
 * when the model invokes cite_session. The Stop hook must NOT detect the same
 * cite_session tool_use and write a second log entry (double-count). The A1
 * sub-case in detectCitations now skips cite_session calls entirely.
 *
 * Implicit citations via other NLM tools (get_session, recall_sessions, etc.)
 * still fire through the A2 path as before.
 */

import { describe, expect, it } from "vitest";
import { detectCitations } from "../../../../src/core/hook/citation-detect.js";

describe("detectCitations — cite_session skipped to prevent double-count", () => {
  it("does not detect cite_session as a citation (MCP handler already logged it)", () => {
    const result = detectCitations({
      responseText: "Based on that session, here is my answer.",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([]);
  });

  it("does not detect cite_session even for a surfaced ID", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toEqual([]);
  });

  it("falls back to prose detection when cite_session is skipped and ID appears in text", () => {
    const result = detectCitations({
      responseText: "Per cc_sub_a139f4ab7ca5aa909, the decision was FTS5.",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: "cc_sub_a139f4ab7ca5aa909", kind: "prose" });
  });

  it("returns empty when multiple cite_session calls are skipped and no prose match", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "hm_20260427_6ff562" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"],
    });
    expect(result).toEqual([]);
  });

  it("A2 path (get_session) still fires while cite_session is skipped for the same turn", () => {
    const result = detectCitations({
      responseText: "",
      toolUses: [
        {
          name: "mcp__nlm-memory__cite_session",
          input: { id: "cc_sub_a139f4ab7ca5aa909" },
        },
        {
          name: "mcp__nlm-memory__get_session",
          input: { id: "hm_20260427_6ff562" },
        },
      ],
      surfacedIds: ["cc_sub_a139f4ab7ca5aa909", "hm_20260427_6ff562"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "hm_20260427_6ff562", kind: "tool_use" });
  });
});
