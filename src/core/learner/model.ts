// src/core/learner/model.ts
import { randomUUID } from "node:crypto";

export type EnrollmentStatus = "active" | "completed";

export type AttemptResult = "correct" | "partial" | "incorrect";
export type AttemptHelp = "none" | "hint" | "worked-example";
export type AttemptKind = "application" | "retrieval" | "transfer";

export interface Learner {
  readonly id: string;
  readonly label: string;
  readonly profile: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Attempt {
  readonly concept: string;
  readonly task: string;
  readonly response: string;
  readonly result: AttemptResult;
  readonly help: AttemptHelp;
  readonly kind: AttemptKind;
}

export interface LearningEvent {
  readonly id: string;
  readonly date: string;
  readonly covered: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly interpretation: string;
  readonly nextStep: string;
  readonly createdAt: string;
}

export interface Enrollment {
  readonly id: string;
  readonly learnerId: string;
  readonly courseId: string;
  readonly workstreamId: string | null;
  readonly planRef: string;
  readonly planRevision: number;
  readonly planFingerprint: string;
  readonly status: EnrollmentStatus;
  readonly completionHistory: ReadonlyArray<unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function makeEnrollmentId(): string {
  return `enr_${randomUUID()}`;
}

/**
 * Canonical JSON: object keys sorted recursively, arrays preserved. pg JSONB
 * reorders object keys on write, so byte comparison of round-tripped JSON
 * false-conflicts; canonical form is the only backend-agnostic equality.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface StoredEventContent {
  readonly date: string;
  readonly covered: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly interpretation: string;
  readonly nextStep: string;
}

/** Idempotent-record comparison: same event if all content fields match. */
export function learningEventContentEqual(
  input: { date: string; covered: ReadonlyArray<string>; attempts: ReadonlyArray<Attempt>; interpretation: string; nextStep: string },
  stored: StoredEventContent,
): boolean {
  return (
    input.date === stored.date &&
    canonicalJson(input.covered) === canonicalJson(stored.covered) &&
    canonicalJson(input.attempts) === canonicalJson(stored.attempts) &&
    input.interpretation === stored.interpretation &&
    input.nextStep === stored.nextStep
  );
}
