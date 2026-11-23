/**
 * Circuit breaker for recall-time query embeddings (T1774).
 *
 * Recall degrades to keyword search when the embedder is down, but without a
 * breaker every recall first waited out its full embed deadline (2s) against
 * a dead LiteLLM/oMLX lane, which is most of the prompt hook's budget. After
 * FAILURE_THRESHOLD consecutive failures the breaker opens and recall skips
 * the call outright. After the cool-down one probe goes through (half-open);
 * its failure doubles the cool-down up to MAX_COOLDOWN_MS, its success closes.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  /** ISO time the open state ends; null unless open. */
  readonly retryAt: string | null;
  readonly lastError: string | null;
  /** Calls answered without trying the dependency since the daemon started. */
  readonly shortCircuited: number;
}

export interface CircuitBreaker {
  /** True when a call may go to the dependency now; false means fail fast. */
  allow(): boolean;
  success(): void;
  failure(reason: string): void;
  /** A call that was allowed but ended for a reason that says nothing about the dependency. */
  release(): void;
  /** Back to the cold closed state. Test isolation — the process-wide breaker
   *  outlives a single test, so each one has to start from closed. No
   *  production caller. */
  reset(): void;
  snapshot(): BreakerSnapshot;
}

export const FAILURE_THRESHOLD = 3;
export const BASE_COOLDOWN_MS = 15_000;
export const MAX_COOLDOWN_MS = 300_000;

// The default clock is read through `Date` on every call rather than captured
// as `Date.now`: a breaker created at module load — `recallEmbedBreaker` —
// would otherwise keep the native function even after a test replaces the
// global, and its cool-down could never be advanced. Same shape as the `now`
// default in createDiskGuard.
export function createCircuitBreaker(now: () => number = () => Date.now()): CircuitBreaker {
  let failures = 0;
  let cooldownMs = BASE_COOLDOWN_MS;
  let openUntil: number | null = null;
  let probing = false;
  let lastError: string | null = null;
  let shortCircuited = 0;

  const state = (): BreakerState => {
    if (openUntil === null) return "closed";
    return now() >= openUntil ? "half-open" : "open";
  };

  return {
    allow() {
      const s = state();
      if (s === "closed") return true;
      if (s === "half-open" && !probing) {
        probing = true;
        return true;
      }
      shortCircuited += 1;
      return false;
    },
    success() {
      failures = 0;
      cooldownMs = BASE_COOLDOWN_MS;
      openUntil = null;
      probing = false;
    },
    failure(reason) {
      lastError = reason;
      failures += 1;
      if (probing) {
        probing = false;
        cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
        openUntil = now() + cooldownMs;
      } else if (openUntil === null && failures >= FAILURE_THRESHOLD) {
        openUntil = now() + cooldownMs;
      }
    },
    release() {
      probing = false;
    },
    reset() {
      failures = 0;
      cooldownMs = BASE_COOLDOWN_MS;
      openUntil = null;
      probing = false;
      lastError = null;
      shortCircuited = 0;
    },
    snapshot() {
      const s = state();
      return {
        state: s,
        consecutiveFailures: failures,
        retryAt: s === "open" && openUntil !== null ? new Date(openUntil).toISOString() : null,
        lastError,
        shortCircuited,
      };
    },
  };
}

/** The process-wide breaker for the prose query-embedding lane. */
export const recallEmbedBreaker: CircuitBreaker = createCircuitBreaker();
