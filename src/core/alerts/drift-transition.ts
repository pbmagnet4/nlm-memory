/**
 * Version-drift alert transition logic — decides WHEN to fire, not
 * whether to fire on every poll. Firing on every `behind: true` read
 * would spam the webhook on every scheduled check; instead this tracks
 * the false→true edge (fire once) and a daily re-fire while the daemon
 * stays behind past a 48h grace window (so a long-ignored update still
 * resurfaces, but not hourly).
 *
 * Pure and clock-injected — no fs/network here. Callers (see
 * check-and-alert.ts) own reading/writing the persisted state and
 * calling fireAlert with the returned event.
 */

import type { UpdateStatus } from "../update-check/check.js";
import type { AlertEvent } from "./types.js";

export interface DriftAlertState {
  /** ISO timestamp of when `behind` first became true, or null when not behind. */
  readonly behindSince: string | null;
  /** ISO timestamp of the last fired alert (initial or daily re-fire). */
  readonly lastFiredAt: string | null;
}

export const DEFAULT_DRIFT_ALERT_STATE: DriftAlertState = {
  behindSince: null,
  lastFiredAt: null,
};

const SUSTAIN_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const REFIRE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface DriftTransitionResult {
  readonly fire: boolean;
  readonly event: AlertEvent | null;
  readonly next: DriftAlertState;
}

export function evaluateDriftTransition(
  state: DriftAlertState,
  status: Pick<UpdateStatus, "current" | "latest" | "behind">,
  now: Date,
): DriftTransitionResult {
  if (!status.behind) {
    // Recovered (or never behind) — reset so a future false→true edge
    // fires again instead of being suppressed by stale state.
    if (state.behindSince === null) return { fire: false, event: null, next: state };
    return { fire: false, event: null, next: DEFAULT_DRIFT_ALERT_STATE };
  }

  const nowIso = now.toISOString();
  const latest = status.latest ?? "unknown";

  if (state.behindSince === null) {
    // false → true edge: fire once.
    return {
      fire: true,
      event: {
        type: "nlm.drift.version_behind",
        data: { current: status.current, latest, since: nowIso },
      },
      next: { behindSince: nowIso, lastFiredAt: nowIso },
    };
  }

  const sustainedMs = now.getTime() - Date.parse(state.behindSince);
  const sinceLastFireMs = state.lastFiredAt
    ? now.getTime() - Date.parse(state.lastFiredAt)
    : Infinity;

  if (sustainedMs >= SUSTAIN_THRESHOLD_MS && sinceLastFireMs >= REFIRE_INTERVAL_MS) {
    return {
      fire: true,
      event: {
        type: "nlm.drift.version_behind",
        data: { current: status.current, latest, since: state.behindSince },
      },
      next: { behindSince: state.behindSince, lastFiredAt: nowIso },
    };
  }

  return { fire: false, event: null, next: state };
}
