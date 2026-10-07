/**
 * Backend-agnostic contract test for the LearnerStore port.
 *
 * Each adapter integration test imports runLearnerStoreContract and supplies a
 * harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend. That is the only proof
 * that a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets
 * each integration test file own its own describe naming.
 *
 * Timestamp note: sqlite stores `datetime('now')` ("YYYY-MM-DD HH:MM:SS"),
 * pg parses TIMESTAMPTZ to ISO. The contract asserts non-empty strings only.
 *
 * Ordering note: listEvents orders by (date, id). created_at is deliberately
 * excluded: sqlite stamps seconds, pg stamps microseconds, so same-date order
 * would differ per backend. Gnos event ids are date-prefixed in practice,
 * which preserves insertion order through the id tiebreak.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { Attempt } from "../../src/core/learner/model.js";

export interface LearnerStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  /** Ensure a team row exists (pg FKs require it; sqlite is a harmless no-op). */
  ensureTeam(storage: Storage, teamId: string): Promise<void>;
}

const T_LOCAL = "team_local";
const T_B = "team_b";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    concept: "math.chain-rule",
    task: "Differentiate (3x+1)^2.",
    response: "2(3x+1); forgot the inner rate.",
    result: "incorrect",
    help: "none",
    kind: "application",
    ...overrides,
  };
}

export function runLearnerStoreContract(h: LearnerStoreContractHarness): void {
  describe(`LearnerStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    async function seedWorkstream(tenantId = T_LOCAL): Promise<string> {
      const ws = await storage.workstreams.create(tenantId, {
        id: `ws_${tenantId}_1`,
        label: "Course WS",
        scope: null,
      });
      return ws.id;
    }

    async function seedEnrolled(tenantId = T_LOCAL): Promise<void> {
      await storage.learners.initLearner(tenantId, { id: "alex", label: "Alex" });
      const wsId = await seedWorkstream(tenantId);
      await storage.learners.enroll(tenantId, {
        learnerId: "alex",
        courseId: "calculus",
        workstreamId: wsId,
        planRef: "courses/calculus/course.json",
        planRevision: 2,
        planFingerprint: "fp-abc",
      });
    }

    it("inits and retrieves a learner round-trip", async () => {
      await storage.learners.initLearner(T_LOCAL, {
        id: "alex",
        label: "Alex",
        profile: { goal: "pass the final" },
      });
      const fetched = await storage.learners.getLearner(T_LOCAL, "alex");
      expect(fetched).toMatchObject({ id: "alex", label: "Alex", profile: { goal: "pass the final" } });
      expect(typeof fetched!.createdAt).toBe("string");
      expect(fetched!.createdAt.length).toBeGreaterThan(0);
      expect(typeof fetched!.updatedAt).toBe("string");
      expect(fetched!.updatedAt.length).toBeGreaterThan(0);
    });

    it("returns null for a missing learner", async () => {
      expect(await storage.learners.getLearner(T_LOCAL, "nobody")).toBeNull();
    });

    it("duplicate init throws", async () => {
      await storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" });
      await expect(storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" })).rejects.toThrow();
    });

    it("isolates learners across tenants", async () => {
      await h.ensureTeam(storage, T_B);
      await storage.learners.initLearner(T_B, { id: "alex", label: "Other Alex" });
      expect(await storage.learners.getLearner(T_LOCAL, "alex")).toBeNull();
      expect(await storage.learners.getLearner(T_B, "alex")).toMatchObject({ label: "Other Alex" });
    });

    it("enrolls and retrieves an enrollment round-trip", async () => {
      await storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" });
      const wsId = await seedWorkstream();
      const enrolled = await storage.learners.enroll(T_LOCAL, {
        learnerId: "alex",
        courseId: "calculus",
        workstreamId: wsId,
        planRef: "courses/calculus/course.json",
        planRevision: 2,
        planFingerprint: "fp-abc",
      });
      expect(enrolled.id).toMatch(/^enr_/);
      expect(await storage.learners.getEnrollment(T_LOCAL, "alex", "calculus")).toMatchObject({
        id: enrolled.id,
        learnerId: "alex",
        courseId: "calculus",
        workstreamId: wsId,
        planRef: "courses/calculus/course.json",
        planRevision: 2,
        planFingerprint: "fp-abc",
        status: "active",
        completionHistory: [],
      });
    });

    it("lists enrollments by learner ordered by course", async () => {
      await storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" });
      const wsId = await seedWorkstream();
      const base = {
        learnerId: "alex", workstreamId: wsId, planRef: "p", planRevision: 1, planFingerprint: "fp",
      };
      await storage.learners.enroll(T_LOCAL, { ...base, courseId: "calculus" });
      await storage.learners.enroll(T_LOCAL, { ...base, courseId: "algebra" });
      const listed = await storage.learners.listEnrollments(T_LOCAL, "alex");
      expect(listed.map((e) => e.courseId)).toEqual(["algebra", "calculus"]);
      expect(await storage.learners.listEnrollments(T_LOCAL, "nobody")).toEqual([]);
    });

    it("lists enrollments by workstream", async () => {
      await storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" });
      await storage.workstreams.create(T_LOCAL, { id: "ws_a", label: "A", scope: null });
      await storage.workstreams.create(T_LOCAL, { id: "ws_b", label: "B", scope: null });
      const base = {
        learnerId: "alex", planRef: "p", planRevision: 1, planFingerprint: "fp",
      };
      await storage.learners.enroll(T_LOCAL, { ...base, courseId: "calculus", workstreamId: "ws_a" });
      await storage.learners.enroll(T_LOCAL, { ...base, courseId: "algebra", workstreamId: "ws_b" });
      expect(
        (await storage.learners.listEnrollmentsByWorkstreams(T_LOCAL, ["ws_a"])).map((e) => e.courseId),
      ).toEqual(["calculus"]);
      expect(
        (await storage.learners.listEnrollmentsByWorkstreams(T_LOCAL, ["ws_a", "ws_b"])).map((e) => e.courseId).sort(),
      ).toEqual(["algebra", "calculus"]);
      expect(await storage.learners.listEnrollmentsByWorkstreams(T_LOCAL, [])).toEqual([]);
      expect(await storage.learners.listEnrollmentsByWorkstreams(T_LOCAL, ["ws_missing"])).toEqual([]);
    });

    it("enroll throws for a missing learner", async () => {
      const wsId = await seedWorkstream();
      await expect(
        storage.learners.enroll(T_LOCAL, {
          learnerId: "ghost", courseId: "calculus", workstreamId: wsId,
          planRef: "p", planRevision: 1, planFingerprint: "fp",
        }),
      ).rejects.toThrow();
    });

    it("enroll throws for a missing workstream", async () => {
      await storage.learners.initLearner(T_LOCAL, { id: "alex", label: "Alex" });
      await expect(
        storage.learners.enroll(T_LOCAL, {
          learnerId: "alex", courseId: "calculus", workstreamId: "ws_missing",
          planRef: "p", planRevision: 1, planFingerprint: "fp",
        }),
      ).rejects.toThrow();
    });

    it("re-enrolling the identical plan returns the existing enrollment", async () => {
      await seedEnrolled();
      const again = await storage.learners.enroll(T_LOCAL, {
        learnerId: "alex", courseId: "calculus", workstreamId: `ws_${T_LOCAL}_1`,
        planRef: "courses/calculus/course.json", planRevision: 2, planFingerprint: "fp-abc",
      });
      const fetched = await storage.learners.getEnrollment(T_LOCAL, "alex", "calculus");
      expect(again.id).toBe(fetched!.id);
    });

    it("re-enrolling a changed plan throws", async () => {
      await seedEnrolled();
      await expect(
        storage.learners.enroll(T_LOCAL, {
          learnerId: "alex", courseId: "calculus", workstreamId: `ws_${T_LOCAL}_1`,
          planRef: "courses/calculus/course.json", planRevision: 3, planFingerprint: "fp-changed",
        }),
      ).rejects.toThrow(/plan changed/);
    });

    it("records and lists events ordered by date", async () => {
      await seedEnrolled();
      const ev1 = {
        id: "ev-late", date: "2026-02-01", covered: ["math.chain-rule"],
        attempts: [attempt()], interpretation: "outer ok, inner shaky",
        nextStep: "Compare u=3x+1 and y=u^2.",
      };
      const ev2 = {
        id: "ev-early", date: "2026-01-15", covered: ["math.power-rule"],
        attempts: [attempt({ concept: "math.power-rule", result: "correct" })],
        interpretation: "solid", nextStep: "Move to chain rule.",
      };
      expect(await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", ev1)).toBe("inserted");
      expect(await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", ev2)).toBe("inserted");
      const listed = await storage.learners.listEvents(T_LOCAL, "alex", "calculus");
      expect(listed.map((e) => e.id)).toEqual(["ev-early", "ev-late"]);
      expect(listed[0]).toMatchObject({
        date: "2026-01-15", covered: ["math.power-rule"],
        interpretation: "solid", nextStep: "Move to chain rule.",
      });
      expect(listed[0]!.attempts).toEqual([attempt({ concept: "math.power-rule", result: "correct" })]);
    });

    it("same-date events order by id (documented tiebreak)", async () => {
      await seedEnrolled();
      const base = {
        date: "2026-03-01", covered: ["math.chain-rule"], attempts: [attempt()],
        interpretation: "", nextStep: "Keep going.",
      };
      await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", { ...base, id: "ev-b" });
      await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", { ...base, id: "ev-a" });
      const listed = await storage.learners.listEvents(T_LOCAL, "alex", "calculus");
      expect(listed.map((e) => e.id)).toEqual(["ev-a", "ev-b"]);
    });

    it("identical retry is a safe no-op", async () => {
      await seedEnrolled();
      const ev = {
        id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"],
        attempts: [attempt()], interpretation: "", nextStep: "Keep going.",
      };
      expect(await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", ev)).toBe("inserted");
      expect(await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", ev)).toBe("noop");
      expect(await storage.learners.listEvents(T_LOCAL, "alex", "calculus")).toHaveLength(1);
    });

    it("conflicting retry throws and preserves history", async () => {
      await seedEnrolled();
      const ev = {
        id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"],
        attempts: [attempt()], interpretation: "", nextStep: "Keep going.",
      };
      await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", ev);
      await expect(
        storage.learners.recordEvent(T_LOCAL, "alex", "calculus", { ...ev, nextStep: "Rewritten." }),
      ).rejects.toThrow(/conflicting event/);
      const listed = await storage.learners.listEvents(T_LOCAL, "alex", "calculus");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.nextStep).toBe("Keep going.");
    });

    it("record on a missing enrollment throws", async () => {
      await expect(
        storage.learners.recordEvent(T_LOCAL, "alex", "calculus", {
          id: "ev-1", date: "2026-01-15", covered: [], attempts: [],
          interpretation: "", nextStep: "x",
        }),
      ).rejects.toThrow(/no enrollment/);
    });

    it("listEvents on a missing enrollment returns []", async () => {
      expect(await storage.learners.listEvents(T_LOCAL, "alex", "calculus")).toEqual([]);
    });

    it("complete flips status, preserves history, and is idempotent", async () => {
      await seedEnrolled();
      await storage.learners.completeCourse(T_LOCAL, "alex", "calculus");
      await storage.learners.completeCourse(T_LOCAL, "alex", "calculus");
      expect(await storage.learners.getEnrollment(T_LOCAL, "alex", "calculus")).toMatchObject({
        status: "completed",
        completionHistory: [],
      });
    });

    it("complete on a missing enrollment throws", async () => {
      await expect(storage.learners.completeCourse(T_LOCAL, "alex", "calculus")).rejects.toThrow(/no enrollment/);
    });

    it("isolates enrollments and events across tenants", async () => {
      await h.ensureTeam(storage, T_B);
      await seedEnrolled(T_LOCAL);
      await seedEnrolled(T_B);
      await storage.learners.recordEvent(T_LOCAL, "alex", "calculus", {
        id: "ev-1", date: "2026-01-15", covered: ["math.chain-rule"],
        attempts: [attempt()], interpretation: "", nextStep: "Local next.",
      });
      expect(await storage.learners.getEnrollment(T_B, "alex", "calculus")).toMatchObject({ status: "active" });
      expect(await storage.learners.listEvents(T_B, "alex", "calculus")).toEqual([]);
      expect(await storage.learners.listEvents(T_LOCAL, "alex", "calculus")).toHaveLength(1);
    });
  });
}
