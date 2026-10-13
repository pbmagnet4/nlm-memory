import { describe, it, expect } from "vitest";
import { recallGateQuestions } from "../../../scripts/eval/lib/clef-panels.js";
import { capState, triageQuestions } from "../../../src/core/classifier/triage-panel.js";
import { MAX_TRANSCRIPT_CHARS } from "../../../src/core/classifier/prompt.js";

describe("clef panels", () => {
  it("caps state at the classifier transcript cap and keeps head and tail", () => {
    const long = `HEAD ${"x".repeat(100_000)} TAIL`;
    const out = capState(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 200);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
  });

  it("builds one question per recall-gate variant", () => {
    expect(recallGateQuestions("noul")["q"]?.type).toBe("noul");
    expect(recallGateQuestions("noulCriteria")["q"]).toMatchObject({ type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } });
    const s = recallGateQuestions("score")["q"];
    expect(s?.type).toBe("score");
    expect(s?.type === "score" ? s.criteria.length : 0).toBe(4);
  });

  it("triage panel asks six typed questions in one call", () => {
    const q = triageQuestions();
    expect(Object.keys(q).sort()).toEqual(["abandoned", "decision", "failure", "importance", "kind", "unfinished"]);
    expect(q["kind"]?.type).toBe("choice");
    expect(q["importance"]?.type).toBe("score");
  });
});
