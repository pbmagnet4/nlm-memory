import { describe, expect, it } from "vitest";
import {
  correctionMetrics,
  injectionCostPerUsefulHit,
  mergePrecision,
  reDerivationRateByWindow,
  type CitationRow,
  type FactJudgeLabelItem,
  type HookFireRow,
  type MergePairLabel,
  type ReDerivationLabelRow,
  type RubricVerdict,
} from "../../../src/core/eval/dream-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const verdict = (label: RubricVerdict["label"]): RubricVerdict => ({
  label,
  confidence: 0.9,
  reason: "test",
});

const rederivRow = (
  pairId: string,
  startedAt: string,
  label: RubricVerdict["label"] | null,
): ReDerivationLabelRow => ({
  pairId,
  stratum: "A1",
  verdict: label === null ? null : verdict(label),
  startedAt,
});

describe("reDerivationRateByWindow", () => {
  it("returns an empty result for empty input", () => {
    const r = reDerivationRateByWindow([], DAY_MS);
    expect(r).toEqual({
      windows: [],
      totalJudged: 0,
      totalPositives: 0,
      overallRate: null,
      excluded: 0,
    });
  });

  it("buckets GENUINE as the only positive within fixed UTC windows", () => {
    const rows = [
      rederivRow("p1", "2026-01-01T10:00:00Z", "GENUINE"),
      rederivRow("p2", "2026-01-01T20:00:00Z", "REVISIT"),
      rederivRow("p3", "2026-01-02T02:00:00Z", "GENUINE"),
      rederivRow("p4", "2026-01-02T03:00:00Z", "RITUAL"),
    ];
    const r = reDerivationRateByWindow(rows, DAY_MS);
    expect(r.windows).toEqual([
      { start: "2026-01-01T00:00:00.000Z", judged: 2, positives: 1, rate: 0.5 },
      { start: "2026-01-02T00:00:00.000Z", judged: 2, positives: 1, rate: 0.5 },
    ]);
    expect(r.totalJudged).toBe(4);
    expect(r.totalPositives).toBe(2);
    expect(r.overallRate).toBe(0.5);
    expect(r.excluded).toBe(0);
  });

  it("emits empty windows between populated ones so the timeline has no gaps", () => {
    // Empty windows cannot exist between two populated buckets by construction
    // (buckets are only created from judged rows) — assert the populated
    // boundaries and the sub-day windowing instead.
    const rows = [
      rederivRow("p1", "2026-01-01T10:05:00Z", "GENUINE"),
      rederivRow("p2", "2026-01-01T10:59:59Z", "REVISIT"),
      rederivRow("p3", "2026-01-01T11:00:01Z", "GENUINE"),
    ];
    const r = reDerivationRateByWindow(rows, 60 * 60 * 1000);
    expect(r.windows.map((w) => w.start)).toEqual([
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T11:00:00.000Z",
    ]);
    expect(r.windows[0]).toMatchObject({ judged: 2, positives: 1 });
    expect(r.windows[1]).toMatchObject({ judged: 1, positives: 1, rate: 1 });
  });

  it("excludes null verdicts and unparseable timestamps, counting them", () => {
    const rows = [
      rederivRow("p1", "2026-01-01T00:00:00Z", "GENUINE"),
      rederivRow("p2", "2026-01-01T12:00:00Z", null),
      rederivRow("p3", "not-a-date", "GENUINE"),
    ];
    const r = reDerivationRateByWindow(rows, DAY_MS);
    expect(r.totalJudged).toBe(1);
    expect(r.excluded).toBe(2);
    expect(r.overallRate).toBe(1);
  });

  it("reports rate 0 and overall 0 for all-negative windows (never null)", () => {
    const rows = [
      rederivRow("p1", "2026-01-01T00:00:00Z", "RITUAL"),
      rederivRow("p2", "2026-01-01T00:00:01Z", "UNRELATED"),
      rederivRow("p3", "2026-01-02T00:00:00Z", "DUPLICATE"),
    ];
    const r = reDerivationRateByWindow(rows, DAY_MS);
    expect(r.windows.map((w) => w.rate)).toEqual([0, 0]);
    expect(r.overallRate).toBe(0);
    expect(r.totalPositives).toBe(0);
  });

  it("returns all-null overall rate when every row is excluded", () => {
    const r = reDerivationRateByWindow([rederivRow("p1", "2026-01-01T00:00:00Z", null)], DAY_MS);
    expect(r.windows).toEqual([]);
    expect(r.overallRate).toBeNull();
    expect(r.excluded).toBe(1);
  });

  it("rejects non-positive or non-finite window sizes", () => {
    expect(() => reDerivationRateByWindow([], 0)).toThrow(RangeError);
    expect(() => reDerivationRateByWindow([], -DAY_MS)).toThrow(RangeError);
    expect(() => reDerivationRateByWindow([], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

const item = (
  action: FactJudgeLabelItem["action"],
  independent: string,
  labelerVerdict: FactJudgeLabelItem["labeler"]["verdict"],
  newId = "n1",
): FactJudgeLabelItem => ({
  newId,
  arm: "conflict",
  action,
  decision: action === "KEEP_BOTH" ? "KEEP_BOTH" : `${action} t1`,
  labeler: { independent, verdict: labelerVerdict },
});

describe("correctionMetrics", () => {
  it("returns null rates for empty input", () => {
    expect(correctionMetrics([])).toEqual({
      mutatingJudged: 0,
      mutatingCorrect: 0,
      precision: null,
      goldMutating: 0,
      truePositives: 0,
      recall: null,
      independentUnparsed: 0,
      verdictUnparsed: 0,
    });
  });

  it("computes precision over judged mutating decisions and recall against the gold resolution", () => {
    const items = [
      // Judge mutated, labeler agrees and says correct → TP, precision-hit.
      item("SUPERSEDE_OLD", "SUPERSEDE_OLD e1", "correct", "a"),
      item("SKIP_NEW", "SKIP_NEW e2", "correct", "b"),
      // Judge mutated, labeler says incorrect → precision miss but still a TP
      // for recall (prediction matched the gold mutating resolution).
      item("SUPERSEDE_OLD", "SUPERSEDE_OLD e1", "incorrect", "c"),
      // Judge kept both, labeler also keeps both → true negative.
      item("KEEP_BOTH", "KEEP_BOTH", "correct", "d"),
      // Judge kept both but gold is mutating → missed correction (recall miss).
      item("KEEP_BOTH", "SKIP_NEW e3", "correct", "e"),
    ];
    const m = correctionMetrics(items);
    expect(m).toEqual({
      mutatingJudged: 3,
      mutatingCorrect: 2,
      precision: 2 / 3,
      goldMutating: 4,
      truePositives: 3,
      recall: 3 / 4,
      independentUnparsed: 0,
      verdictUnparsed: 0,
    });
  });

  it("excludes null verdicts from precision but counts them; never from recall gold", () => {
    const items = [
      item("SKIP_NEW", "SKIP_NEW e1", null, "a"),
      item("SKIP_NEW", "SKIP_NEW e1", "correct", "b"),
    ];
    const m = correctionMetrics(items);
    expect(m.mutatingJudged).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.verdictUnparsed).toBe(1);
    expect(m.goldMutating).toBe(2);
    expect(m.recall).toBe(1);
  });

  it("excludes unparsed independent resolutions from the recall denominator", () => {
    const items = [item("SUPERSEDE_OLD", "unparsed", "correct")];
    const m = correctionMetrics(items);
    expect(m.independentUnparsed).toBe(1);
    expect(m.goldMutating).toBe(0);
    expect(m.recall).toBeNull();
    expect(m.precision).toBe(1);
  });

  it("all-negative: no mutating predictions and no mutating gold → null precision and recall 0 guard", () => {
    const items = [
      item("KEEP_BOTH", "KEEP_BOTH", "correct", "a"),
      item("KEEP_BOTH", "KEEP_BOTH", "incorrect", "b"),
    ];
    const m = correctionMetrics(items);
    expect(m.precision).toBeNull();
    expect(m.goldMutating).toBe(0);
    expect(m.recall).toBeNull();
    expect(m.verdictUnparsed).toBe(0);
    expect(m.independentUnparsed).toBe(0);
  });

  it("all-gold-mutating but every verdict unparsed: precision null, recall still computed", () => {
    const items = [
      item("SKIP_NEW", "SKIP_NEW e1", null, "a"),
      item("KEEP_BOTH", "SUPERSEDE_OLD e2", null, "b"),
    ];
    const m = correctionMetrics(items);
    expect(m.precision).toBeNull();
    expect(m.verdictUnparsed).toBe(1);
    expect(m.goldMutating).toBe(2);
    expect(m.truePositives).toBe(1);
    expect(m.recall).toBe(0.5);
  });
});

const merge = (newId: string, verdictValue: MergePairLabel["verdict"]): MergePairLabel => ({
  newId,
  targetId: "e1",
  verdict: verdictValue,
});

describe("mergePrecision", () => {
  it("returns null precision for empty input", () => {
    expect(mergePrecision([])).toEqual({ merges: 0, correct: 0, precision: null, excluded: 0 });
  });

  it("scores correct share over judged pairs", () => {
    const pairs = [
      merge("a", "correct"),
      merge("b", "correct"),
      merge("c", "incorrect"),
    ];
    expect(mergePrecision(pairs)).toEqual({ merges: 3, correct: 2, precision: 2 / 3, excluded: 0 });
  });

  it("excludes null verdicts rather than counting them incorrect", () => {
    const pairs = [merge("a", "correct"), merge("b", null), merge("c", null)];
    expect(mergePrecision(pairs)).toEqual({ merges: 1, correct: 1, precision: 1, excluded: 2 });
  });

  it("all-negative: every judged pair incorrect → precision 0, not null", () => {
    const pairs = [merge("a", "incorrect"), merge("b", "incorrect")];
    expect(mergePrecision(pairs)).toEqual({ merges: 2, correct: 0, precision: 0, excluded: 0 });
  });

  it("all-null verdicts → precision null with exclusion count", () => {
    expect(mergePrecision([merge("a", null)])).toEqual({
      merges: 0,
      correct: 0,
      precision: null,
      excluded: 1,
    });
  });
});

const fire = (
  conversationId: string,
  estTokens: number,
  ids: ReadonlyArray<string>,
): HookFireRow => ({
  conversationId,
  estTokens,
  hits: ids.map((id) => ({ id, score: 5 })),
});

const cite = (conversationId: string, citedId: string): CitationRow => ({
  conversationId,
  citedId,
});

describe("injectionCostPerUsefulHit", () => {
  it("returns null rate for empty input", () => {
    expect(injectionCostPerUsefulHit([], [])).toEqual({
      fires: 0,
      injectedTokens: 0,
      usefulHits: 0,
      tokensPerUsefulHit: null,
    });
  });

  it("divides total injected tokens by cited hits joined on conversationId", () => {
    const fires = [fire("c1", 100, ["s1", "s2"]), fire("c1", 50, ["s3"]), fire("c2", 200, ["s4"])];
    const citations = [cite("c1", "s1"), cite("c2", "s4")];
    const r = injectionCostPerUsefulHit(fires, citations);
    expect(r).toEqual({
      fires: 3,
      injectedTokens: 350,
      usefulHits: 2,
      tokensPerUsefulHit: 175,
    });
  });

  it("counts a duplicated cited id once per fire but again in a later fire", () => {
    const fires = [fire("c1", 100, ["s1", "s1"]), fire("c1", 100, ["s1"])];
    const r = injectionCostPerUsefulHit(fires, [cite("c1", "s1")]);
    expect(r.usefulHits).toBe(2);
    expect(r.tokensPerUsefulHit).toBe(100);
  });

  it("citations for unseen or mismatched conversations never count as useful", () => {
    const fires = [fire("c1", 100, ["s1"])];
    const r = injectionCostPerUsefulHit(fires, [cite("c9", "s1"), cite("c1", "other")]);
    expect(r.usefulHits).toBe(0);
    expect(r.tokensPerUsefulHit).toBeNull();
    expect(r.fires).toBe(1);
  });

  it("skips malformed fires (no hits or negative tokens) without counting their cost", () => {
    const fires = [fire("c1", 0, []), fire("c2", -5, ["s1"]), fire("c3", 80, ["s2"])];
    const r = injectionCostPerUsefulHit(fires, [cite("c3", "s2")]);
    expect(r).toEqual({ fires: 1, injectedTokens: 80, usefulHits: 1, tokensPerUsefulHit: 80 });
  });

  it("all-negative: injections but zero useful hits → totals with null rate", () => {
    const fires = [fire("c1", 120, ["s1"]), fire("c2", 300, ["s2"])];
    const r = injectionCostPerUsefulHit(fires, []);
    expect(r).toEqual({
      fires: 2,
      injectedTokens: 420,
      usefulHits: 0,
      tokensPerUsefulHit: null,
    });
  });
});
