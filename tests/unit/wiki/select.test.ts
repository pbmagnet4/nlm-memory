import { describe, it, expect } from "vitest";
import { selectSubjects } from "@core/wiki/select.js";
import type { WikiConfig } from "@core/wiki/types.js";

const config: WikiConfig = { minFacts: 3, minSessions: 3, linkBase: "http://127.0.0.1:3940" };

describe("selectSubjects", () => {
  it("keeps a subject meeting both thresholds", () => {
    const out = selectSubjects([{ subject: "a", factCount: 3, sessionCount: 3 }], config);
    expect(out.map((s) => s.subject)).toEqual(["a"]);
  });

  it("drops a subject with enough facts but too few sessions", () => {
    const out = selectSubjects([{ subject: "a", factCount: 9, sessionCount: 2 }], config);
    expect(out).toEqual([]);
  });

  it("drops a subject with enough sessions but too few facts", () => {
    const out = selectSubjects([{ subject: "a", factCount: 2, sessionCount: 7 }], config);
    expect(out).toEqual([]);
  });

  it("orders by fact count descending then subject ascending", () => {
    const out = selectSubjects(
      [
        { subject: "c", factCount: 5, sessionCount: 3 },
        { subject: "a", factCount: 9, sessionCount: 4 },
        { subject: "b", factCount: 5, sessionCount: 3 },
      ],
      config,
    );
    expect(out.map((s) => s.subject)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for an empty corpus", () => {
    expect(selectSubjects([], config)).toEqual([]);
  });

  it("honours lowered thresholds", () => {
    const out = selectSubjects([{ subject: "a", factCount: 1, sessionCount: 1 }], {
      ...config,
      minFacts: 1,
      minSessions: 1,
    });
    expect(out.map((s) => s.subject)).toEqual(["a"]);
  });
});
