/**
 * Embedder-cold alert transition logic — fires when the embedder warmup
 * flag flips ready→not-ready and STAYS not-ready across two consecutive
 * checks. A single-check dip is treated as a transient blip (e.g. a lane
 * restart mid-check), not an outage worth alerting on.
 *
 * While the lane stays cold the alert re-fires every EMBEDDER_REALERT_MS
 * (T1867). A single fire was not enough: on 2026-11-12 the embedder went
 * cold for 25 hours on one message that nobody acted on, and the edge-
 * triggered version had nothing left to say.
 *
 * Pure and clock-injected. See check-and-alert.ts for the caller that
 * reads warmupSnapshot(), threads the persisted state, and fires.
 */

import type { EmbedderAlertEvent } from "./types.js";

export interface EmbedderAlertState {
  /** Consecutive not-ready checks seen so far (resets to 0 once ready again). */
  readonly notReadyStreak: number;
  /** ISO timestamp of the first not-ready check in the current streak, or null. */
  readonly since: string | null;
  /** ISO timestamp of the last fired alert (initial or 6h re-alert), or null. */
  readonly lastFiredAt: string | null;
}

export const DEFAULT_EMBEDDER_ALERT_STATE: EmbedderAlertState = {
  notReadyStreak: 0,
  since: null,
  lastFiredAt: null,
};

const SUSTAIN_CHECK_COUNT = 2;

/** How long a cold episode goes without another message before we re-alert. */
export const EMBEDDER_REALERT_MS = 6 * 60 * 60_000;

export interface EmbedderTransitionResult {
  readonly fire: boolean;
  readonly event: EmbedderAlertEvent | null;
  readonly next: EmbedderAlertState;
}

export function evaluateEmbedderTransition(
  state: EmbedderAlertState,
  ready: boolean,
  now: Date,
): EmbedderTransitionResult {
  if (ready) {
    if (state.notReadyStreak === 0 && state.since === null && state.lastFiredAt === null) {
      return { fire: false, event: null, next: state };
    }
    // Recovered — reset so the next ready→not-ready edge can fire again.
    // No recovery alert: the absence of the next re-alert is the signal.
    return { fire: false, event: null, next: DEFAULT_EMBEDDER_ALERT_STATE };
  }

  const streak = state.notReadyStreak + 1;
  const since = state.since ?? now.toISOString();
  // An episode older than its own first alert runs on the 6h clock; when
  // the state predates lastFiredAt there is no recorded fire to measure
  // from, so it counts as due — a mid-episode upgrade then re-alerts on
  // the next check instead of going quiet for the rest of the outage.
  const sinceLastFireMs = state.lastFiredAt
    ? now.getTime() - Date.parse(state.lastFiredAt)
    : Infinity;

  const firstFire = streak === SUSTAIN_CHECK_COUNT;
  // Sustained across the 2nd consecutive check — fire. After that the
  // 6h clock decides: streak keeps climbing, so the re-alert is level-
  // triggered on "still cold, and >6h since we last said so".
  if (firstFire || (streak > SUSTAIN_CHECK_COUNT && sinceLastFireMs >= EMBEDDER_REALERT_MS)) {
    const nowIso = now.toISOString();
    return {
      fire: true,
      event: {
        type: "nlm.health.embedder_cold",
        // The first fire's payload is unchanged (n8n consumes it); repeats
        // add the two fields a relay needs to say "still down, 25h now".
        data: firstFire
          ? { current: "cold", latest: "ready", since }
          : {
              current: "cold",
              latest: "ready",
              since,
              repeat: true,
              downMinutes: Math.floor((now.getTime() - Date.parse(since)) / 60_000),
            },
      },
      next: { notReadyStreak: streak, since, lastFiredAt: nowIso },
    };
  }

  return {
    fire: false,
    event: null,
    next: { notReadyStreak: streak, since, lastFiredAt: state.lastFiredAt },
  };
}
