// tests/unit/core/recall/related-concepts.test.ts
import { describe, expect, it } from "vitest";
import { pickRelatedConcepts } from "../../../../src/core/recall/related-concepts.js";
import type { LearnerStore } from "../../../../src/ports/learner-store.js";
import type { Enrollment, LearningEvent } from "../../../../src/core/learner/model.js";
import type { RecallHit } from "../../../../src/shared/types.js";

const hit = (id: string): RecallHit => ({ id }) as RecallHit;

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    id: "enr_1", learnerId: "alex", courseId: "calculus", workstreamId: "ws_1",
    planRef: "p", planRevision: 1, planFingerprint: "fp",
    status: "active", completionHistory: [], createdAt: "t", updatedAt: "t",
    ...overrides,
  };
}

function learningEvent(id: string, date: string, concept: string, nextStep = "Next."): LearningEvent {
  return {
    id, date, covered: [concept], attempts: [],
    interpretation: "", nextStep, createdAt: `${date}T00:00:00Z`,
  };
}

function deps(opts: {
  workstreams?: Map<string, string | null>;
  enrollments?: Enrollment[];
  events?: LearningEvent[];
}): { learners: LearnerStore; sessions: { getWorkstreamIds: (t: string, ids: ReadonlyArray<string>) => Promise<Map<string, string | null>> } } {
  return {
    learners: {
      listEnrollmentsByWorkstreams: async () => opts.enrollments ?? [],
      listEvents: async () => opts.events ?? [],
    } as unknown as LearnerStore,
    sessions: {
      getWorkstreamIds: async () => opts.workstreams ?? new Map(),
    },
  };
}

describe("pickRelatedConcepts", () => {
  it("returns [] for no hits", async () => {
    expect(await pickRelatedConcepts("t", [], deps({}))).toEqual([]);
  });

  it("returns [] when hits have no workstream", async () => {
    const rows = await pickRelatedConcepts("t", [hit("s1")], deps({
      workstreams: new Map([["s1", null]]),
    }));
    expect(rows).toEqual([]);
  });

  it("returns [] when no active enrollment matches", async () => {
    const rows = await pickRelatedConcepts("t", [hit("s1")], deps({
      workstreams: new Map([["s1", "ws_1"]]),
      enrollments: [enrollment({ status: "completed" })],
    }));
    expect(rows).toEqual([]);
  });

  it("ranks practicing first and carries the enrollment next step", async () => {
    const rows = await pickRelatedConcepts("t", [hit("s1")], deps({
      workstreams: new Map([["s1", "ws_1"]]),
      enrollments: [enrollment()],
      events: [
        {
          ...learningEvent("ev-1", "2026-01-15", "math.chain-rule", "Compare u=3x+1."),
          attempts: [{
            concept: "math.chain-rule", task: "t", response: "r",
            result: "correct", help: "none", kind: "application",
          }],
        },
        {
          ...learningEvent("ev-2", "2026-01-16", "math.product-rule", "Compare u=3x+1."),
          attempts: [{
            concept: "math.product-rule", task: "t", response: "r",
            result: "incorrect", help: "none", kind: "application",
          }],
        },
      ],
    }));
    expect(rows.map((r) => [r.concept, r.status])).toEqual([
      ["math.product-rule", "practicing"],
      ["math.chain-rule", "demonstrated"],
    ]);
    expect(rows[0]!.nextStep).toBe("Compare u=3x+1.");
    expect(rows[0]!.attemptCount).toBe(1);
  });

  it("caps rows at the limit", async () => {
    const events = ["a", "b", "c"].map((c, i) =>
      learningEvent(`ev-${i}`, "2026-01-15", `math.${c}`),
    );
    const rows = await pickRelatedConcepts("t", [hit("s1")], deps({
      workstreams: new Map([["s1", "ws_1"]]),
      enrollments: [enrollment()],
      events,
    }), { limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it("fails open on store errors", async () => {
    const broken = {
      learners: {
        listEnrollmentsByWorkstreams: async () => { throw new Error("db down"); },
        listEvents: async () => [],
      } as unknown as LearnerStore,
      sessions: { getWorkstreamIds: async () => new Map([["s1", "ws_1"]]) },
    };
    expect(await pickRelatedConcepts("t", [hit("s1")], broken)).toEqual([]);
  });
});
