import { describe, expect, it } from "vitest";
import { formatPointerBlock } from "../../../../src/core/hook/pointer-block.js";

describe("formatPointerBlock", () => {
  it("returns an empty string for no hits", () => {
    expect(formatPointerBlock([])).toBe("");
  });

  it("renders a header, one line per hit, and the tool footer", () => {
    const block = formatPointerBlock([
      { id: "sess_a", label: "FTS5 vs pgvector decision", startedAt: "2026-05-15T10:00:00.000Z" },
      { id: "sess_b", label: "Semantic recall via sqlite-vec", startedAt: "2026-05-17T09:30:00.000Z" },
    ]);
    expect(block).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(block).toContain("- sess_a · FTS5 vs pgvector decision (2026-05-15)");
    expect(block).toContain("- sess_b · Semantic recall via sqlite-vec (2026-05-17)");
    expect(block).toContain("recall_sessions");
    expect(block).toContain("get_session");
  });
});
