/**
 * Ingest-lag alert transition — fires once when the daemon has been lagging
 * for two consecutive checks (a single lagging check is a blip, e.g. a tick
 * just starting) and once more when it recovers. Pure and clock-injected;
 * see check-and-alert.ts for the caller.
 */

import type { IngestLagAlertEvent } from "./types.js";

export interface IngestLagAlertState {
  /** Consecutive lagging checks (0 once caught up). */
  readonly laggingStreak: number;
  /** ISO timestamp of the first lagging check in the current episode, or null. */
  readonly since: string | null;
  /** True once the entry alert has gone out, so recovery knows to announce itself. */
  readonly alerted: boolean;
}

export const DEFAULT_INGEST_LAG_ALERT_STATE: IngestLagAlertState = {
  laggingStreak: 0,
  since: null,
  alerted: false,
};

const SUSTAIN_CHECK_COUNT = 2;
const CAUGHT_UP = "caught up";

export interface IngestLagTransitionResult {
  readonly event: IngestLagAlertEvent | null;
  readonly next: IngestLagAlertState;
}

export function evaluateIngestLagTransition(
  state: IngestLagAlertState,
  lagging: boolean,
  summary: string,
  now: Date,
): IngestLagTransitionResult {
  if (!lagging) {
    if (!state.alerted) return { event: null, next: DEFAULT_INGEST_LAG_ALERT_STATE };
    return {
      event: {
        type: "nlm.health.ingest_lagging",
        data: { current: CAUGHT_UP, latest: CAUGHT_UP, since: state.since ?? now.toISOString() },
      },
      next: DEFAULT_INGEST_LAG_ALERT_STATE,
    };
  }

  const laggingStreak = state.laggingStreak + 1;
  const since = state.since ?? now.toISOString();
  if (laggingStreak === SUSTAIN_CHECK_COUNT) {
    return {
      event: { type: "nlm.health.ingest_lagging", data: { current: summary, latest: CAUGHT_UP, since } },
      next: { laggingStreak, since, alerted: true },
    };
  }
  return { event: null, next: { laggingStreak, since, alerted: state.alerted } };
}
