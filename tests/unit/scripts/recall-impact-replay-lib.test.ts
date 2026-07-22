import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  buildGeneratorMessages,
  buildJudgePrompt,
  computeQuartiles,
  computeVerdict,
  deriveSeed,
  filterEligible,
  fnv1a,
  GATE_THRESHOLDS,
  hasLeakage,
  makeRng,
  monthKey,
  orderForPair,
  parseJudgeVerdict,
  reconstructBlock,
  resolveArmWinner,
  seededShuffle,
  stratifiedSample,
  type ResolvedRow,
  type SessionLike,
} from "../../../scripts/eval/lib/recall-impact-replay-lib.js";

describe("makeRng / seededShuffle", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0,1)", () => {
    const rng = makeRng(1);
    for (let i = 0; i < 50; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different seeds diverge", () => {
    const a = makeRng(1)();
    const b = makeRng(2)();
    expect(a).not.toBe(b);
  });

  it("seededShuffle is deterministic and a permutation", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = seededShuffle(arr, makeRng(7));
    const s2 = seededShuffle(arr, makeRng(7));
    expect(s1).toEqual(s2);
    expect([...s1].sort((a, b) => a - b)).toEqual(arr);
  });
});

describe("fnv1a / deriveSeed", () => {
  it("is deterministic", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(deriveSeed(1, "x")).toBe(deriveSeed(1, "x"));
  });

  it("differs across labels", () => {
    expect(deriveSeed(1, "a")).not.toBe(deriveSeed(1, "b"));
  });
});

describe("monthKey", () => {
  it("extracts YYYY-MM", () => {
    expect(monthKey("2026-07-21T13:14:22.961Z")).toBe("2026-07");
  });
});

describe("reconstructBlock", () => {
  const sessionMap = new Map<string, SessionLike>([
    ["s1", { id: "s1", label: "First session", startedAt: "2026-05-01T00:00:00.000Z", summary: "Did a thing." }],
    ["s2", { id: "s2", label: "Second session", startedAt: "2026-05-02T00:00:00.000Z", summary: "Did another thing." }],
  ]);

  it("builds the block via the real composer, preserving wouldInject order", () => {
    const block = reconstructBlock(["s2", "s1"], sessionMap);
    expect(block).not.toBeNull();
    const idxS2 = block!.indexOf("s2");
    const idxS1 = block!.indexOf("s1");
    expect(idxS2).toBeGreaterThanOrEqual(0);
    expect(idxS1).toBeGreaterThan(idxS2);
    expect(block).toContain("Possibly-relevant prior sessions");
  });

  it("returns null when any referenced id is unresolved", () => {
    expect(reconstructBlock(["s1", "missing"], sessionMap)).toBeNull();
  });

  it("returns null for an id that never existed at all", () => {
    expect(reconstructBlock(["nope"], sessionMap)).toBeNull();
  });
});

describe("hasLeakage", () => {
  it("flags a prompt that already contains a verbatim pointer-block line", () => {
    const block = "## Possibly-relevant prior sessions (nlm-memory)\n- s1 · First session (2026-05-01)\nNLM tools: recall_sessions (search).";
    const prompt = "why does the hook keep saying ## Possibly-relevant prior sessions (nlm-memory) in my output";
    expect(hasLeakage(prompt, block)).toBe(true);
  });

  it("does not flag an unrelated prompt", () => {
    const block = "## Possibly-relevant prior sessions (nlm-memory)\n- s1 · First session (2026-05-01)\nNLM tools: recall_sessions (search).";
    expect(hasLeakage("what did we decide about pgvector vs Qdrant", block)).toBe(false);
  });

  it("returns false for an empty block", () => {
    expect(hasLeakage("anything", "")).toBe(false);
  });
});

describe("filterEligible", () => {
  function row(overrides: Partial<ResolvedRow>): ResolvedRow {
    return {
      ts: "2026-05-01T00:00:00.000Z",
      promptPreview: "a valid long enough prompt here",
      wouldInject: ["s1"],
      blockText: "## Possibly-relevant prior sessions (nlm-memory)\n- s1 · label (2026-05-01)",
      ...overrides,
    };
  }

  it("keeps a clean row", () => {
    const { eligible, excluded } = filterEligible([row({})]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.month).toBe("2026-05");
    expect(excluded).toEqual({ tooShort: 0, duplicate: 0, unresolved: 0, leakage: 0 });
  });

  it("excludes prompts under the min-length floor", () => {
    const { eligible, excluded } = filterEligible([row({ promptPreview: "short" })]);
    expect(eligible).toHaveLength(0);
    expect(excluded.tooShort).toBe(1);
  });

  it("excludes duplicates, keeping the first occurrence", () => {
    const rows = [
      row({ ts: "2026-05-01T00:00:00.000Z", promptPreview: "same prompt text here" }),
      row({ ts: "2026-05-02T00:00:00.000Z", promptPreview: "same prompt text here" }),
    ];
    const { eligible, excluded } = filterEligible(rows);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.ts).toBe("2026-05-01T00:00:00.000Z");
    expect(excluded.duplicate).toBe(1);
  });

  it("excludes unresolved rows", () => {
    const { eligible, excluded } = filterEligible([row({ blockText: null })]);
    expect(eligible).toHaveLength(0);
    expect(excluded.unresolved).toBe(1);
  });

  it("excludes leakage rows", () => {
    const block = "## Possibly-relevant prior sessions (nlm-memory)\n- s1 · label (2026-05-01)";
    const rows = [
      row({
        blockText: block,
        promptPreview: "before text ## Possibly-relevant prior sessions (nlm-memory) after text",
      }),
    ];
    const { eligible, excluded } = filterEligible(rows);
    expect(eligible).toHaveLength(0);
    expect(excluded.leakage).toBe(1);
  });

  it("counts each excluded row exactly once even when it matches multiple reasons", () => {
    // Too-short takes priority over everything else.
    const { excluded } = filterEligible([row({ promptPreview: "hi", blockText: null })]);
    expect(excluded.tooShort).toBe(1);
    expect(excluded.unresolved).toBe(0);
  });
});

describe("stratifiedSample", () => {
  interface R {
    readonly id: string;
    readonly month: string;
  }
  function make(month: string, count: number, startId: number): R[] {
    return Array.from({ length: count }, (_, i) => ({ id: `${month}-${startId + i}`, month }));
  }

  it("samples exactly n when the pool is larger, proportional by stratum", () => {
    const rows = [...make("2026-05", 60, 0), ...make("2026-06", 30, 0), ...make("2026-07", 10, 0)];
    const { selected, strataCounts } = stratifiedSample(rows, (r) => r.month, 10, 20260721);
    expect(selected).toHaveLength(10);
    // 60/100*10=6, 30/100*10=3, 10/100*10=1 — exact, no rounding needed.
    expect(strataCounts["2026-05"]).toBe(6);
    expect(strataCounts["2026-06"]).toBe(3);
    expect(strataCounts["2026-07"]).toBe(1);
  });

  it("is deterministic for a given seed", () => {
    const rows = [...make("2026-05", 60, 0), ...make("2026-06", 30, 0), ...make("2026-07", 10, 0)];
    const first = stratifiedSample(rows, (r) => r.month, 10, 99);
    const second = stratifiedSample(rows, (r) => r.month, 10, 99);
    expect(first.selected.map((r) => r.id)).toEqual(second.selected.map((r) => r.id));
  });

  it("caps at pool size when n exceeds it", () => {
    const rows = make("2026-05", 5, 0);
    const { selected } = stratifiedSample(rows, (r) => r.month, 100, 1);
    expect(selected).toHaveLength(5);
  });

  it("returns nothing for an empty pool", () => {
    const { selected, strataCounts } = stratifiedSample([] as R[], (r) => r.month, 10, 1);
    expect(selected).toHaveLength(0);
    expect(strataCounts).toEqual({});
  });

  it("redistributes remainder when a small stratum caps out", () => {
    // One tiny stratum (2 rows) that would get proportional allocation > its size.
    const rows = [...make("2026-05", 2, 0), ...make("2026-06", 98, 0)];
    const { selected, strataCounts } = stratifiedSample(rows, (r) => r.month, 50, 5);
    expect(selected).toHaveLength(50);
    expect(strataCounts["2026-05"]).toBeLessThanOrEqual(2);
  });
});

describe("orderForPair / resolveArmWinner", () => {
  it("is deterministic for a given seed + pairKey", () => {
    const o1 = orderForPair(20260721, "row-1");
    const o2 = orderForPair(20260721, "row-1");
    expect(o1).toEqual(o2);
  });

  it("produces a valid A/B permutation", () => {
    const o = orderForPair(1, "some-key");
    expect(new Set([o.x, o.y])).toEqual(new Set(["A", "B"]));
  });

  it("resolveArmWinner maps X/Y back to the correct arm", () => {
    const order = { x: "B" as const, y: "A" as const };
    expect(resolveArmWinner(order, "X")).toBe("B");
    expect(resolveArmWinner(order, "Y")).toBe("A");
    expect(resolveArmWinner(order, "tie")).toBe("tie");
  });
});

describe("parseJudgeVerdict", () => {
  it("parses clean JSON", () => {
    expect(parseJudgeVerdict('{"winner": "X", "reason": "more specific"}')).toEqual({
      winner: "X",
      reason: "more specific",
    });
  });

  it("tolerates markdown code fences", () => {
    expect(parseJudgeVerdict('```json\n{"winner": "tie", "reason": "equal"}\n```')).toEqual({
      winner: "tie",
      reason: "equal",
    });
  });

  it("extracts a JSON object embedded in stray prose", () => {
    const raw = 'Sure, here is my verdict: {"winner": "Y", "reason": "less filler"} thanks!';
    expect(parseJudgeVerdict(raw)).toEqual({ winner: "Y", reason: "less filler" });
  });

  it("returns null for invalid winner enum", () => {
    expect(parseJudgeVerdict('{"winner": "Z", "reason": "?"}')).toBeNull();
  });

  it("returns null for unparseable garbage", () => {
    expect(parseJudgeVerdict("not json at all")).toBeNull();
  });

  it("defaults reason to empty string when absent", () => {
    expect(parseJudgeVerdict('{"winner": "tie"}')).toEqual({ winner: "tie", reason: "" });
  });
});

describe("buildGeneratorMessages / buildJudgePrompt (arm-identity blindness)", () => {
  it("arm A prepends the block, arm B is bare", () => {
    const a = buildGeneratorMessages("do the thing", "## Possibly-relevant prior sessions");
    const b = buildGeneratorMessages("do the thing", null);
    expect(a.user.startsWith("## Possibly-relevant prior sessions")).toBe(true);
    expect(a.user.endsWith("do the thing")).toBe(true);
    expect(b.user).toBe("do the thing");
    expect(a.system).toBe(b.system);
  });

  it("judge prompt never mentions arm identity or injection", () => {
    const { system, user } = buildJudgePrompt("prompt text", "response x text", "response y text");
    const combined = `${system}\n${user}`.toLowerCase();
    expect(combined).not.toContain("arm a");
    expect(combined).not.toContain("arm b");
    expect(combined).not.toContain("injected");
    expect(combined).not.toContain("pointer block");
    expect(user).toContain("Response X:");
    expect(user).toContain("Response Y:");
  });
});

describe("computeQuartiles / bucketIndex", () => {
  it("computes cut points over a simple ascending set", () => {
    const q = computeQuartiles([10, 20, 30, 40]);
    expect(q[0]).toBeCloseTo(17.5, 5);
    expect(q[1]).toBeCloseTo(25, 5);
    expect(q[2]).toBeCloseTo(32.5, 5);
  });

  it("buckets values into 0..3 by the cut points", () => {
    const q = computeQuartiles([10, 20, 30, 40]);
    expect(bucketIndex(5, q)).toBe(0);
    expect(bucketIndex(20, q)).toBe(1);
    expect(bucketIndex(30, q)).toBe(2);
    expect(bucketIndex(100, q)).toBe(3);
  });

  it("handles an empty value set without throwing", () => {
    expect(computeQuartiles([])).toEqual([0, 0, 0]);
  });
});

describe("computeVerdict — pre-registered PASS/NULL/HARM gate", () => {
  function outcomes(armA: number, armB: number, tie: number) {
    return [
      ...Array.from({ length: armA }, () => ({ winner: "A" as const })),
      ...Array.from({ length: armB }, () => ({ winner: "B" as const })),
      ...Array.from({ length: tie }, () => ({ winner: "tie" as const })),
    ];
  }

  it("PASSes exactly at both boundaries: winRate 0.60, decisiveRate 0.30", () => {
    // n=100, decisive=30 (decisiveRate=0.30), armA=18 (winRate=18/30=0.60), armB=12 (share=0.40, not harm).
    const v = computeVerdict(outcomes(18, 12, 70));
    expect(v.decisiveRate).toBeCloseTo(GATE_THRESHOLDS.decisiveRatePass, 10);
    expect(v.winRate).toBeCloseTo(GATE_THRESHOLDS.winRatePass, 10);
    expect(v.armBShare).toBeCloseTo(GATE_THRESHOLDS.harmShare, 10);
    expect(v.harm).toBe(false);
    expect(v.verdict).toBe("PASS");
  });

  it("fails just under the winRate boundary (0.59)", () => {
    // decisive=100 for clean fractions: armA=59 -> winRate 0.59, decisiveRate 1.0.
    const v = computeVerdict(outcomes(59, 41, 0));
    expect(v.winRate).toBeCloseTo(0.59, 10);
    expect(v.verdict).toBe("NULL");
  });

  it("fails just under the decisiveRate boundary (0.29)", () => {
    // n=100, decisive=29, armA=29 (winRate=1.0, well above 0.6) but decisiveRate=0.29 < 0.30.
    const v = computeVerdict(outcomes(29, 0, 71));
    expect(v.decisiveRate).toBeCloseTo(0.29, 10);
    expect(v.winRate).toBeCloseTo(1.0, 10);
    expect(v.verdict).toBe("NULL");
  });

  it("does not flag HARM exactly at the 0.40 boundary", () => {
    const v = computeVerdict(outcomes(18, 12, 70)); // armBShare exactly 0.40
    expect(v.harm).toBe(false);
  });

  it("flags HARM just above the 0.40 boundary", () => {
    // decisive=100 clean fractions: armB=41 -> share 0.41 > 0.40.
    const v = computeVerdict(outcomes(59, 41, 0));
    expect(v.armBShare).toBeCloseTo(0.41, 10);
    expect(v.harm).toBe(true);
    expect(v.verdict).toBe("NULL");
  });

  it("HARM overrides an otherwise-passing winRate/decisiveRate", () => {
    // Construct decisive=100, armA=61 (winRate 0.61 >= 0.60), armB=39 (share 0.39, not harm) -> PASS.
    // Then flip one pair to push armB share just past 0.40 while winRate stays >= 0.60 is impossible
    // algebraically for two-outcome decisive sets (winRate + armBShare == 1), so HARM and PASS are
    // mutually exclusive by construction — this test locks that invariant.
    const passing = computeVerdict(outcomes(61, 39, 0));
    expect(passing.verdict).toBe("PASS");
    expect(passing.harm).toBe(false);
  });

  it("treats zero decisive pairs as NULL, not a divide-by-zero crash", () => {
    const v = computeVerdict(outcomes(0, 0, 42));
    expect(v.decisive).toBe(0);
    expect(v.decisiveRate).toBe(0);
    expect(v.winRate).toBe(0);
    expect(v.armBShare).toBe(0);
    expect(v.harm).toBe(false);
    expect(v.verdict).toBe("NULL");
  });

  it("treats zero total outcomes as NULL", () => {
    const v = computeVerdict([]);
    expect(v.verdict).toBe("NULL");
  });
});
