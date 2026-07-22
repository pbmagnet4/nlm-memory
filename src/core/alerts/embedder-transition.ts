/**
 * Embedder-cold alert transition logic — fires once when the embedder
 * warmup flag flips ready→not-ready and STAYS not-ready across two
 * consecutive checks. A single-check dip is treated as a transient
 * blip (e.g. a lane restart mid-check), not an outage worth alerting on.
 *
 * Pure and clock-injected. See check-and-alert.ts for the caller that
 * reads warmupSnapshot(), threads the persisted state, and fires.
 */

import type { AlertEvent } from "./types.js";

export interface EmbedderAlertState {
  /** Consecutive not-ready checks seen so far (resets to 0 once ready again). */
  readonly notReadyStreak: number;
  /** ISO timestamp of the first not-ready check in the current streak, or null. */
  readonly since: string | null;
}

export const DEFAULT_EMBEDDER_ALERT_STATE: EmbedderAlertState = {
  notReadyStreak: 0,
  since: null,
};

const SUSTAIN_CHECK_COUNT = 2;

export interface EmbedderTransitionResult {
  readonly fire: boolean;
  readonly event: AlertEvent | null;
  readonly next: EmbedderAlertState;
}

export function evaluateEmbedderTransition(
  state: EmbedderAlertState,
  ready: boolean,
  now: Date,
): EmbedderTransitionResult {
  if (ready) {
    if (state.notReadyStreak === 0 && state.since === null) {
      return { fire: false, event: null, next: state };
    }
    // Recovered — reset so the next ready→not-ready edge can fire again.
    return { fire: false, event: null, next: DEFAULT_EMBEDDER_ALERT_STATE };
  }

  const streak = state.notReadyStreak + 1;
  const since = state.since ?? now.toISOString();

  if (streak === SUSTAIN_CHECK_COUNT) {
    // Sustained across the 2nd consecutive check — fire once. Streak
    // keeps climbing on later checks but never re-hits exactly this
    // value, so this is a single edge-triggered fire per cold episode.
    return {
      fire: true,
      event: {
        type: "nlm.health.embedder_cold",
        data: { current: "cold", latest: "ready", since },
      },
      next: { notReadyStreak: streak, since },
    };
  }

  return { fire: false, event: null, next: { notReadyStreak: streak, since } };
}
