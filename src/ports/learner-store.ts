/**
 * LearnerStore — the only way core/ reads or writes learner evidence.
 *
 * Learners are human slugs ("alex"), so unlike globally-unique workstream and
 * session ids they are keyed per-tenant: `learners` PK is (tenant_id, id),
 * mirroring the Team NLM entity re-key (spec §2 — an entity NAME is itself a
 * leak across untrusted teams; a learner name even more so). Enrollment ids
 * are `enr_<uuid>`, globally unique.
 *
 * Every method takes `tenantId` as its non-optional FIRST parameter. There is
 * no default — the composition root supplies `DEFAULT_TEAM_ID` until tenant
 * resolution from auth lands.
 *
 * M1 validates shape only (nonempty ids). Gnos evidence-rule validation
 * (enums, dates, fingerprints) lives in `src/core/learner/validate.ts` (M2),
 * sitting on top of this port.
 */

import type { Attempt, Enrollment, Learner, LearningEvent } from "@core/learner/model.js";

export interface LearnerInit {
  readonly id: string;
  readonly label: string;
  readonly profile?: Record<string, unknown>;
}

export interface EnrollmentInput {
  readonly learnerId: string;
  readonly courseId: string;
  readonly workstreamId: string;
  readonly planRef: string;
  readonly planRevision: number;
  readonly planFingerprint: string;
}

export interface LearningEventInput {
  readonly id: string;
  readonly date: string;
  readonly covered: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly interpretation: string;
  readonly nextStep: string;
}

export type RecordResult = "inserted" | "noop";

export interface LearnerStore {
  /** Create a learner row. Throws on duplicate (tenant_id, id). */
  initLearner(tenantId: string, input: LearnerInit): Promise<void>;

  getLearner(tenantId: string, id: string): Promise<Learner | null>;

  /**
   * Enroll a learner in a course bound to a workstream. Throws when the
   * learner or workstream row does not exist (FK). Re-enrolling the identical
   * plan (same fingerprint + revision) returns the existing enrollment;
   * a changed plan throws — plan changes require the explicit revision flow,
   * never a silent upsert.
   */
  enroll(tenantId: string, input: EnrollmentInput): Promise<Enrollment>;

  getEnrollment(tenantId: string, learnerId: string, courseId: string): Promise<Enrollment | null>;

  /** All enrollments for a learner, ordered by course_id. Used for no-course disambiguation. */
  listEnrollments(tenantId: string, learnerId: string): Promise<ReadonlyArray<Enrollment>>;

  /**
   * Enrollments bound to any of the given workstreams. Used by recall-time
   * concept resolution. Empty input returns [] immediately.
   */
  listEnrollmentsByWorkstreams(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<Enrollment>>;

  /**
   * Record a learning event. Identical event id + identical content is a safe
   * no-op (`"noop"`); identical id + conflicting content throws, never rewrites
   * history. Throws when the enrollment does not exist.
   */
  recordEvent(
    tenantId: string,
    learnerId: string,
    courseId: string,
    event: LearningEventInput,
  ): Promise<RecordResult>;

  /**
   * Events ordered by (date, id). The id tiebreak is deterministic on both
   * backends; created_at is NOT in the order because its resolution differs
   * (sqlite seconds vs pg microseconds), which would order same-date events
   * differently per backend. Gnos orders by date then insertion — date-prefixed
   * event ids preserve that in practice.
   */
  listEvents(tenantId: string, learnerId: string, courseId: string): Promise<ReadonlyArray<LearningEvent>>;

  /**
   * Mark an enrollment completed. Preserves completion history; idempotent.
   * Throws when the enrollment does not exist.
   */
  completeCourse(tenantId: string, learnerId: string, courseId: string): Promise<void>;
}
