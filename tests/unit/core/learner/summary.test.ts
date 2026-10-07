// tests/unit/core/learner/summary.test.ts
import { describe, expect, it } from "vitest";
import { summarizeConcepts } from "../../../../src/core/learner/summary.js";
import type { Attempt, LearningEvent } from "../../../../src/core/learner/model.js";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    concept: "math.chain-rule",
    task: "Differentiate (3x+1)^2 and explain both factors.",
    response: "2(3x+1); forgot the inner rate.",
    result: "incorrect",
    help: "none",
    kind: "application",
    ...overrides,
  };
}

function event(
  id: string,
  date: string,
  partial: Partial<Pick<LearningEvent, "covered" | "attempts" | "interpretation" | "nextStep">> = {},
): LearningEvent {
  return {
    id,
    date,
    covered: ["math.chain-rule"],
    attempts: [],
    interpretation: "",
    nextStep: "Keep going.",
    createdAt: `${date}T00:00:00Z`,
    ...partial,
  };
}

function statusOf(concept: string, events: LearningEvent[]) {
  return summarizeConcepts(events).find((c) => c.concept === concept)!;
}

describe("summarizeConcepts", () => {
  it("returns [] for no events", () => {
    expect(summarizeConcepts([])).toEqual([]);
  });

  it("marks covered-never-attempted as exposed", () => {
    const [s] = summarizeConcepts([event("ev-1", "2026-01-15")]);
    expect(s).toMatchObject({
      concept: "math.chain-rule",
      status: "exposed",
      attemptCount: 0,
      latestDate: "2026-01-15",
      latestTask: null,
    });
  });

  it("marks latest-incorrect as practicing (Gnos chain-rule fixture)", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt()] }),
    ]);
    expect(s).toMatchObject({
      status: "practicing",
      attemptCount: 1,
      latestDate: "2026-01-15",
      latestTask: "Differentiate (3x+1)^2 and explain both factors.",
    });
  });

  it("marks latest-partial as practicing", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "partial" })] }),
    ]);
    expect(s.status).toBe("practicing");
  });

  it("marks assisted-correct as practicing", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct", help: "hint" })] }),
    ]);
    expect(s.status).toBe("practicing");
  });

  it("marks first unassisted-correct as demonstrated", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", {
        attempts: [attempt({ result: "correct", response: "6(3x+1), both factors explained." })],
      }),
    ]);
    expect(s.status).toBe("demonstrated");
  });

  it("keeps later unassisted application at demonstrated, not retained", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct" })] }),
      event("ev-2", "2026-01-20", { attempts: [attempt({ result: "correct", kind: "application" })] }),
    ]);
    expect(s.status).toBe("demonstrated");
  });

  it("promotes later unassisted retrieval to retained", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct" })] }),
      event("ev-2", "2026-01-20", { attempts: [attempt({ result: "correct", kind: "retrieval" })] }),
    ]);
    expect(s).toMatchObject({ status: "retained", attemptCount: 2 });
  });

  it("promotes later unassisted transfer to retained", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct" })] }),
      event("ev-2", "2026-01-20", { attempts: [attempt({ result: "correct", kind: "transfer" })] }),
    ]);
    expect(s.status).toBe("retained");
  });

  it("requires a strictly later date for retained", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct" })] }),
      event("ev-2", "2026-01-15", { attempts: [attempt({ result: "correct", kind: "retrieval" })] }),
    ]);
    expect(s.status).toBe("demonstrated");
  });

  it("demotes to practicing on a later failure", () => {
    const s = statusOf("math.chain-rule", [
      event("ev-1", "2026-01-15", { attempts: [attempt({ result: "correct" })] }),
      event("ev-2", "2026-01-20", { attempts: [attempt({ result: "incorrect" })] }),
    ]);
    expect(s).toMatchObject({ status: "practicing", attemptCount: 2 });
  });

  it("tracks concepts independently and sorts by concept", () => {
    const summaries = summarizeConcepts([
      event("ev-1", "2026-01-15", {
        covered: ["math.chain-rule", "math.power-rule"],
        attempts: [
          attempt({ concept: "math.chain-rule", result: "correct" }),
          attempt({ concept: "math.power-rule", result: "incorrect" }),
        ],
      }),
    ]);
    expect(summaries.map((s) => [s.concept, s.status])).toEqual([
      ["math.chain-rule", "demonstrated"],
      ["math.power-rule", "practicing"],
    ]);
  });

  it("tracks attempted-but-never-covered concepts", () => {
    const s = statusOf("math.product-rule", [
      event("ev-1", "2026-01-15", {
        covered: ["math.chain-rule"],
        attempts: [attempt({ concept: "math.product-rule", result: "correct" })],
      }),
    ]);
    expect(s.status).toBe("demonstrated");
  });
});
