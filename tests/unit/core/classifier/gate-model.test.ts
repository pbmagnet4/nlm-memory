import { describe, it, expect } from "vitest";
import { GATE_FEATURES, gateFeatures, gateProbability } from "@core/classifier/gate-model.js";
import type { ClefAnswer } from "../../../../src/llm/clef-client.js";

const score = (s: number, p: [number, number, number, number]): ClefAnswer =>
  ({ type: "score", score: s, confidence: Math.max(...p), probabilities: { "0": p[0], "1": p[1], "2": p[2], "3": p[3] }, legend: {} });
const noul = (n: number): ClefAnswer => ({ type: "noul", noul: n });
const answers: Record<string, ClefAnswer> = {
  kind: { type: "choice", choice: "coding", confidence: 0.7, probabilities: { coding: 0.7, ops: 0.1, research: 0.1, meeting: 0.05, trivial: 0.05 } },
  importance: score(1.5, [0.1, 0.4, 0.4, 0.1]),
  extractable: score(0.6, [0.5, 0.4, 0.1, 0]),
  decision: noul(0.2), abandoned: noul(0.3), failure: noul(0.4), unfinished: noul(0.5),
  facts: noul(0.6), outcome: noul(0.7), delegated: noul(0.8),
};

describe("gate model", () => {
  it("maps answers and length to the feature vector in GATE_FEATURES order", () => {
    const x = gateFeatures(answers, 1000);
    expect(x).toHaveLength(GATE_FEATURES.length);
    const f = Object.fromEntries(GATE_FEATURES.map((n, i) => [n, x[i]]));
    const want = { importance: 0.5, importance_p0: 0.1, extractable: 0.2, extractable_p0: 0.5, kind_trivial: 0.05,
      kind_coding: 0.7, decision: 0.2, facts: 0.6, delegated: 0.8, log_chars: 3 };
    for (const [k, v] of Object.entries(want)) expect(f[k]).toBeCloseTo(v);
  });

  it("throws when an answer is missing or the wrong type", () => {
    const { facts: _drop, ...missing } = answers;
    expect(() => gateFeatures(missing, 10)).toThrow(/facts/);
    expect(() => gateFeatures({ ...answers, importance: noul(0.5) }, 10)).toThrow(/importance/);
  });

  it("applies standardisation, weights and bias through a sigmoid", () => {
    const n = GATE_FEATURES.length;
    const model = { mean: Array(n).fill(0), std: Array(n).fill(1), weights: Array(n).fill(0), bias: 0, threshold: 0.5 };
    expect(gateProbability(model, Array(n).fill(3))).toBeCloseTo(0.5);
    const w = Array(n).fill(0); w[0] = 2;
    expect(gateProbability({ ...model, weights: w, mean: Array(n).fill(1) }, [2, ...Array(n - 1).fill(0)])).toBeCloseTo(1 / (1 + Math.exp(-2)));
  });
});
