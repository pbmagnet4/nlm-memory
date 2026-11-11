import { describe, it, expect } from "vitest";
import { formatPointerBlock } from "@core/hook/pointer-block.js";
import {
  enforcePromotionCap,
  findDemotions,
  isPromotionEligible,
  promotionLineBytes,
  renderPromotionLine,
  scorePromotionCandidate,
  selectPromotions,
  MAX_PROMOTION_BYTES,
  MAX_PROMOTION_LINES,
  type PromotionCandidate,
  type PromotionSignals,
} from "@core/dream/promotion.js";

let seq = 0;
function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  seq += 1;
  return {
    id: `p${seq}`,
    subject: "proj",
    predicate: "db",
    value: "postgres",
    propertySlug: null,
    corroborationCount: 3,
    confidence: 0.9,
    sourceSessionId: "sess-1",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function signals(overrides: Partial<{
  retrievalCounts: ReadonlyMap<string, number>;
  citationCounts: ReadonlyMap<string, number>;
  everCited: ReadonlySet<string>;
}> = {}): PromotionSignals {
  return {
    retrievalCounts: new Map(),
    citationCounts: new Map(),
    everCited: new Set(),
    ...overrides,
  };
}

describe("promotion scoring core", () => {
  describe("eligibility", () => {
    it("requires corroboration AND a live signal (retrieved or cited)", () => {
      const c = candidate();
      expect(isPromotionEligible(c, signals())).toBe(false);
      expect(isPromotionEligible(c, signals({ retrievalCounts: new Map([[c.id, 2]]) }))).toBe(true);
      expect(isPromotionEligible(c, signals({ citationCounts: new Map([[c.id, 1]]) }))).toBe(true);
      expect(
        isPromotionEligible(candidate({ corroborationCount: 1 }), signals({ retrievalCounts: new Map([["x", 9]]) })),
      ).toBe(false);
    });

    it("takes its corroboration floor from the caller, defaulting to MIN_CORROBORATION (T1729)", () => {
      const retrieved = (id: string) => signals({ retrievalCounts: new Map([[id, 1]]) });
      const c = candidate({ id: "corr2", corroborationCount: 2 });
      // Default constant: two sessions clear the bar.
      expect(isPromotionEligible(c, retrieved("corr2"))).toBe(true);
      // A raised floor from the dream settings moves it.
      expect(isPromotionEligible(c, retrieved("corr2"), 3)).toBe(false);
      // A lowered floor admits a single-session fact.
      expect(isPromotionEligible(candidate({ id: "loner", corroborationCount: 1 }), retrieved("loner"), 1)).toBe(true);
    });

    it("refuses low-confidence and blank triples", () => {
      const retrieved = (id: string) => signals({ retrievalCounts: new Map([[id, 1]]) });
      const low = candidate({ id: "low", confidence: 0.2 });
      expect(isPromotionEligible(low, retrieved("low"))).toBe(false);
      const blank = candidate({ id: "blank", value: "  " });
      expect(isPromotionEligible(blank, retrieved("blank"))).toBe(false);
    });
  });

  describe("scoring", () => {
    it("is monotonic in every signal and cites dominate", () => {
      const c = candidate();
      const base = scorePromotionCandidate(c, signals({ retrievalCounts: new Map([[c.id, 1]]) }));
      const moreRetrieved = scorePromotionCandidate(
        c,
        signals({ retrievalCounts: new Map([[c.id, 2]]) }),
      );
      const cited = scorePromotionCandidate(
        c,
        signals({ retrievalCounts: new Map([[c.id, 1]]), citationCounts: new Map([[c.id, 1]]) }),
      );
      expect(moreRetrieved).toBeGreaterThan(base);
      expect(cited).toBeGreaterThan(moreRetrieved);
    });

    it("caps each signal so one viral fact cannot eat the budget", () => {
      const c = candidate();
      const capped = scorePromotionCandidate(
        c,
        signals({ retrievalCounts: new Map([[c.id, 10_000]]), citationCounts: new Map([[c.id, 10_000]]) }),
      );
      const atCap = scorePromotionCandidate(
        c,
        signals({ retrievalCounts: new Map([[c.id, 10]]), citationCounts: new Map([[c.id, 5]]) }),
      );
      expect(capped).toBe(atCap);
    });
  });

  describe("rendering and the cap", () => {
    it("renderPromotionLine matches the pointer-block Known-facts line exactly", () => {
      const c = candidate({ propertySlug: "app-one", corroborationCount: 4 });
      const block = formatPointerBlock(
        [],
        [{ ...(c.propertySlug !== null ? { property: c.propertySlug } : {}), subject: c.subject, predicate: c.predicate, value: c.value, corroborationCount: c.corroborationCount }],
      );
      const line = block.split("\n").find((l) => l.startsWith("- "))!;
      expect(renderPromotionLine(c)).toBe(line);
    });

    it("selects top scores first under the line cap", () => {
      const a = candidate({ id: "a", createdAt: "2026-01-01T00:00:00Z" });
      const b = candidate({ id: "b", corroborationCount: 9, createdAt: "2026-01-02T00:00:00Z" });
      const sig = signals({ retrievalCounts: new Map([["a", 1], ["b", 1]]) });
      const picked = selectPromotions([a, b], sig, { maxLines: 1 });
      expect(picked.map((p) => p.id)).toEqual(["b"]);
    });

    it("skips a nominee that would burst the byte cap but keeps fitting ones", () => {
      const big = candidate({ id: "big", value: "x".repeat(500), corroborationCount: 9 });
      const small = candidate({ id: "small", value: "y", corroborationCount: 8 });
      const sig = signals({ retrievalCounts: new Map([["big", 5], ["small", 5]]) });
      const bigBytes = promotionLineBytes(renderPromotionLine(big));
      const picked = selectPromotions([big, small], sig, { maxLines: 10, maxBytes: bigBytes - 1 });
      expect(picked.map((p) => p.id)).toEqual(["small"]);
    });

    it("breaks score ties deterministically (corroboration, then age, then id)", () => {
      const old = candidate({ id: "m", corroborationCount: 3, createdAt: "2026-01-01T00:00:00Z" });
      const young = candidate({ id: "a", corroborationCount: 3, createdAt: "2026-02-01T00:00:00Z" });
      const sig = signals({ retrievalCounts: new Map([["m", 1], ["a", 1]]) });
      expect(selectPromotions([young, old], sig).map((p) => p.id)).toEqual(["m", "a"]);
    });

    it("defaults to the 200-line / 25KB cap", () => {
      expect(MAX_PROMOTION_LINES).toBe(200);
      expect(MAX_PROMOTION_BYTES).toBe(25 * 1024);
    });
  });

  describe("demotion", () => {
    const NOW = Date.parse("2026-06-01T00:00:00Z");
    const activeIds = new Set(["k1", "k2", "k3"]);

    it("demotes facts that left the active set", () => {
      const out = findDemotions(
        [{ factId: "gone", promotedAt: "2026-05-01T00:00:00Z", score: 10 }],
        activeIds,
        signals(),
        NOW,
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.reason).toContain("left the active set");
    });

    it("demotes stale promotions with no window signal", () => {
      const out = findDemotions(
        [{ factId: "k1", promotedAt: "2026-01-01T00:00:00Z", score: 10 }],
        activeIds,
        signals(),
        NOW,
      );
      expect(out.map((d) => d.factId)).toEqual(["k1"]);
      expect(out[0]!.reason).toContain("stale");
    });

    it("keeps recent promotions even with no signal yet", () => {
      const out = findDemotions(
        [{ factId: "k1", promotedAt: "2026-05-25T00:00:00Z", score: 10 }],
        activeIds,
        signals(),
        NOW,
      );
      expect(out).toEqual([]);
    });

    it("demotes old retrieved-but-never-cited promotions: cost without benefit", () => {
      const out = findDemotions(
        [{ factId: "k2", promotedAt: "2026-01-01T00:00:00Z", score: 10 }],
        activeIds,
        signals({ retrievalCounts: new Map([["k2", 3]]), everCited: new Set(["other"]) }),
        NOW,
      );
      expect(out.map((d) => d.factId)).toEqual(["k2"]);
      expect(out[0]!.reason).toContain("never cited");
    });

    it("demotes never-cited promotions past the grace period but before stale", () => {
      const out = findDemotions(
        [{ factId: "k3", promotedAt: "2026-05-10T00:00:00Z", score: 10 }],
        activeIds,
        signals({ everCited: new Set(["other"]) }),
        NOW,
      );
      expect(out.map((d) => d.factId)).toEqual(["k3"]);
      expect(out[0]!.reason).toContain("never cited");
    });

    it("does not demote a cited-at-least-once promotion for lack of window citations", () => {
      const out = findDemotions(
        [{ factId: "k3", promotedAt: "2026-05-20T00:00:00Z", score: 10 }],
        activeIds,
        signals({ retrievalCounts: new Map([["k3", 2]]), everCited: new Set() }),
        NOW,
      );
      expect(out).toEqual([]);
    });
  });

  describe("enforcePromotionCap", () => {
    it("keeps the top-scoring prefix and reports the rest as dropped", () => {
      const entries = [
        { factId: "low", score: 1, line: "- low" },
        { factId: "high", score: 9, line: "- high" },
        { factId: "mid", score: 5, line: "- mid" },
      ];
      const { kept, dropped } = enforcePromotionCap(entries, { maxLines: 2 });
      expect(kept).toEqual(["high", "mid"]);
      expect(dropped).toEqual(["low"]);
    });
  });
});
