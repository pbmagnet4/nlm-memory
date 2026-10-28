/**
 * In-process classify outcomes over a rolling 60-minute window, recorded by
 * the scheduler and read by the ingest-lag health metric (ingest-lag.ts).
 * Process-local on purpose: a restart starts a fresh window, and `startedAt`
 * lets the reader tell "no progress yet" from "no progress for an hour".
 */

export const OUTCOME_WINDOW_MS = 60 * 60_000;

export type ClassifyFailureKind = "timeout" | "error";

interface Outcomes {
  startedAt: number;
  lastSuccessAt: number | null;
  lastProgressAt: number | null;
  successes: number[];
  timeouts: number[];
  errors: number[];
}

function fresh(now: number): Outcomes {
  return { startedAt: now, lastSuccessAt: null, lastProgressAt: null, successes: [], timeouts: [], errors: [] };
}

let outcomes: Outcomes = fresh(Date.now());

export function recordClassifySuccess(now: number = Date.now()): void {
  outcomes.lastSuccessAt = now;
  outcomes.successes.push(now);
}

/** Any outcome that advances adapter_state (classified, gate/hash/low-confidence/empty skip). */
export function recordIngestProgress(now: number = Date.now()): void {
  outcomes.lastProgressAt = now;
}

export function recordClassifyFailure(kind: ClassifyFailureKind, now: number = Date.now()): void {
  (kind === "timeout" ? outcomes.timeouts : outcomes.errors).push(now);
}

export interface ClassifyOutcomesSnapshot {
  readonly startedAt: number;
  readonly lastSuccessAt: number | null;
  readonly lastProgressAt: number | null;
  readonly successes1h: number;
  readonly timeouts1h: number;
  readonly errors1h: number;
}

export function classifyOutcomesSnapshot(now: number = Date.now()): ClassifyOutcomesSnapshot {
  const cutoff = now - OUTCOME_WINDOW_MS;
  const inWindow = (stamps: number[]): number[] => {
    const kept = stamps.filter((t) => t > cutoff);
    stamps.length = 0;
    stamps.push(...kept);
    return kept;
  };
  return {
    startedAt: outcomes.startedAt,
    lastSuccessAt: outcomes.lastSuccessAt,
    lastProgressAt: outcomes.lastProgressAt,
    successes1h: inWindow(outcomes.successes).length,
    timeouts1h: inWindow(outcomes.timeouts).length,
    errors1h: inWindow(outcomes.errors).length,
  };
}

export function resetClassifyOutcomes(now: number = Date.now()): void {
  outcomes = fresh(now);
}
