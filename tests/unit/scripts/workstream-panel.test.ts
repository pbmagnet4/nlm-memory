import { describe, it, expect } from "vitest";
import { workstreamQuestion, pickWorkstream, scoreWorkstreams } from "../../../scripts/eval/lib/workstream-panel.js";

describe("workstream panel", () => {
  it("keys options by index so duplicate labels stay distinct, plus none", () => {
    const q = workstreamQuestion(["NLM recall", "NLM recall", "Jobs bot"]);
    expect(q.type).toBe("choice");
    if (q.type !== "choice") return;
    expect(Object.keys(q.criteria)).toEqual(["w0", "w1", "w2", "none"]);
    expect(q.criteria.w1).toBe("NLM recall");
  });

  it("maps a confident choice to its id and abstains on none or low confidence", () => {
    const ids = ["ws_a", "ws_b"];
    const ans = (choice: string, confidence: number) => ({ type: "choice" as const, choice, confidence, probabilities: {} });
    expect(pickWorkstream(ans("w1", 0.9), ids, 0.5)).toBe("ws_b");
    expect(pickWorkstream(ans("none", 0.9), ids, 0.5)).toBeNull();
    expect(pickWorkstream(ans("w0", 0.3), ids, 0.5)).toBeNull();
    expect(() => pickWorkstream(ans("w7", 0.9), ids, 0.5)).toThrow(/w7/);
  });

  it("counts errors apart from wrong answers", () => {
    expect(scoreWorkstreams([
      { gold: "a", pred: "a" }, { gold: "a", pred: "b" }, { gold: "a", pred: null }, { gold: "a", pred: null, error: true },
    ])).toEqual({ n: 4, errors: 1, correct: 1, wrong: 1, abstained: 1 });
  });
});
