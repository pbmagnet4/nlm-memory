import { describe, expect, it } from "vitest";
import { applyHubness, hubPenalty, type HubnessParams } from "../../../src/core/hook/hubness.js";
import type { RecallHitInput } from "../../../src/core/hook/select.js";

function hit(id: string, score: number, label = `label ${id}`, summary?: string): RecallHitInput {
  return { id, label, startedAt: "2026-11-01T10:00:00.000Z", matchScore: score, ...(summary ? { summary } : {}) };
}

const params = (over: Partial<HubnessParams> = {}): HubnessParams => ({
  prompt: "vault backup rotation schedule",
  injectionCounts: new Map(),
  alpha: 0,
  lexicalFloor: 0,
  ...over,
});

describe("hubPenalty", () => {
  it("is a no-op at alpha 0 or count 0", () => {
    expect(hubPenalty(0.9, 100, 0)).toBe(0.9);
    expect(hubPenalty(0.9, 0, 0.5)).toBe(0.9);
  });

  it("divides by 1 + alpha * ln(1 + count)", () => {
    expect(hubPenalty(0.99, 100, 0.5)).toBeCloseTo(0.99 / (1 + 0.5 * Math.log(101)), 10);
  });

  it("damps monotonically: more injections, lower score; mild for tiny counts", () => {
    const s1 = hubPenalty(1, 1, 0.5);
    const s30 = hubPenalty(1, 30, 0.5);
    const s100 = hubPenalty(1, 100, 0.5);
    expect(s1).toBeGreaterThan(s30);
    expect(s30).toBeGreaterThan(s100);
    // a doubly-injected memory is barely touched (log damping)
    expect(s1).toBeGreaterThan(0.7);
  });
});

describe("applyHubness", () => {
  it("returns the input untouched when both steps are disabled", () => {
    const hits = [hit("a", 1.0), hit("b", 0.9)];
    expect(applyHubness(hits, params())).toBe(hits);
  });

  it("penalizes injected hits and re-sorts best-first", () => {
    const hits = [
      hit("hub", 0.99),
      hit("fresh", 0.9),
      hit("other", 0.8),
    ];
    const out = applyHubness(hits, params({
      alpha: 0.5,
      injectionCounts: new Map([["hub", 100]]),
    }));
    // hub 0.99 / (1 + 0.5 * ln 101) ≈ 0.30 — far below the plateau
    expect(out.map((h) => h.id)).toEqual(["fresh", "other", "hub"]);
    expect(out.find((h) => h.id === "hub")!.matchScore).toBeCloseTo(0.99 / (1 + 0.5 * Math.log(101)), 6);
  });

  it("drops a below-floor hit sharing no content term with the prompt", () => {
    const hits = [
      hit("hub", 1.0, "LinkedIn Easy Apply for Ryan Sr Manager"),
      hit("keep", 0.91, "vault backup rotation design", "rotated restic vault backups weekly"),
    ];
    const out = applyHubness(hits, params({ lexicalFloor: 2.0 }));
    expect(out.map((h) => h.id)).toEqual(["keep"]);
  });

  it("keeps a below-floor hit when label or summary shares a content term", () => {
    const byLabel = applyHubness(
      [hit("a", 1.0, "vault retention policy")],
      params({ lexicalFloor: 2.0 }),
    );
    const bySummary = applyHubness(
      [hit("b", 1.0, "unrelated title", "changed the nightly backup cadence")],
      params({ lexicalFloor: 2.0 }),
    );
    expect(byLabel).toHaveLength(1);
    expect(bySummary).toHaveLength(1);
  });

  it("keeps above-floor hits even with zero lexical overlap", () => {
    const out = applyHubness(
      [hit("strong", 2.5, "LinkedIn Easy Apply for Ryan Sr Manager")],
      params({ lexicalFloor: 2.0 }),
    );
    expect(out.map((h) => h.id)).toEqual(["strong"]);
  });

  it("never drops when the prompt has no content terms", () => {
    const out = applyHubness(
      [hit("a", 0.5, "LinkedIn Easy Apply")],
      params({ prompt: "ok done thanks", lexicalFloor: 2.0 }),
    );
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });

  it("checks the ORIGINAL score for the guard, not the penalized one", () => {
    // Penalized 3.0 -> ~2.4..? alpha 0.5 count 9 -> /(1+0.5*ln10)=1.65 -> 1.82
    // Original 3.0 is ABOVE the 2.0 floor, so the guard must not apply even
    // though the penalized score would fall below it.
    const out = applyHubness(
      [hit("x", 3.0, "unrelated label here only")],
      params({
        prompt: "vault backup rotation schedule",
        alpha: 0.5,
        lexicalFloor: 2.0,
        injectionCounts: new Map([["x", 9]]),
      }),
    );
    expect(out.map((h) => h.id)).toEqual(["x"]);
    expect(out.find((h) => h.id === "x")!.matchScore).toBeLessThan(2.0);
  });

  it("applies guard before penalty (dropped hits are never damped into the result)", () => {
    const hits = [hit("hub", 0.99, "LinkedIn Easy Apply"), hit("keep", 0.98, "vault rotation notes")];
    const out = applyHubness(hits, params({
      alpha: 0.5,
      lexicalFloor: 2.0,
      injectionCounts: new Map([["hub", 100], ["keep", 0]]),
    }));
    expect(out.map((h) => h.id)).toEqual(["keep"]);
  });
});
