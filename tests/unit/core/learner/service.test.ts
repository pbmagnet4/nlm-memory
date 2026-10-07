// tests/unit/core/learner/service.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import type {
  EnrollmentInput,
  LearnerInit,
  LearnerStore,
  LearningEventInput,
  RecordResult,
} from "../../../../src/ports/learner-store.js";
import type {
  Enrollment,
  Learner,
  LearningEvent,
} from "../../../../src/core/learner/model.js";
import {
  completeLearnerCourse,
  enrollCourse,
  getCourseSummary,
  recordLearningEvent,
  type LearnerServiceDeps,
} from "../../../../src/core/learner/service.js";

/** Minimal in-memory LearnerStore: orchestration only, store semantics live in the contract suite. */
class FakeLearnerStore implements LearnerStore {
  readonly learners = new Map<string, Learner>();
  readonly enrollments = new Map<string, Enrollment>();
  readonly events = new Map<string, LearningEvent[]>();
  readonly calls: string[] = [];

  async initLearner(_t: string, input: LearnerInit): Promise<void> {
    this.calls.push("initLearner");
    this.learners.set(input.id, {
      id: input.id, label: input.label, profile: input.profile ?? {},
      createdAt: "t", updatedAt: "t",
    });
  }

  async getLearner(_t: string, id: string): Promise<Learner | null> {
    return this.learners.get(id) ?? null;
  }

  async enroll(_t: string, input: EnrollmentInput): Promise<Enrollment> {
    this.calls.push("enroll");
    const key = `${input.learnerId}/${input.courseId}`;
    const existing = this.enrollments.get(key);
    if (existing) return existing;
    const enrollment: Enrollment = {
      id: `enr_${key}`, learnerId: input.learnerId, courseId: input.courseId,
      workstreamId: input.workstreamId, planRef: input.planRef,
      planRevision: input.planRevision, planFingerprint: input.planFingerprint,
      status: "active", completionHistory: [], createdAt: "t", updatedAt: "t",
    };
    this.enrollments.set(key, enrollment);
    return enrollment;
  }

  async getEnrollment(_t: string, learnerId: string, courseId: string): Promise<Enrollment | null> {
    return this.enrollments.get(`${learnerId}/${courseId}`) ?? null;
  }

  async listEnrollments(_t: string, learnerId: string): Promise<ReadonlyArray<Enrollment>> {
    return [...this.enrollments.values()]
      .filter((e) => e.learnerId === learnerId)
      .sort((a, b) => (a.courseId < b.courseId ? -1 : 1));
  }

  async listEnrollmentsByWorkstreams(
    _t: string, workstreamIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<Enrollment>> {
    const ids = new Set(workstreamIds);
    return [...this.enrollments.values()].filter((e) => e.workstreamId !== null && ids.has(e.workstreamId));
  }

  async recordEvent(
    _t: string, learnerId: string, courseId: string, event: LearningEventInput,
  ): Promise<RecordResult> {
    this.calls.push("recordEvent");
    const key = `${learnerId}/${courseId}`;
    const list = this.events.get(key) ?? [];
    if (list.some((e) => e.id === event.id)) return "noop";
    list.push({ ...event, createdAt: "t" });
    this.events.set(key, list);
    return "inserted";
  }

  async listEvents(_t: string, learnerId: string, courseId: string): Promise<ReadonlyArray<LearningEvent>> {
    return [...(this.events.get(`${learnerId}/${courseId}`) ?? [])].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  async completeCourse(_t: string, learnerId: string, courseId: string): Promise<void> {
    this.calls.push("completeCourse");
    const key = `${learnerId}/${courseId}`;
    const existing = this.enrollments.get(key);
    if (!existing) throw new Error("no enrollment");
    this.enrollments.set(key, { ...existing, status: "completed" });
  }
}

function makeDeps(): { deps: LearnerServiceDeps; store: FakeLearnerStore } {
  const store = new FakeLearnerStore();
  const ws = {
    id: "ws_1", label: "Course WS", status: "active" as const, mergedInto: null,
    createdAt: "t", updatedAt: "t", lastSessionAt: null, scope: null,
  };
  const deps: LearnerServiceDeps = {
    learners: store,
    workstreams: {
      getById: async (_t: string, id: string) => (id === "ws_1" ? ws : null),
      findByNormalizedLabel: async (_t: string, label: string) => (label === "course ws" ? ws : null),
    },
  };
  return { deps, store };
}

const ENROLL_BASE = {
  learnerId: "alex",
  courseId: "calculus",
  planRef: "courses/calculus/course.json",
  planRevision: 2,
  planFingerprint: "fp-abc",
};

function validEvent(): LearningEventInput {
  return {
    id: "ev-1",
    date: "2026-01-15",
    covered: ["math.chain-rule"],
    attempts: [
      {
        concept: "math.chain-rule", task: "Differentiate (3x+1)^2.",
        response: "correct, unassisted.", result: "correct", help: "none", kind: "application",
      },
    ],
    interpretation: "",
    nextStep: "Move to product rule.",
  };
}

describe("learner service", () => {
  let deps: LearnerServiceDeps;
  let store: FakeLearnerStore;

  beforeEach(() => {
    ({ deps, store } = makeDeps());
  });

  it("enrolls by workstream id and auto-inits the learner", async () => {
    const enrollment = await enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "ws_1" });
    expect(enrollment).toMatchObject({ learnerId: "alex", courseId: "calculus", workstreamId: "ws_1" });
    expect(store.calls).toEqual(["initLearner", "enroll"]);
  });

  it("resolves workstream by label and skips init for known learners", async () => {
    await enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "ws_1" });
    store.calls.length = 0;
    const enrollment = await enrollCourse(
      deps, "team_local", { ...ENROLL_BASE, courseId: "algebra", workstream: "Course WS" },
    );
    expect(enrollment.workstreamId).toBe("ws_1");
    expect(store.calls).toEqual(["enroll"]);
  });

  it("throws for an unknown workstream before touching learner state", async () => {
    await expect(
      enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "nope" }),
    ).rejects.toThrow(/no workstream/);
    expect(store.calls).toEqual([]);
  });

  it("records a valid event and assembles the summary", async () => {
    await enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "ws_1" });
    expect(await recordLearningEvent(deps, "team_local", "alex", "calculus", validEvent())).toBe("inserted");
    const summary = await getCourseSummary(deps, "team_local", "alex", "calculus");
    expect(summary).toMatchObject({
      learnerId: "alex", courseId: "calculus", status: "active",
      workstreamId: "ws_1", planRevision: 2,
      nextStep: "Move to product rule.", eventCount: 1, lastEventDate: "2026-01-15",
    });
    expect(summary!.concepts).toMatchObject([{ concept: "math.chain-rule", status: "demonstrated" }]);
  });

  it("rejects an invalid event before calling the store", async () => {
    await enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "ws_1" });
    store.calls.length = 0;
    await expect(
      recordLearningEvent(deps, "team_local", "alex", "calculus", { ...validEvent(), nextStep: "" }),
    ).rejects.toThrow(/nextStep/);
    expect(store.calls).toEqual([]);
  });

  it("returns null summary for a missing enrollment", async () => {
    expect(await getCourseSummary(deps, "team_local", "alex", "calculus")).toBeNull();
  });

  it("completes a course", async () => {
    await enrollCourse(deps, "team_local", { ...ENROLL_BASE, workstream: "ws_1" });
    await completeLearnerCourse(deps, "team_local", "alex", "calculus");
    expect(store.calls).toContain("completeCourse");
    expect((await getCourseSummary(deps, "team_local", "alex", "calculus"))!.status).toBe("completed");
  });
});
