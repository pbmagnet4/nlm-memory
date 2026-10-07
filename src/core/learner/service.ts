/**
 * Learner service — orchestration over LearnerStore + WorkstreamStore.
 *
 * Owns validation (validate.ts), learner auto-init, workstream id-or-label
 * resolution, and summary assembly. Idempotency, fingerprint matching, and
 * tenant isolation stay in the store. The MCP layer (M3) calls these
 * operations; unrecorded-session listing needs SessionStore and lands in M3.
 */

import type {
  LearnerStore,
  LearningEventInput,
  RecordResult,
} from "@ports/learner-store.js";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { Enrollment, EnrollmentStatus } from "./model.js";
import { normalizeLabel } from "@core/workstream/model.js";
import {
  assertValidEnrollmentInput,
  assertValidEventInput,
  assertValidLearnerInit,
  assertValidSlug,
} from "./validate.js";
import { summarizeConcepts, type ConceptSummary } from "./summary.js";

export interface LearnerServiceDeps {
  readonly learners: LearnerStore;
  readonly workstreams: Pick<WorkstreamStore, "getById" | "findByNormalizedLabel">;
}

export interface EnrollRequest {
  readonly learnerId: string;
  readonly learnerLabel?: string;
  readonly courseId: string;
  /** Workstream id or label; resolved like recall_workstream. */
  readonly workstream: string;
  readonly planRef: string;
  readonly planRevision: number;
  readonly planFingerprint: string;
}

export interface CourseSummary {
  readonly learnerId: string;
  readonly courseId: string;
  readonly status: EnrollmentStatus;
  readonly workstreamId: string | null;
  readonly planRevision: number;
  readonly concepts: ReadonlyArray<ConceptSummary>;
  /** Latest event's next step, or null when nothing is recorded yet. */
  readonly nextStep: string | null;
  readonly eventCount: number;
  readonly lastEventDate: string | null;
}

async function resolveWorkstreamId(
  deps: LearnerServiceDeps,
  tenantId: string,
  idOrLabel: string,
): Promise<string> {
  const trimmed = idOrLabel.trim();
  if (!trimmed) throw new Error("learner service: workstream id or label is required");
  const found =
    (await deps.workstreams.getById(tenantId, trimmed)) ??
    (await deps.workstreams.findByNormalizedLabel(tenantId, normalizeLabel(trimmed)));
  if (!found) throw new Error(`learner service: no workstream matches "${trimmed}"`);
  return found.id;
}

export async function enrollCourse(
  deps: LearnerServiceDeps,
  tenantId: string,
  req: EnrollRequest,
): Promise<Enrollment> {
  assertValidSlug(req.learnerId, "enrollment.learnerId");
  assertValidSlug(req.courseId, "enrollment.courseId");
  const workstreamId = await resolveWorkstreamId(deps, tenantId, req.workstream);
  const existing = await deps.learners.getLearner(tenantId, req.learnerId);
  if (!existing) {
    const init = { id: req.learnerId, label: req.learnerLabel ?? req.learnerId };
    assertValidLearnerInit(init);
    await deps.learners.initLearner(tenantId, init);
  }
  const input = {
    learnerId: req.learnerId,
    courseId: req.courseId,
    workstreamId,
    planRef: req.planRef,
    planRevision: req.planRevision,
    planFingerprint: req.planFingerprint,
  };
  assertValidEnrollmentInput(input);
  return deps.learners.enroll(tenantId, input);
}

export async function recordLearningEvent(
  deps: LearnerServiceDeps,
  tenantId: string,
  learnerId: string,
  courseId: string,
  event: LearningEventInput,
): Promise<RecordResult> {
  assertValidSlug(learnerId, "enrollment.learnerId");
  assertValidSlug(courseId, "enrollment.courseId");
  assertValidEventInput(event);
  return deps.learners.recordEvent(tenantId, learnerId, courseId, event);
}

export async function completeLearnerCourse(
  deps: LearnerServiceDeps,
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<void> {
  assertValidSlug(learnerId, "enrollment.learnerId");
  assertValidSlug(courseId, "enrollment.courseId");
  return deps.learners.completeCourse(tenantId, learnerId, courseId);
}

export async function getCourseSummary(
  deps: LearnerServiceDeps,
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<CourseSummary | null> {
  assertValidSlug(learnerId, "enrollment.learnerId");
  assertValidSlug(courseId, "enrollment.courseId");
  const enrollment = await deps.learners.getEnrollment(tenantId, learnerId, courseId);
  if (!enrollment) return null;
  const events = await deps.learners.listEvents(tenantId, learnerId, courseId);
  const last = events.length > 0 ? events[events.length - 1]! : null;
  return {
    learnerId,
    courseId,
    status: enrollment.status,
    workstreamId: enrollment.workstreamId,
    planRevision: enrollment.planRevision,
    concepts: summarizeConcepts(events),
    nextStep: last ? last.nextStep : null,
    eventCount: events.length,
    lastEventDate: last ? last.date : null,
  };
}
