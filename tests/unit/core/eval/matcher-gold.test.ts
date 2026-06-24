import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreGold, sweepThresholds, loadGold } from "../../../../scripts/eval/lib/matcher-gold.js";

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "fixtures");

describe("scoreGold", () => {
  it("computes precision/recall from predicted vs gold workstream", () => {
    const m = scoreGold([
      { goldWorkstream: "NLM", predicted: "NLM", score: 0.9 },          // TP
      { goldWorkstream: "NLM", predicted: "Beacon", score: 0.8 },   // wrong bind (FP for Beacon, miss for NLM)
      { goldWorkstream: "NLM", predicted: null, score: 0.1 },           // create/no-bind (miss)
    ]);
    expect(m.total).toBe(3);
    expect(m.correct).toBe(1);
    expect(m.precision).toBeCloseTo(1 / 2); // 1 correct of 2 binds
    expect(m.recall).toBeCloseTo(1 / 3);    // 1 correct of 3 golds
  });

  it("handles all-null predictions (no binds)", () => {
    const m = scoreGold([
      { goldWorkstream: "NLM", predicted: null, score: 0.1 },
      { goldWorkstream: "NLM", predicted: null, score: 0.2 },
    ]);
    expect(m.binds).toBe(0);
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
  });
});

describe("sweepThresholds", () => {
  it("picks the highest cut that retains >= minRecall correct binds", () => {
    const scored = [
      { goldWorkstream: "A", predicted: "A", score: 0.9 },
      { goldWorkstream: "A", predicted: "A", score: 0.6 },
      { goldWorkstream: "B", predicted: "A", score: 0.5 }, // wrong, lower score
    ];
    const r = sweepThresholds(scored, 0.5);
    expect(r.high).toBeGreaterThan(0.5);
    expect(r.high).toBeLessThanOrEqual(0.9);
  });

  it("sets low a band below high", () => {
    const scored = [
      { goldWorkstream: "A", predicted: "A", score: 0.8 },
    ];
    const r = sweepThresholds(scored, 0.5);
    expect(r.low).toBeLessThan(r.high);
    expect(r.low).toBeGreaterThanOrEqual(0);
  });
});

describe("loadGold", () => {
  it("parses the synthetic fixture into GoldMatch rows", () => {
    const rows = loadGold(join(FIXTURES_DIR, "matcher-gold-sample.jsonl"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(typeof row.key).toBe("string");
      expect(typeof row.sessionId).toBe("string");
      expect(typeof row.goldWorkstream).toBe("string");
    }
  });
});
