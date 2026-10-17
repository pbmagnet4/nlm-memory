import { describe, expect, it } from "vitest";
import { scoreContext, groupedBootstrap } from "../../../../src/core/eval/context/score.js";
import type { ContextCase, ReaderAnswer } from "../../../../src/core/eval/context/types.js";
const sample: ContextCase = { id: "why", question: "Why SQLite?", category: "rationale", sourceFamily: "one", split: "dev", expected: { answerable: true, claims: ["SQLite", "single writer"], alternatives: [], sourceRanges: [{ sourceId: "s1", start: 0, end: "SQLite uses a single writer".length, text: "SQLite uses a single writer" }] } };
const answer = (text: string): ReaderAnswer => ({ text, abstained: false, evidence: [{ sourceId: "s1", text }] });
describe("source-grounded evidence sufficiency", () => {
  it("requires the rationale and supporting source, not only the value", () => {
    expect(scoreContext(sample, answer("SQLite")).sufficient).toBe(false);
    expect(scoreContext(sample, { ...answer("SQLite uses a single writer"), evidence: [] }).sufficient).toBe(false);
    expect(scoreContext(sample, answer("SQLite uses a single writer")).sufficient).toBe(true);
  });
  it("requires every ambiguity alternative", () => {
    const c = { ...sample, category: "ambiguity" as const, expected: { ...sample.expected, claims: [], alternatives: ["SQLite", "Postgres"], sourceRanges: [] } };
    expect(scoreContext(c, answer("SQLite")).sufficient).toBe(false);
    expect(scoreContext(c, answer("SQLite or Postgres")).sufficient).toBe(true);
  });
  it("rejects unrelated answers on no-answer questions", () => {
    const c = { ...sample, expected: { answerable: false, claims: [], alternatives: [], sourceRanges: [] } };
    expect(scoreContext(c, answer("the answer is SQLite")).sufficient).toBe(false);
    expect(scoreContext(c, { text: "Insufficient evidence", abstained: true, evidence: [] }).sufficient).toBe(true);
  });
  it("bootstraps families, so ten duplicate questions remain one group", () => {
    const rows = Array.from({ length: 10 }, () => ({ family: "one", baseline: 0, candidate: 1 }));
    expect(groupedBootstrap(rows, 100).groups).toBe(1);
    expect(groupedBootstrap(rows, 100).lower).toBeNull();
  });
});
