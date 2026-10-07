// tests/unit/core/learner/validate.test.ts
import { describe, expect, it } from "vitest";
import {
  assertValidEnrollmentInput,
  assertValidEventInput,
  assertValidLearnerInit,
} from "../../../../src/core/learner/validate.js";
import type { LearningEventInput } from "../../../../src/ports/learner-store.js";

function validEvent(): LearningEventInput {
  return {
    id: "2026-01-15-chain-rule-1",
    date: "2026-01-15",
    covered: ["math.chain-rule"],
    attempts: [
      {
        concept: "math.chain-rule",
        task: "Differentiate (3x+1)^2.",
        response: "2(3x+1); forgot the inner rate.",
        result: "incorrect",
        help: "none",
        kind: "application",
      },
    ],
    interpretation: "Can apply the outer rule; inner rate needs a concrete comparison.",
    nextStep: "Compare u=3x+1 and y=u^2.",
  };
}

describe("assertValidEventInput", () => {
  it("accepts the Gnos chain-rule fixture", () => {
    expect(() => assertValidEventInput(validEvent())).not.toThrow();
  });

  it("accepts empty attempts and empty interpretation", () => {
    expect(() =>
      assertValidEventInput({ ...validEvent(), attempts: [], interpretation: "" }),
    ).not.toThrow();
  });

  it.each([["Alex"], ["has space"], ["under_score"], ["x".repeat(81)], [""]])(
    "rejects bad event id %p",
    (id) => {
      expect(() => assertValidEventInput({ ...validEvent(), id })).toThrow(/slug/);
    },
  );

  it.each([["2026-13-01"], ["2026-02-30"], ["01/15/2026"], ["2999-01-01"], ["not-a-date"]])(
    "rejects bad date %p",
    (date) => {
      expect(() => assertValidEventInput({ ...validEvent(), date })).toThrow();
    },
  );

  it.each([["no-dot"], ["UPPER.x"], [""]])("rejects bad concept %p", (concept) => {
    expect(() =>
      assertValidEventInput({ ...validEvent(), covered: [concept] }),
    ).toThrow(/concept/);
  });

  it("rejects empty task, response, and nextStep", () => {
    const base = validEvent();
    const att = base.attempts[0]!;
    expect(() =>
      assertValidEventInput({ ...base, attempts: [{ ...att, task: "  " }] }),
    ).toThrow(/task/);
    expect(() =>
      assertValidEventInput({ ...base, attempts: [{ ...att, response: "" }] }),
    ).toThrow(/response/);
    expect(() => assertValidEventInput({ ...base, nextStep: "" })).toThrow(/nextStep/);
  });

  it("rejects bad attempt enums", () => {
    const base = validEvent();
    const att = base.attempts[0]!;
    expect(() =>
      assertValidEventInput({
        ...base,
        attempts: [{ ...att, result: "wrong" as unknown as "correct" }],
      }),
    ).toThrow(/result/);
    expect(() =>
      assertValidEventInput({
        ...base,
        attempts: [{ ...att, help: "peek" as unknown as "none" }],
      }),
    ).toThrow(/help/);
    expect(() =>
      assertValidEventInput({
        ...base,
        attempts: [{ ...att, kind: "vibes" as unknown as "application" }],
      }),
    ).toThrow(/kind/);
  });
});

describe("assertValidEnrollmentInput", () => {
  const base = {
    learnerId: "alex",
    courseId: "calculus",
    workstreamId: "ws_1",
    planRef: "courses/calculus/course.json",
    planRevision: 2,
    planFingerprint: "fp-abc",
  };

  it("accepts a valid enrollment", () => {
    expect(() => assertValidEnrollmentInput(base)).not.toThrow();
  });

  it("rejects non-positive or non-integer revisions", () => {
    expect(() => assertValidEnrollmentInput({ ...base, planRevision: 0 })).toThrow(/Revision|revision/);
    expect(() => assertValidEnrollmentInput({ ...base, planRevision: 1.5 })).toThrow(/Revision|revision/);
  });

  it("rejects empty plan ref and fingerprint", () => {
    expect(() => assertValidEnrollmentInput({ ...base, planRef: "" })).toThrow(/planRef/);
    expect(() => assertValidEnrollmentInput({ ...base, planFingerprint: "" })).toThrow(/planFingerprint/);
  });

  it("rejects bad slugs", () => {
    expect(() => assertValidEnrollmentInput({ ...base, learnerId: "Alex" })).toThrow(/slug/);
    expect(() => assertValidEnrollmentInput({ ...base, courseId: "calc 101" })).toThrow(/slug/);
  });
});

describe("assertValidLearnerInit", () => {
  it("accepts a valid init and rejects bad id/label", () => {
    expect(() => assertValidLearnerInit({ id: "alex", label: "Alex" })).not.toThrow();
    expect(() => assertValidLearnerInit({ id: "Alex", label: "Alex" })).toThrow(/slug/);
    expect(() => assertValidLearnerInit({ id: "alex", label: "  " })).toThrow(/label/);
  });
});
