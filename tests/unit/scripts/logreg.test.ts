import { describe, it, expect } from "vitest";
import { fitLogReg } from "../../../scripts/eval/lib/logreg.js";

describe("fitLogReg", () => {
  it("learns a separable boundary and returns standardisation stats", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = (i % 20) / 2, b = 100 + (i % 7);
      X.push([a, b]);
      y.push(a > 5 ? 1 : 0);
    }
    const m = fitLogReg(X, y, { l2: 0.01, iters: 3000, lr: 0.5 });
    expect(m.mean[0]).toBeCloseTo(4.75, 1);
    expect(m.weights[0]).toBeGreaterThan(1);
    expect(Math.abs(m.weights[1]!)).toBeLessThan(0.5);
  });

  it("refuses mismatched input", () => {
    expect(() => fitLogReg([[1]], [1, 0], { l2: 0, iters: 1, lr: 0.1 })).toThrow(/rows/);
  });
});
