/**
 * learner_* handler unit tests for the MCP learner tools.
 *
 * Same fake-deps pattern as mcp-report-outcome.test.ts: handlers are thin
 * adapters over src/core/learner/service.ts, so these tests cover the
 * adapter layer (input mapping, summary composition, unrecorded join,
 * no-course disambiguation) with in-memory fakes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  learnerCompleteHandler,
  learnerEnrollHandler,
  learnerRecordHandler,
  learnerSummaryHandler,
} from "../../../src/mcp/server.js";
import type { McpDeps } from "../../../src/mcp/server.js";
import type {
  EnrollmentInput,
  LearnerInit,
  LearnerStore,
  LearningEventInput,
  RecordResult,
} from "../../../src/ports/learner-store.js";
import type {
  Enrollment,
  Learner,
  LearningEvent,
} from "../../../src/core/learner/model.js";
import type { Session } from "../../../src/shared/types.js";
import { makeSession } from "../../fixtures/sessions.js";

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

const WS = {
  id: "ws_1", label: "Course WS", status: "active" as const, mergedInto: null,
  createdAt: "t", updatedAt: "t", lastSessionAt: null, scope: null,
};

function makeDeps(store: FakeLearnerStore, sessions: Session[] = []): McpDeps {
  return {
    recall: {} as McpDeps["recall"],
    store: {} as McpDeps["store"],
    learners: {
      store,
      workstreams: {
        getById: async (_t: string, id: string) => (id === "ws_1" ? WS : null),
        findByNormalizedLabel: async (_t: string, label: string) => (label === "course ws" ? WS : null),
      },
      sessions: {
        listSessionIdsByWorkstreams: async (_t: string, _ids: ReadonlyArray<string>) =>
          sessions.map((s) => s.id),
        getByIds: async (_t: string, _ids: ReadonlyArray<string>) => sessions,
      },
    },
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

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

function toRecordInput(event: LearningEventInput) {
  return {
    id: event.id,
    date: event.date,
    covered: [...event.covered],
    attempts: event.attempts.map((a) => ({ ...a })),
    interpretation: event.interpretation,
    next_step: event.nextStep,
  };
}

describe("learner MCP handlers", () => {
  let store: FakeLearnerStore;

  beforeEach(() => {
    store = new FakeLearnerStore();
  });

  it("enrolls and confirms", async () => {
    const res = await learnerEnrollHandler(makeDeps(store), "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "courses/calculus/course.json", plan_revision: 2, plan_fingerprint: "fp-abc",
    });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe("Enrolled alex in calculus (active, plan rev 2).");
  });

  it("enroll with unknown workstream errors", async () => {
    const res = await learnerEnrollHandler(makeDeps(store), "team_local", {
      learner: "alex", course: "calculus", workstream: "nope",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no workstream/);
  });

  it("records and confirms, mapping snake_case event", async () => {
    const deps = makeDeps(store);
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    const res = await learnerRecordHandler(deps, "team_local", {
      learner: "alex", course: "calculus", event: toRecordInput(validEvent()),
    });
    expect(textOf(res)).toBe("Recorded event ev-1 for alex/calculus.");
  });

  it("record rejects invalid events without store writes", async () => {
    const deps = makeDeps(store);
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    store.calls.length = 0;
    const res = await learnerRecordHandler(deps, "team_local", {
      learner: "alex", course: "calculus",
      event: { ...toRecordInput(validEvent()), next_step: "" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/nextStep/);
    expect(store.calls).toEqual([]);
  });

  it("summarizes with concepts, next step, and unrecorded join", async () => {
    const sessions = [
      makeSession({ id: "s_old", label: "Old session", startedAt: "2026-01-10T00:00:00Z" }),
      makeSession({ id: "s_new", label: "New session", startedAt: "2026-01-20T00:00:00Z" }),
    ];
    const deps = makeDeps(store, sessions);
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    await learnerRecordHandler(deps, "team_local", {
      learner: "alex", course: "calculus", event: toRecordInput(validEvent()),
    });
    const res = await learnerSummaryHandler(deps, "team_local", { learner: "alex", course: "calculus" });
    const text = textOf(res);
    expect(text).toContain("LEARNER alex · calculus (active, rev 1, 1 events)");
    expect(text).toContain("[demonstrated] math.chain-rule (1 attempt)");
    expect(text).toContain("Next: Move to product rule.");
    expect(text).toContain("Unrecorded sessions (1):");
    expect(text).toContain("s_new");
    expect(text).not.toContain("s_old");
  });

  it("summary resolves a single active enrollment when course is omitted", async () => {
    const deps = makeDeps(store);
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    const res = await learnerSummaryHandler(deps, "team_local", { learner: "alex" });
    expect(textOf(res)).toContain("LEARNER alex · calculus");
  });

  it("summary asks on zero or multiple active enrollments", async () => {
    const deps = makeDeps(store);
    expect(textOf(await learnerSummaryHandler(deps, "team_local", { learner: "alex" }))).toMatch(
      /No active enrollments/,
    );
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "algebra", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    expect(textOf(await learnerSummaryHandler(deps, "team_local", { learner: "alex" }))).toMatch(
      /specify course: algebra, calculus/,
    );
  });

  it("completes and confirms", async () => {
    const deps = makeDeps(store);
    await learnerEnrollHandler(deps, "team_local", {
      learner: "alex", course: "calculus", workstream: "ws_1",
      plan_ref: "p", plan_revision: 1, plan_fingerprint: "fp",
    });
    const res = await learnerCompleteHandler(deps, "team_local", { learner: "alex", course: "calculus" });
    expect(textOf(res)).toBe("Marked calculus completed for alex.");
  });

  it("handlers report unavailable when learners deps are absent", async () => {
    const deps = { recall: {}, store: {} } as unknown as McpDeps;
    for (const res of [
      await learnerEnrollHandler(deps, "team_local", {
        learner: "a", course: "c", workstream: "w", plan_ref: "p", plan_revision: 1, plan_fingerprint: "f",
      }),
      await learnerSummaryHandler(deps, "team_local", { learner: "a" }),
      await learnerCompleteHandler(deps, "team_local", { learner: "a", course: "c" }),
    ]) {
      expect(res.isError).toBeUndefined();
      expect(textOf(res)).toMatch(/not available/);
    }
  });
});
