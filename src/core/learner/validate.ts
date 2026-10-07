/**
 * Learner evidence validation — port of the Gnos evidence contract
 * (`skills/learner-tracking/scripts/learner_state.py`, MIT, attribution kept).
 *
 * Shape rules only: slug/concept formats, required fields, enum membership,
 * real calendar dates that are never in the future. Cross-row rules
 * (fingerprint match, idempotent retry) live in the store; orchestration in
 * service.ts. All failures throw `Error`; the MCP layer (M3) maps them to
 * tool errors.
 */

import type {
  EnrollmentInput,
  LearnerInit,
  LearningEventInput,
} from "@ports/learner-store.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONCEPT_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const ATTEMPT_RESULTS = ["correct", "partial", "incorrect"] as const;
const ATTEMPT_HELPS = ["none", "hint", "worked-example"] as const;
const ATTEMPT_KINDS = ["application", "retrieval", "transfer"] as const;

export function assertValidSlug(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 80 || !SLUG_PATTERN.test(value)) {
    throw new Error(`learner validation: ${label} must be a lowercase slug of at most 80 characters`);
  }
}

export function assertValidConceptId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CONCEPT_PATTERN.test(value)) {
    throw new Error(`learner validation: invalid concept ID: ${JSON.stringify(value)}`);
  }
}

export function assertNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`learner validation: ${label} must be nonempty text`);
  }
}

export function assertValidDate(value: unknown, label = "event.date"): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`learner validation: ${label} must be YYYY-MM-DD`);
  }
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new Error(`learner validation: ${label} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`learner validation: ${label} is not a real calendar date: ${value}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (value > today) {
    throw new Error(`learner validation: ${label} cannot be in the future: ${value}`);
  }
}

export function assertValidLearnerInit(input: LearnerInit): void {
  assertValidSlug(input.id, "learner.id");
  assertNonempty(input.label, "learner.label");
}

export function assertValidEnrollmentInput(input: EnrollmentInput): void {
  assertValidSlug(input.learnerId, "enrollment.learnerId");
  assertValidSlug(input.courseId, "enrollment.courseId");
  assertNonempty(input.workstreamId, "enrollment.workstreamId");
  assertNonempty(input.planRef, "enrollment.planRef");
  assertNonempty(input.planFingerprint, "enrollment.planFingerprint");
  if (!Number.isInteger(input.planRevision) || input.planRevision < 1) {
    throw new Error("learner validation: enrollment.planRevision must be a positive integer");
  }
}

export function assertValidEventInput(event: LearningEventInput): void {
  assertValidSlug(event.id, "event.id");
  assertValidDate(event.date);
  if (!Array.isArray(event.covered)) {
    throw new Error("learner validation: event.covered must be a list");
  }
  for (const concept of event.covered) assertValidConceptId(concept);
  assertNonempty(event.nextStep, "event.nextStep");
  if (typeof event.interpretation !== "string") {
    throw new Error("learner validation: event.interpretation must be text (may be empty)");
  }
  if (!Array.isArray(event.attempts)) {
    throw new Error("learner validation: event.attempts must be a list");
  }
  for (const attempt of event.attempts) {
    assertValidConceptId(attempt.concept);
    assertNonempty(attempt.task, "attempt.task");
    assertNonempty(attempt.response, "attempt.response");
    if (!ATTEMPT_RESULTS.includes(attempt.result)) {
      throw new Error(`learner validation: attempt.result must be one of ${ATTEMPT_RESULTS.join(", ")}`);
    }
    if (!ATTEMPT_HELPS.includes(attempt.help)) {
      throw new Error(`learner validation: attempt.help must be one of ${ATTEMPT_HELPS.join(", ")}`);
    }
    if (!ATTEMPT_KINDS.includes(attempt.kind)) {
      throw new Error(`learner validation: attempt.kind must be one of ${ATTEMPT_KINDS.join(", ")}`);
    }
  }
}
