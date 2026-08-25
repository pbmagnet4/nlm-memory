/**
 * Retry loop for a warmup probe that must survive a backend being absent.
 *
 * The embedder warmup used to be a single fire-and-forget attempt with an empty
 * catch. If the backend was not servable at that instant the stage latched cold
 * for the daemon's entire uptime, even after the backend returned, and only a
 * restart cleared it. Two costs, both real: a five-day silent outage while the
 * embedder was reachable throughout, and a three-week hunt for a release
 * "regression" that did not exist, because restarting inside the same outage
 * window reproduces the failure every time and reads as determinism.
 *
 * Pure except for the injected `sleep`, so the backoff schedule is testable
 * without timers. Never throws: a warmup probe must not be able to take down
 * the process it is reporting on.
 */

export interface RetryUntilWarmDeps {
  /** The probe. Resolving means the lane is live. */
  readonly attempt: () => Promise<unknown>;
  readonly onSuccess: () => void;
  /** Called per failed attempt so health can name the cause instead of showing a bare false. */
  readonly onFailure: (reason: string, attempt: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_BASE_DELAY_MS = 1_000;
// Caps the tail at a minute: long enough that a backend absent for hours costs
// ~60 cheap probes, short enough that recovery is noticed within a minute.
const DEFAULT_MAX_DELAY_MS = 60_000;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function retryUntilWarm(deps: RetryUntilWarmDeps): Promise<void> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deps.attempt();
      deps.onSuccess();
      return;
    } catch (err) {
      try {
        deps.onFailure(reasonOf(err), attempt);
      } catch {
        // A broken reporter must not end the retry loop.
      }
      if (attempt === maxAttempts) return;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      try {
        await deps.sleep(delay);
      } catch {
        return;
      }
    }
  }
}
