/**
 * extractFacts — pure transform from ClassifyResult to Fact[]. No DB, no
 * randomness (idGenerator is injected).
 */

import { describe, expect, it } from "vitest";
import { extractFacts } from "../../../../src/core/facts/extract-facts.js";
import type { ClassifyResult } from "../../../../src/ports/llm-client.js";

function classifyResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    label: "L",
    summary: "S",
    entities: [],
    decisions: [],
    open: [],
    confidence: 0.9,
    facts: [],
    ...overrides,
  };
}

describe("extractFacts", () => {
  it("returns an empty array when classify result has no facts", () => {
    const out = extractFacts(classifyResult(), "sess_1", "2026-05-19T10:00:00Z");
    expect(out).toEqual([]);
  });

  it("maps classifier facts to full Fact records with injected id + timestamp", () => {
    let n = 0;
    const result = classifyResult({
      confidence: 0.85,
      facts: [
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
        {
          kind: "attribute",
          subject: "mac-pro",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
          sourceQuote: "endpoint at :8080",
        },
      ],
    });
    const out = extractFacts(result, "sess_1", "2026-05-19T10:00:00Z", {
      idGenerator: () => `fact_${++n}`,
    });
    expect(out).toEqual([
      {
        id: "fact_1",
        kind: "decision",
        subject: "nlm-memory-ts",
        predicate: "framework",
        value: "Hono",
        sourceSessionId: "sess_1",
        sourceQuote: null,
        createdAt: "2026-05-19T10:00:00Z",
        supersededBy: null,
        confidence: 0.85,
      },
      {
        id: "fact_2",
        kind: "attribute",
        subject: "mac-pro",
        predicate: "endpoint",
        value: "http://macpro:8080/v1",
        sourceSessionId: "sess_1",
        sourceQuote: "endpoint at :8080",
        createdAt: "2026-05-19T10:00:00Z",
        supersededBy: null,
        confidence: 0.85,
      },
    ]);
  });

  it("drops all facts when classifier confidence is below 0.4", () => {
    const result = classifyResult({
      confidence: 0.35,
      facts: [
        { kind: "decision", subject: "x", predicate: "framework", value: "y" },
      ],
    });
    expect(extractFacts(result, "sess_1", "2026-05-19T10:00:00Z")).toEqual([]);
  });

  it("keeps facts when confidence is exactly the floor (0.4)", () => {
    const result = classifyResult({
      confidence: 0.4,
      facts: [
        { kind: "decision", subject: "x", predicate: "framework", value: "y" },
      ],
    });
    expect(extractFacts(result, "sess_1", "2026-05-19T10:00:00Z")).toHaveLength(1);
  });

  it("uses default id generator (fact_<uuid>) when none provided", () => {
    const result = classifyResult({
      facts: [{ kind: "decision", subject: "x", predicate: "framework", value: "y" }],
    });
    const out = extractFacts(result, "sess_1", "2026-05-19T10:00:00Z");
    expect(out[0]?.id).toMatch(/^fact_[0-9a-f-]{36}$/);
  });

  it("each fact gets its own id from the generator (no reuse)", () => {
    let n = 0;
    const result = classifyResult({
      facts: [
        { kind: "decision", subject: "a", predicate: "framework", value: "x" },
        { kind: "decision", subject: "b", predicate: "framework", value: "y" },
        { kind: "decision", subject: "c", predicate: "framework", value: "z" },
      ],
    });
    const out = extractFacts(result, "sess_1", "2026-05-19T10:00:00Z", {
      idGenerator: () => `fact_${++n}`,
    });
    expect(out.map((f) => f.id)).toEqual(["fact_1", "fact_2", "fact_3"]);
  });
});
