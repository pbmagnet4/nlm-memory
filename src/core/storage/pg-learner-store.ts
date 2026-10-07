/**
 * PgLearnerStore — LearnerStore implementation over pg.Pool.
 *
 * Receives its Pool from PgStorage. Never opens its own connection.
 *
 * Tenancy: mirrors SqliteLearnerStore — every method takes `tenantId` as its
 * non-optional first parameter and routes STAMP-table WHERE fragments through
 * `tenantClausePg`. JSON columns are JSONB (node-postgres parses them); the
 * row readers accept both parsed objects and strings so the two backends stay
 * behaviorally identical.
 */

import type { Pool } from "pg";
import type {
  EnrollmentInput,
  LearnerInit,
  LearnerStore,
  LearningEventInput,
  RecordResult,
} from "@ports/learner-store.js";
import type { Enrollment, EnrollmentStatus, Learner, LearningEvent } from "@core/learner/model.js";
import { learningEventContentEqual, makeEnrollmentId } from "@core/learner/model.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

type LearnerRow = {
  id: string;
  label: string;
  profile_json: Record<string, unknown> | string;
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
  completion_history_json: ReadonlyArray<unknown> | string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  date: string;
  covered_json: ReadonlyArray<string> | string;
  attempts_json: LearningEvent["attempts"] | string;
  interpretation: string;
  next_step: string;
  created_at: string;
};

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function learnerFromRow(row: LearnerRow): Learner {
  return {
    id: row.id,
    label: row.label,
    profile: parseJson(row.profile_json),
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
    completionHistory: parseJson(row.completion_history_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): LearningEvent {
  return {
    id: row.id,
    date: row.date,
    covered: parseJson(row.covered_json),
    attempts: parseJson(row.attempts_json),
    interpretation: row.interpretation,
    nextStep: row.next_step,
    createdAt: row.created_at,
  };
}

const LEARNER_COLS = "id, label, profile_json, created_at, updated_at";
const ENROLLMENT_COLS =
  "id, learner_id, course_id, workstream_id, plan_ref, plan_revision, " +
  "plan_fingerprint, status, completion_history_json, created_at, updated_at";
const EVENT_COLS = "id, date, covered_json, attempts_json, interpretation, next_step, created_at";

export class PgLearnerStore implements LearnerStore {
  constructor(private readonly pool: Pool) {}

  async initLearner(tenantId: string, input: LearnerInit): Promise<void> {
    await this.pool.query(
      "INSERT INTO learners (id, label, profile_json, tenant_id) VALUES ($1, $2, $3, $4)",
      [input.id, input.label, JSON.stringify(input.profile ?? {}), tenantId],
    );
  }

  async getLearner(tenantId: string, id: string): Promise<Learner | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<LearnerRow>(
      `SELECT ${LEARNER_COLS} FROM learners WHERE id = $1 AND ${tc.sql}`,
      [id, tc.param],
    );
    return result.rows[0] ? learnerFromRow(result.rows[0]) : null;
  }

  async enroll(tenantId: string, input: EnrollmentInput): Promise<Enrollment> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tc = tenantClausePg(tenantId, 3);
      const existing = await client.query<EnrollmentRow>(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = $1 AND course_id = $2 AND ${tc.sql}`,
        [input.learnerId, input.courseId, tc.param],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.plan_fingerprint !== input.planFingerprint || row.plan_revision !== input.planRevision) {
          throw new Error(
            `enroll: plan changed for ${input.learnerId}/${input.courseId} ` +
              "(rev differs) — reconcile explicitly, refusing silent upsert",
          );
        }
        await client.query("COMMIT");
        return enrollmentFromRow(row);
      }
      const id = makeEnrollmentId();
      await client.query(
        `INSERT INTO enrollments (id, learner_id, course_id, workstream_id, plan_ref,
           plan_revision, plan_fingerprint, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.learnerId, input.courseId, input.workstreamId,
          input.planRef, input.planRevision, input.planFingerprint, tenantId],
      );
      const inserted = await client.query<EnrollmentRow>(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE id = $1 AND ${tenantClausePg(tenantId, 2).sql}`,
        [id, tenantId],
      );
      await client.query("COMMIT");
      return enrollmentFromRow(inserted.rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getEnrollment(
    tenantId: string,
    learnerId: string,
    courseId: string,
  ): Promise<Enrollment | null> {
    const tc = tenantClausePg(tenantId, 3);
    const result = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = $1 AND course_id = $2 AND ${tc.sql}`,
      [learnerId, courseId, tc.param],
    );
    return result.rows[0] ? enrollmentFromRow(result.rows[0]) : null;
  }

  async listEnrollments(tenantId: string, learnerId: string): Promise<ReadonlyArray<Enrollment>> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = $1 AND ${tc.sql} ORDER BY course_id ASC`,
      [learnerId, tc.param],
    );
    return result.rows.map(enrollmentFromRow);
  }

  async listEnrollmentsByWorkstreams(
    tenantId: string,
    workstreamIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<Enrollment>> {
    if (workstreamIds.length === 0) return [];
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<EnrollmentRow>(
      `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE workstream_id = ANY($1) AND ${tc.sql}`,
      [[...workstreamIds], tc.param],
    );
    return result.rows.map(enrollmentFromRow);
  }

  async recordEvent(
    tenantId: string,
    learnerId: string,
    courseId: string,
    event: LearningEventInput,
  ): Promise<RecordResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const enrTc = tenantClausePg(tenantId, 3);
      const enrollment = await client.query<EnrollmentRow>(
        `SELECT ${ENROLLMENT_COLS} FROM enrollments WHERE learner_id = $1 AND course_id = $2 AND ${enrTc.sql}`,
        [learnerId, courseId, enrTc.param],
      );
      if (!enrollment.rows[0]) throw new Error(`recordEvent: no enrollment for ${learnerId}/${courseId}`);
      const evTc = tenantClausePg(tenantId, 3);
      const existing = await client.query<EventRow>(
        `SELECT ${EVENT_COLS} FROM learning_events WHERE enrollment_id = $1 AND id = $2 AND ${evTc.sql}`,
        [enrollment.rows[0].id, event.id, evTc.param],
      );
      if (!existing.rows[0]) {
        await client.query(
          `INSERT INTO learning_events (id, enrollment_id, date, covered_json, attempts_json,
             interpretation, next_step, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [event.id, enrollment.rows[0].id, event.date, JSON.stringify(event.covered),
            JSON.stringify(event.attempts), event.interpretation, event.nextStep, tenantId],
        );
        await client.query("COMMIT");
        return "inserted";
      }
      const row = existing.rows[0];
      const same = learningEventContentEqual(event, {
        date: row.date,
        covered: parseJson(row.covered_json),
        attempts: parseJson(row.attempts_json),
        interpretation: row.interpretation,
        nextStep: row.next_step,
      });
      if (!same) throw new Error(`recordEvent: conflicting event id ${event.id} — refusing to rewrite history`);
      await client.query("COMMIT");
      return "noop";
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listEvents(
    tenantId: string,
    learnerId: string,
    courseId: string,
  ): Promise<ReadonlyArray<LearningEvent>> {
    const enrollment = await this.getEnrollment(tenantId, learnerId, courseId);
    if (!enrollment) return [];
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM learning_events WHERE enrollment_id = $1 AND ${tc.sql} ` +
        "ORDER BY date ASC, id ASC",
      [enrollment.id, tc.param],
    );
    return result.rows.map(eventFromRow);
  }

  async completeCourse(tenantId: string, learnerId: string, courseId: string): Promise<void> {
    const enrollment = await this.getEnrollment(tenantId, learnerId, courseId);
    if (!enrollment) throw new Error(`completeCourse: no enrollment for ${learnerId}/${courseId}`);
    const tc = tenantClausePg(tenantId, 2);
    await this.pool.query(
      `UPDATE enrollments SET status = 'completed', updated_at = NOW() WHERE id = $1 AND ${tc.sql}`,
      [enrollment.id, tc.param],
    );
  }
}
