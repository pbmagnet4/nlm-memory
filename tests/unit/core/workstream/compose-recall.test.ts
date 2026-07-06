// tests/unit/core/workstream/compose-recall.test.ts
import { describe, expect, it } from "vitest";
import { composeWorkstreamRecall } from "../../../../src/core/workstream/compose-recall.js";
import type { Fact, CodeExemplar } from "../../../../src/shared/types.js";

const fact = (kind: Fact["kind"], subject: string, value: string): Fact => ({
  id: `f_${subject}`, kind, subject, predicate: "is", value,
  sourceSessionId: "s1", sourceQuote: null, createdAt: "2026-06-24T00:00:00Z",
  supersededBy: null, confidence: 1, retiredAt: null,
});

describe("composeWorkstreamRecall", () => {
  it("renders the workstream label, session count, decisions, open loops, and exemplars", () => {
    const out = composeWorkstreamRecall({
      workstream: { id: "ws_1", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: "2026-06-24T00:00:00Z", scope: null },
      sessionIds: ["s1", "s2"],
      facts: [fact("decision", "store", "use sqlite-vec"), fact("open", "thresholds", "tune HIGH/LOW")],
      exemplars: [{ id: "e1", installScope: "x", signalId: null, sessionId: "s1", repo: "nlm-memory", model: "m", lang: "ts", taskContext: "matcher", code: "x", codeHash: "h", outcome: "pass", gitSha: null, survived: 1, ts: "t", createdAt: "t", retiredAt: null, labelSource: "llm" } as CodeExemplar],
    });
    expect(out).toContain("NLM");
    expect(out).toContain("2 sessions");
    expect(out).toContain("use sqlite-vec");
    expect(out).toContain("tune HIGH/LOW");
    expect(out).toContain("nlm-memory");
    expect(out).not.toContain("undefined");
  });

  it("handles an empty workstream gracefully", () => {
    const out = composeWorkstreamRecall({
      workstream: { id: "ws_1", label: "Empty", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null, scope: null },
      sessionIds: [], facts: [], exemplars: [],
    });
    expect(out).toContain("Empty");
    expect(out).toContain("0 sessions");
  });
});
