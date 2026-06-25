import { describe, expect, it } from "vitest";
import { scoreMergePair, suggestMerges } from "../../../../src/core/workstream/merge-suggest.js";

const item = (id: string, label: string, entities: string[], sessionIds: string[]) => ({ id, label, entities, sessionIds });

describe("scoreMergePair", () => {
  it("scores identical-entity, similar-label pairs high", () => {
    const s = scoreMergePair(item("a", "NLM Memory", ["x", "y"], ["s1"]), item("b", "nlm-memory", ["x", "y"], ["s2"]));
    expect(s.sharedEntities).toBe(2);
    expect(s.labelSimilarity).toBeGreaterThan(0.5);
    expect(s.score).toBeGreaterThan(0.5);
  });
  it("scores disjoint pairs low", () => {
    const s = scoreMergePair(item("a", "Alpha", ["x"], ["s1"]), item("b", "Beta", ["z"], ["s2"]));
    expect(s.sharedEntities).toBe(0);
    expect(s.score).toBeLessThan(0.3);
  });
});

describe("suggestMerges", () => {
  it("returns only pairs at or above minScore, ranked desc, each pair once", () => {
    const items = [
      item("a", "NLM", ["x", "y"], ["s1"]),
      item("b", "NLM Memory", ["x", "y"], ["s1"]),
      item("c", "Totally Other", ["q"], ["s9"]),
    ];
    const out = suggestMerges(items, 0.3);
    expect(out.length).toBe(1);              // only a/b clears the bar
    expect(new Set([out[0]!.aId, out[0]!.bId])).toEqual(new Set(["a", "b"]));
    expect(out[0]!.score).toBeGreaterThanOrEqual(0.3);
  });
});
