/**
 * Content-aware canary for hook injection quality.
 *
 * The hook-liveness canary (hook-liveness.ts) detects a dead firing lane:
 * the hook stopped running entirely. This canary detects two subtler failures
 * on fires that did happen:
 *
 * Tier 1 (dead recall lane): every fire returns zero candidates AND zero
 * injections. The hook runs but the daemon returns nothing, pointing at
 * recall latency exceeding NLM_HOOK_RECALL_TIMEOUT_MS or an empty corpus.
 *
 * Tier 2 (selection eating everything): the daemon returns candidates (hits
 * present) but selection filters every one before injection, pointing at a
 * score-floor misconfiguration. Mutually exclusive with tier 1 by
 * construction: tier 2 requires at least one hits-bearing fire, tier 1
 * requires none.
 *
 * Pinned constants from the #397 spec:
 * WINDOW_MS: 48h, wider than the liveness canary's yesterday window, so that
 * overnight batch sessions that straddle midnight stay in scope.
 * MIN_FIRES: 10, minimum to distinguish a silent injection lane from a
 * legitimately quiet day with few prompts.
 */

import { isProbe } from "../telemetry/probe-filter.js";

const WINDOW_MS = 48 * 60 * 60 * 1000;
const MIN_FIRES = 10;

export interface InjectionLogEntry {
  readonly ts?: string;
  readonly mode?: string;
  readonly gate?: string;
  readonly wouldInject?: ReadonlyArray<unknown>;
  readonly hits?: ReadonlyArray<unknown>;
  readonly query?: string | null;
  readonly prompt?: string | null;
  readonly promptPreview?: string | null;
}

export interface InjectionCheckResult {
  readonly ok: boolean;
  readonly message: string | null;
}

/**
 * Alarms when the hook fires frequently but injects nothing over the 48h window.
 *
 * Pure function: no I/O, no side effects. Pass the raw hook-log lines.
 */
export function checkHookInjection(
  entries: ReadonlyArray<InjectionLogEntry>,
  now?: Date,
): InjectionCheckResult {
  const cutoff = (now ?? new Date()).getTime() - WINDOW_MS;

  let fires = 0;
  let injecting = 0;
  let hitsBearing = 0;

  for (const entry of entries) {
    if (entry.mode !== "live") continue;

    // Gated-off prompts log hits: [] / wouldInject: [] by design, so an empty
    // fire there is expected behavior, not evidence of a dead recall lane.
    if (entry.gate === "generative" || entry.gate === "skip") continue;

    const hasWouldInject = Array.isArray(entry.wouldInject);
    const hasHits = Array.isArray(entry.hits);
    if (!hasWouldInject && !hasHits) continue;

    const ts = entry.ts ? Date.parse(entry.ts) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;

    // Null sentinel, not "": isProbe("") is true (empty string is in the
    // exact-match probe set), so falling back to "" would silently exclude
    // every query-less fire; null keeps them counted.
    const queryText = entry.query ?? entry.prompt ?? entry.promptPreview ?? null;
    if (isProbe(queryText)) continue;

    fires++;

    if (Array.isArray(entry.wouldInject) && entry.wouldInject.length > 0) {
      injecting++;
    }
    if (Array.isArray(entry.hits) && entry.hits.length > 0) {
      hitsBearing++;
    }
  }

  if (fires >= MIN_FIRES && injecting === 0) {
    if (hitsBearing > 0) {
      return {
        ok: false,
        message:
          "WARN hook selection filtering all hits: daemon returns candidates but none pass selection; check NLM_RECALL_SCORE_FLOOR / NLM_RECALL_REL_FLOOR",
      };
    }
    return {
      ok: false,
      message:
        "WARN hook injecting nothing: check daemon recall latency vs NLM_HOOK_RECALL_TIMEOUT_MS or an empty corpus; see the load-bearing canary section in docs/hooks.md",
    };
  }

  return { ok: true, message: null };
}
