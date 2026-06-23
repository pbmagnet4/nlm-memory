import { describe, expect, it } from "vitest";
import { defaultTopicProvider, aliasTopicProvider } from "../../../../src/core/work-digest/topics.js";

describe("defaultTopicProvider", () => {
  it("uses the first entity, normalized (trim + lowercase)", () => {
    expect(defaultTopicProvider({ entities: ["  NLM-Memory ", "fts5"], label: "x" })).toBe("nlm-memory");
  });

  it("falls back to uncategorized with no entity", () => {
    expect(defaultTopicProvider({ entities: [], label: "x" })).toBe("uncategorized");
  });

  it("falls back to uncategorized when the first entity is blank", () => {
    expect(defaultTopicProvider({ entities: ["   "], label: "x" })).toBe("uncategorized");
  });
});

describe("aliasTopicProvider", () => {
  it("maps a known entity to its label", () => {
    const p = aliasTopicProvider({ pgvector: "NLM", fts5: "NLM" });
    expect(p({ entities: ["pgvector"], label: "x" })).toBe("NLM");
  });

  it("is case-insensitive on the map key", () => {
    const p = aliasTopicProvider({ PgVector: "NLM" });
    expect(p({ entities: ["PGVECTOR"], label: "x" })).toBe("NLM");
  });

  it("falls through to the normalized entity when unmapped", () => {
    const p = aliasTopicProvider({ pgvector: "NLM" });
    expect(p({ entities: ["ACME"], label: "x" })).toBe("acme");
  });
});
