/**
 * Learner summary derivation — port of the Gnos deterministic summary rule
 * (`skills/learner-tracking/references/evidence.md`, MIT, attribution kept).
 *
 * Per concept, from events in `listEvents` order ((date, id) ascending):
 *
 * - covered, never attempted: **exposed**
 * - latest attempt assisted, partial, or incorrect: **practicing**
 * - latest attempt correct + unassisted: **demonstrated**
 * - latest success is retrieval/transfer on a strictly later date than an
 *   earlier unassisted success: **retained**
 *
 * Latest failure demotes back to practicing; earlier evidence is preserved in
 * the events, not in the label. These are workflow labels, not calibrated
 * scores — the summary never issues "mastered".
 */

import type { Attempt, LearningEvent } from "./model.js";

export type ConceptStatus = "exposed" | "practicing" | "demonstrated" | "retained";

export interface ConceptSummary {
  readonly concept: string;
  readonly status: ConceptStatus;
  readonly attemptCount: number;
  /** Latest attempt date, else the date the concept was last covered. */
  readonly latestDate: string | null;
  /** Latest attempt's task, or null when never attempted. */
  readonly latestTask: string | null;
}

interface DatedAttempt {
  readonly attempt: Attempt;
  readonly date: string;
}

function isUnassistedSuccess(a: Attempt): boolean {
  return a.result === "correct" && a.help === "none";
}

export function summarizeConcepts(events: ReadonlyArray<LearningEvent>): ReadonlyArray<ConceptSummary> {
  const coveredOn = new Map<string, string>();
  const attemptsByConcept = new Map<string, DatedAttempt[]>();

  for (const event of events) {
    for (const concept of event.covered) coveredOn.set(concept, event.date);
    for (const attempt of event.attempts) {
      let list = attemptsByConcept.get(attempt.concept);
      if (!list) {
        list = [];
        attemptsByConcept.set(attempt.concept, list);
      }
      list.push({ attempt, date: event.date });
      if (!coveredOn.has(attempt.concept)) coveredOn.set(attempt.concept, event.date);
    }
  }

  const concepts = [...new Set([...coveredOn.keys(), ...attemptsByConcept.keys()])].sort();
  return concepts.map((concept) => {
    const attempts = attemptsByConcept.get(concept) ?? [];
    if (attempts.length === 0) {
      return {
        concept,
        status: "exposed" as const,
        attemptCount: 0,
        latestDate: coveredOn.get(concept) ?? null,
        latestTask: null,
      };
    }
    const latest = attempts[attempts.length - 1]!;
    let status: ConceptStatus;
    if (!isUnassistedSuccess(latest.attempt)) {
      status = "practicing";
    } else if (
      (latest.attempt.kind === "retrieval" || latest.attempt.kind === "transfer") &&
      attempts.some((a) => a.date < latest.date && isUnassistedSuccess(a.attempt))
    ) {
      status = "retained";
    } else {
      status = "demonstrated";
    }
    return {
      concept,
      status,
      attemptCount: attempts.length,
      latestDate: latest.date,
      latestTask: latest.attempt.task,
    };
  });
}
