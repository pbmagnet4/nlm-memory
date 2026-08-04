import { describe, expect, it } from "vitest";
import {
  buildJudgePrompt,
  isPositive,
  parseVerdict,
  RUBRIC_SYSTEM,
  VERDICT_LABELS,
  type SampleRow,
} from "../../../scripts/eval/lib/re-derivation-rubric.js";

const row: SampleRow = {
  pairId: "cc_sub_a1|cc_sub_b2",
  a: {
    label: "Review of workstream filter",
    startedAt: "2026-06-24T20:17:43.897Z",
    decisions: ["Task 6 approved"],
    excerpt: "reviewed task 6 and approved it",
  },
  b: {
    label: "Review of Task 6",
    startedAt: "2026-07-02T20:23:58.742Z",
    decisions: ["Approved Task 6"],
    excerpt: "reviewed task 6 again",
  },
};

describe("buildJudgePrompt", () => {
  const prompt = buildJudgePrompt(row);

  it("leaks no detector feature to the judge", () => {
    for (const banned of ["accard", "cosine", "stratum", "sizeTercile", "subagent", "0.97"]) {
      expect(prompt.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("omits session ids, which would leak the subagent flag via the cc_sub_ prefix", () => {
    expect(prompt).not.toContain("cc_sub_");
    expect(prompt).not.toContain(row.pairId);
  });

  it("includes both sides' dates, labels and decisions", () => {
    expect(prompt).toContain("2026-06-24");
    expect(prompt).toContain("2026-07-02");
    expect(prompt).toContain("Review of Task 6");
    expect(prompt).toContain("Task 6 approved");
    expect(prompt).toContain("Approved Task 6");
  });

  it("presents the earlier session first", () => {
    expect(prompt.indexOf("2026-06-24")).toBeLessThan(prompt.indexOf("2026-07-02"));
  });

  it("renders a side with no decisions without emitting an empty bullet list", () => {
    const bare = buildJudgePrompt({
      ...row,
      b: { ...row.b, decisions: [] },
    });
    expect(bare).toContain("(none recorded)");
  });
});

describe("RUBRIC_SYSTEM", () => {
  it("names every label the parser accepts", () => {
    for (const l of VERDICT_LABELS) expect(RUBRIC_SYSTEM).toContain(l);
  });

  it("warns against the ritual failure mode, which is the dominant one", () => {
    expect(RUBRIC_SYSTEM).toContain("RITUAL");
    expect(RUBRIC_SYSTEM.toLowerCase()).toContain("prefer ritual over genuine");
  });

  it("states that GENUINE is the only positive", () => {
    expect(RUBRIC_SYSTEM).toContain("ONLY positive");
  });
});

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"label":"GENUINE","confidence":0.8,"reason":"same call re-made"}')).toEqual({
      label: "GENUINE",
      confidence: 0.8,
      reason: "same call re-made",
    });
  });

  it("tolerates a fenced code block", () => {
    expect(parseVerdict('```json\n{"label":"RITUAL","confidence":0.9,"reason":"r"}\n```')?.label).toBe(
      "RITUAL",
    );
  });

  it("tolerates prose around the object", () => {
    expect(
      parseVerdict('Here is my verdict: {"label":"DUPLICATE","confidence":0.5,"reason":"r"} done.')
        ?.label,
    ).toBe("DUPLICATE");
  });

  it("normalises spacing and hyphens in a label", () => {
    expect(parseVerdict('{"label":"same topic different decision","confidence":1,"reason":"r"}')?.label)
      .toBe("SAME_TOPIC_DIFFERENT_DECISION");
  });

  it("returns null on an unknown label rather than coercing it", () => {
    expect(parseVerdict('{"label":"MAYBE","confidence":1,"reason":"r"}')).toBeNull();
  });

  it("returns null on unparseable output", () => {
    expect(parseVerdict("I think this is a re-derivation.")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict('{"label":')).toBeNull();
  });

  it("clamps confidence into [0,1] and survives a missing or non-numeric one", () => {
    expect(parseVerdict('{"label":"GENUINE","confidence":5,"reason":"r"}')?.confidence).toBe(1);
    expect(parseVerdict('{"label":"GENUINE","confidence":-2,"reason":"r"}')?.confidence).toBe(0);
    expect(parseVerdict('{"label":"GENUINE","reason":"r"}')?.confidence).toBe(0);
  });
});

describe("UNRELATED", () => {
  it("is a distinct label so the report can separate unrelated work from same-topic", () => {
    expect(VERDICT_LABELS).toContain("UNRELATED");
    expect(RUBRIC_SYSTEM).toContain("rather than SAME_TOPIC_DIFFERENT_DECISION");
  });

  it("parses", () => {
    expect(parseVerdict('{"label":"UNRELATED","confidence":0.9,"reason":"r"}')?.label).toBe(
      "UNRELATED",
    );
  });
});

describe("isPositive", () => {
  it("counts only GENUINE as positive", () => {
    for (const l of VERDICT_LABELS) {
      expect(isPositive({ label: l, confidence: 1, reason: "" })).toBe(l === "GENUINE");
    }
  });
});
