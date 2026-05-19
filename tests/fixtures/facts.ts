import type { Fact } from "../../src/shared/types.js";

export function makeFact(overrides: Partial<Fact> = {}): Fact {
  const base: Fact = {
    id: "fact_test_1",
    kind: "decision",
    subject: "nle-memory-ts",
    predicate: "framework",
    value: "Hono",
    sourceSessionId: "cc_test_1",
    sourceQuote: null,
    createdAt: "2026-05-19T10:30:00Z",
    supersededBy: null,
    confidence: 0.9,
  };
  return { ...base, ...overrides };
}
