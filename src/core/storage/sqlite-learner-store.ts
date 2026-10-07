/**
 * SqliteLearnerStore — LearnerStore over the shared better-sqlite3 connection.
 *
 * Constructor takes an already-opened, already-migrated Database handle from
 * SqliteSessionStore.rawDb(). It does not open its own connection (same
 * single-writer rationale as SqliteFactStore).
 *
 * Tenancy: `learners`, `enrollments`, `learning_events` are STAMP tables;
 * every SELECT/UPDATE WHERE routes through `tenantClause`, INSERTs stamp
 * `tenant_id` explicitly. Learner ids are human slugs, so `learners` PK is
 * (tenant_id, id) — same-tenant addressing only, no cross-tenant visibility.
 */

import type Database from "better-sqlite3";
import type {
  EnrollmentInput,
  LearnerInit,
  LearnerStore,
  LearningEventInput,
  RecordResult,
} from "@ports/learner-store.js";
import type { Enrollment, EnrollmentStatus, Learner, LearningEvent } from "@core/learner/model.js";
import { learningEventContentEqual, makeEnrollmentId } from "@core/learner/model.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

type LearnerRow = {
  id: string;
  label: string;
  profile_json: string;
  created_at: string;
  updated_at: string;
};

type EnrollmentRow = {
  id: string;
  learner_id: string;
  course_id: string;
  workstream_id: string | null;
  plan_ref: string;
  plan_revision: number;
  plan_fingerprint: string;
  status: EnrollmentStatus;
  completion_history_json: string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  date: string;
  covered_json: string;
  attempts_json: string;
  interpretation: string;
  next_step: string;
  created_at: string;
};

function learnerFromRow(row: LearnerRow): Learner {
  return {
    id: row.id,
    label: row.label,
    profile: JSON.parse(row.profile_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function enrollmentFromRow(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    learnerId: row.learner_id,
    courseId: row.course_id,
    workstreamId: row.workstream_id,
    planRef: row.plan_ref,
    planRevision: row.plan_revision,
    planFingerprint: row.plan_fingerprint,
    status: row.status,
    completionHistory: JSON.parse(row.completion_history_json) as ReadonlyArray<unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): LearningEvent {
  return {
    id: row.id,
    date: row.date,
    covered: JSON.parse(row.covered_json) as ReadonlyArray<string>,
    attempts: JSON.parse(row.attempts_json) as LearningEvent["attempts"],
    interpretation: row.interpretation,
    nextStep: row.next_step,
    createdAt: row.created_at,
  };
}

/** Idempotent-record comparison via canonical JSON (see model.ts). */
function eventContentEqual(a: LearningEventInput, row: EventRow): boolean {
  return learningEventContentEqual(a, {
    date: row.date,
    covered: JSON.parse(row.covered_json) as ReadonlyArray<string>,
    attempts: JSON.parse(row.attempts_json) as LearningEvent["attempts"],
    interpretation: row.interpretation,
    nextStep: row.next_step,
  });
}

const LEARNER_COLS = "id, label, profile_json, created_at, updated_at";
const ENROLLMENT_COLS =
  "id, learner_id, course_id, workstream_id, plan_ref, plan_revision, " +
  "plan_fingerprint, status, completion_history_json, created_at, updated_at";
const EVENT_COLS = "id, date, covered_json, attempts_json, interpretation, next_step, created_at";

export class SqliteLearnerStore implements LearnerStore {
  /**
   * @internal. Construct via SqliteStorage.create(...) instead — see
   * SqliteFactStore for the rationale.
   */
  constructor(private readonly db: Database.Database) {}

  async initLearner(tenantId: string, input: LearnerInit): Promise<void> {
    this.db
      .prepare("INSERT INTO learners (id, label, profile_json, tenant_id) VALUES (?, ?, ?, ?)")
      .run(input.id, input.label, JSON.stringify(input.profile ?? {}), tenantId);
  }

  async getLearner(tenantId: string, id: string): Promise<Learner | null> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare(`SELECT ${LEARNER_COLS} FROM learners WHERE id = ? AND ${tc.sql}`)
      .get(id, tc.param) as LearnerRow | undefined;
    return row ? learnerFromRow(row) : null;
  }

  async enroll(tenantId: string, input: EnrollmentInput): Promise<Enrollment> {
    const txn = this.db.transaction((): Enrollment => {
      const existing = this.getEnrollmentRow(tenantId, input.learnerId, input.courseId);
      if (existing) {
        if (
          existing.plan_fingerprint !== input.planFingerprint ||
          existing.plan_revision !== input.planRevision
        ) {
          throw new Error(
            `enroll: plan changed for ${input.learnerId}/${input.courseId} ` +
              "(rev differs) — reconcile explicitly, refusing silent upsert",
          );
        }
        return enrollmentFromRow(existing);
      }
      const id = makeEnrollmentId();
      this.db
        .prepare(
          `INSERT INTO enrollments (id, learner_id, course_id, workstream_id, plan_ref,
             plan_revision, plan_fingerprint, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, input.learnerId, input.courseId, input.workstreamId,
          input.planRef, input.planRevision, input.planFingerprint, tenantId,
        );
      return enrollmentFromRow(this.getEnrollmentRow(tenantId, input.learnerId, input.courseId)!);
    });
    return txn();
  }

  async getEnrollment(
    tenantId: string,
    learnerId: string,
    courseId: string,
  ): Promise<Enrollment | null> {
    const row = this.getEnrollmentRow(tenantId, learnerId, courseId);
    return row ? enrollmentFromRow(row) : null;
  }

  async listEnrollments(tenantId: string, learnerId: string): Promise<ReadonlyArray<Enrollment>> {
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = ? AND ${tc.sql} ORDER BY course_id ASC`,
      )
      .all(learnerId, tc.param) as EnrollmentRow[];
    return rows.map(enrollmentFromRow);
  }

  async listEnrollmentsByWorkstreams(
    tenantId: string,
    workstreamIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<Enrollment>> {
    if (workstreamIds.length === 0) return [];
    const tc = tenantClause(tenantId);
    const placeholders = workstreamIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE workstream_id IN (${placeholders}) AND ${tc.sql}`,
      )
      .all(...workstreamIds, tc.param) as EnrollmentRow[];
    return rows.map(enrollmentFromRow);
  }

  async recordEvent(
    tenantId: string,
    learnerId: string,
    courseId: string,
    event: LearningEventInput,
  ): Promise<RecordResult> {
    const txn = this.db.transaction((): RecordResult => {
      const enrollment = this.getEnrollmentRow(tenantId, learnerId, courseId);
      if (!enrollment) throw new Error(`recordEvent: no enrollment for ${learnerId}/${courseId}`);
      const tc = tenantClause(tenantId);
      const existing = this.db
        .prepare(`SELECT ${EVENT_COLS} FROM learning_events WHERE enrollment_id = ? AND id = ? AND ${tc.sql}`)
        .get(enrollment.id, event.id, tc.param) as EventRow | undefined;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO learning_events (id, enrollment_id, date, covered_json, attempts_json,
               interpretation, next_step, tenant_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id, enrollment.id, event.date, JSON.stringify(event.covered),
            JSON.stringify(event.attempts), event.interpretation, event.nextStep, tenantId,
          );
        return "inserted";
      }
      if (!eventContentEqual(event, existing)) {
        throw new Error(`recordEvent: conflicting event id ${event.id} — refusing to rewrite history`);
      }
      return "noop";
    });
    return txn();
  }

  async listEvents(
    tenantId: string,
    learnerId: string,
    courseId: string,
  ): Promise<ReadonlyArray<LearningEvent>> {
    const enrollment = this.getEnrollmentRow(tenantId, learnerId, courseId);
    if (!enrollment) return [];
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLS} FROM learning_events WHERE enrollment_id = ? AND ${tc.sql} ` +
          "ORDER BY date ASC, id ASC",
      )
      .all(enrollment.id, tc.param) as EventRow[];
    return rows.map(eventFromRow);
  }

  async completeCourse(tenantId: string, learnerId: string, courseId: string): Promise<void> {
    const enrollment = this.getEnrollmentRow(tenantId, learnerId, courseId);
    if (!enrollment) throw new Error(`completeCourse: no enrollment for ${learnerId}/${courseId}`);
    const tc = tenantClause(tenantId);
    this.db
      .prepare(`UPDATE enrollments SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND ${tc.sql}`)
      .run(enrollment.id, tc.param);
  }

  private getEnrollmentRow(tenantId: string, learnerId: string, courseId: string): EnrollmentRow | undefined {
    const tc = tenantClause(tenantId);
    return this.db
      .prepare(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = ? AND course_id = ? AND ${tc.sql}`,
      )
      .get(learnerId, courseId, tc.param) as EnrollmentRow | undefined;
  }
}
