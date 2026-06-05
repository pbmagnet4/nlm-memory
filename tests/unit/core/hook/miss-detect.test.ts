import { describe, expect, it } from "vitest";
import { detectMisses } from "../../../../src/core/hook/miss-detect.js";
import type { ToolUseBlock } from "../../../../src/core/hook/transcript.js";

function tu(name: string, id: string): ToolUseBlock {
  return { name, input: { id }, id: `tool_${Math.random()}` };
}

describe("detectMisses", () => {
  it("returns an empty list when no tool uses", () => {
    expect(detectMisses({ toolUses: [], surfacedIds: ["cc_a"] })).toEqual([]);
  });

  it("flags a get_session id that wasn't surfaced", () => {
    const result = detectMisses({
      toolUses: [tu("mcp__nlm-memory__get_session", "cc_missed_123456")],
      surfacedIds: ["cc_other_id_5678"],
    });
    expect(result).toEqual([{ id: "cc_missed_123456", kind: "get_session" }]);
  });

  it("flags a cite_session id that wasn't surfaced", () => {
    const result = detectMisses({
      toolUses: [tu("mcp__nlm-memory__cite_session", "cc_missed_999999")],
      surfacedIds: [],
    });
    expect(result).toEqual([{ id: "cc_missed_999999", kind: "cite_session" }]);
  });

  it("does NOT flag an id that was surfaced (citation, not a miss)", () => {
    const result = detectMisses({
      toolUses: [tu("mcp__nlm-memory__get_session", "cc_xxx_456789")],
      surfacedIds: ["cc_xxx_456789"],
    });
    expect(result).toEqual([]);
  });

  it("ignores non-NLM tool uses", () => {
    const result = detectMisses({
      toolUses: [tu("mcp__github__create_issue", "cc_missed_123456")],
      surfacedIds: [],
    });
    expect(result).toEqual([]);
  });

  it("ignores recall_sessions calls (only explicit-id tools count)", () => {
    const result = detectMisses({
      toolUses: [
        { name: "mcp__nlm-memory__recall_sessions", input: { query: "pgvector" }, id: "t1" },
      ],
      surfacedIds: [],
    });
    expect(result).toEqual([]);
  });

  it("deduplicates repeated misses for the same id", () => {
    const result = detectMisses({
      toolUses: [
        tu("mcp__nlm-memory__get_session", "cc_dup_555555"),
        tu("mcp__nlm-memory__cite_session", "cc_dup_555555"),
      ],
      surfacedIds: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("cc_dup_555555");
  });

  it("rejects ids shorter than the minimum", () => {
    const result = detectMisses({
      toolUses: [tu("mcp__nlm-memory__get_session", "ab")],
      surfacedIds: [],
    });
    expect(result).toEqual([]);
  });

  it("rejects tool inputs without an `id` field", () => {
    const result = detectMisses({
      toolUses: [{ name: "mcp__nlm-memory__get_session", input: { foo: "bar" }, id: "t1" }],
      surfacedIds: [],
    });
    expect(result).toEqual([]);
  });
});
