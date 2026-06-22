import { describe, expect, it } from "vitest";
import { selectHits, type RecallHitInput } from "../../../../src/core/hook/select.js";

const hit = (id: string, matchScore: number): RecallHitInput => ({
  id,
  label: `label ${id}`,
  startedAt: "2026-05-15T10:00:00.000Z",
  matchScore,
});

describe("selectHits", () => {
  it("drops hits below the score threshold", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.3)],
      surfaced: new Set(),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });

  it("drops hits already surfaced in this conversation", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8)],
      surfaced: new Set(["a"]),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["b"]);
  });

  it("caps the number surfaced per fire", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7), hit("d", 0.6)],
      surfaced: new Set(),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("respects the remaining per-conversation budget", () => {
    const out = selectHits({
      hits: [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)],
      surfaced: new Set(["x", "y", "z", "p", "q", "r", "s", "t", "u"]), // 9 surfaced
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out.map((h) => h.id)).toEqual(["a"]); // only 1 slot left
  });

  it("returns nothing when the per-conversation cap is already met", () => {
    const out = selectHits({
      hits: [hit("a", 0.9)],
      surfaced: new Set(Array.from({ length: 10 }, (_, i) => `s${i}`)),
      scoreThreshold: 0.5,
      perFireCap: 3,
      perConversationCap: 10,
    });
    expect(out).toEqual([]);
  });

  it("relativeFloor trims tail hits below a fraction of the fire median", () => {
    // scores [10,8,4,2] -> median = sorted[2] = 8. relFloor 0.9 cuts < 7.2:
    // a(10), b(8) kept; c(4), d(2) dropped. Scale-invariant (works on raw BM25).
    const out = selectHits({
      hits: [hit("a", 10), hit("b", 8), hit("c", 4), hit("d", 2)],
      surfaced: new Set(),
      scoreThreshold: 0,
      perFireCap: 10,
      perConversationCap: 10,
      relativeFloor: 0.9,
    });
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("relativeFloor of 0 disables relative filtering", () => {
    const out = selectHits({
      hits: [hit("a", 10), hit("b", 2)],
      surfaced: new Set(),
      scoreThreshold: 0,
      perFireCap: 10,
      perConversationCap: 10,
      relativeFloor: 0,
    });
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("relativeFloor never drops a fire's top hit (top >= median)", () => {
    // A sole weak hit: score == median, so score >= floor*median holds; kept.
    const out = selectHits({
      hits: [hit("a", 0.01)],
      surfaced: new Set(),
      scoreThreshold: 0,
      perFireCap: 10,
      perConversationCap: 10,
      relativeFloor: 0.9,
    });
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });
});
