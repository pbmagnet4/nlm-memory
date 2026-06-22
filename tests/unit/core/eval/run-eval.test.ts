import { describe, it, expect } from "vitest";
import { runEval } from "@core/eval/run-eval.js";

describe("runEval", () => {
  it("computes R@1, R@5 and MRR over a query set", async () => {
    const recall = {
      search: async ({ query }: { query: string }) => ({
        total: 2,
        results: query === "alpha" ? [{ id: "s1" }, { id: "s9" }] : [{ id: "s9" }, { id: "s2" }],
      }),
    };
    const report = await runEval(
      { recall } as never,
      [
        { query: "alpha", expectedIds: ["s1"] }, // gold at rank 1
        { query: "beta", expectedIds: ["s2"] },  // gold at rank 2
      ],
      { mode: "keyword", k: 5 },
    );
    expect(report.n).toBe(2);
    expect(report.rAt1).toBeCloseTo(0.5);
    expect(report.rAt5).toBeCloseTo(1.0);
    expect(report.mrr).toBeCloseTo((1 + 0.5) / 2);
  });

  it("records misses with the ids that were returned", async () => {
    const recall = {
      search: async () => ({ total: 1, results: [{ id: "x" }] }),
    };
    const report = await runEval(
      { recall } as never,
      [{ query: "q", expectedIds: ["gold"] }],
      { mode: "keyword", k: 5 },
    );
    expect(report.rAt5).toBeCloseTo(0);
    expect(report.misses).toEqual([{ query: "q", expected: ["gold"], got: ["x"] }]);
  });
});
