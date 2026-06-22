import { describe, expect, it } from "vitest";
import { evaluateReranker, type Fire, type GoldCitation } from "../../../scripts/eval/reranker-ablation.js";

// The reranker boosts by citation frequency (ALPHA * ln(1+count)), leave-one-
// conversation-out: when scoring conversation C, boosts are built from every
// OTHER conversation's citations. These fixtures are hand-constructed so the
// rank deltas are checkable by inspection.
describe("evaluateReranker", () => {
  it("counts a positive surfaced below a distractor that prior citations lift above it", () => {
    // conv "target": query surfaced [distractor(score 2.0), positive(score 1.0)].
    // Base rank of positive = 2. Other conversations cited "positive" 10x, so the
    // LOO boost on "positive" (0.15*ln(11)≈0.36) is not enough to overtake the 1.0
    // gap — base and reranked both rank it 2nd. This asserts no false "improvement".
    const fires: Fire[] = [
      { conversationId: "target", hits: [
        { id: "distractor", score: 2.0 },
        { id: "positive", score: 1.0 },
      ] },
    ];
    const citations: GoldCitation[] = [
      { conversationId: "target", citedId: "positive" },
      ...Array.from({ length: 10 }, (_, i) => ({ conversationId: `other${i}`, citedId: "positive" })),
    ];
    const r = evaluateReranker(fires, citations);
    expect(r.samples).toBe(1);
    expect(r.mrrBase).toBeCloseTo(0.5, 5); // rank 2 -> 1/2
    expect(r.mrrReranked).toBeCloseTo(0.5, 5);
    expect(r.improved).toBe(0);
  });

  it("promotes a positive when LOO boost overtakes a near-tied distractor", () => {
    // positive scored 0.99 just below distractor 1.0; heavy prior citations on the
    // positive (boost ≈0.36) push it above. Base rank 2 -> reranked rank 1.
    const fires: Fire[] = [
      { conversationId: "target", hits: [
        { id: "distractor", score: 1.0 },
        { id: "positive", score: 0.99 },
      ] },
    ];
    const citations: GoldCitation[] = [
      { conversationId: "target", citedId: "positive" },
      ...Array.from({ length: 10 }, (_, i) => ({ conversationId: `other${i}`, citedId: "positive" })),
    ];
    const r = evaluateReranker(fires, citations);
    expect(r.mrrBase).toBeCloseTo(0.5, 5);
    expect(r.mrrReranked).toBeCloseTo(1.0, 5);
    expect(r.improved).toBe(1);
    expect(r.recallAt1Base).toBeCloseTo(0, 5);
    expect(r.recallAt1Reranked).toBeCloseTo(1, 5);
  });

  it("ignores in-conversation citations for the boost (leave-one-out is honest)", () => {
    // The ONLY citation of "positive" is in the target conversation itself. With
    // LOO, that yields zero boost, so reranked == base — proving we do not let a
    // session's own citation inflate its rank (the circularity trap).
    const fires: Fire[] = [
      { conversationId: "target", hits: [
        { id: "distractor", score: 1.0 },
        { id: "positive", score: 0.99 },
      ] },
    ];
    const citations: GoldCitation[] = [{ conversationId: "target", citedId: "positive" }];
    const r = evaluateReranker(fires, citations);
    expect(r.mrrBase).toBeCloseTo(0.5, 5);
    expect(r.mrrReranked).toBeCloseTo(0.5, 5);
    expect(r.improved).toBe(0);
  });

  it("reports positives that never reached any candidate set", () => {
    const fires: Fire[] = [
      { conversationId: "target", hits: [{ id: "x", score: 1.0 }, { id: "y", score: 0.5 }] },
    ];
    const citations: GoldCitation[] = [
      { conversationId: "target", citedId: "positive" }, // never surfaced
    ];
    const r = evaluateReranker(fires, citations);
    expect(r.samples).toBe(0);
    expect(r.unreachablePositives).toBe(1);
  });
});
