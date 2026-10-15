/**
 * Process-wide cap on concurrent classifier LLM requests. The classifier
 * server is shared with interactive callers, so the daemon queues its own work
 * instead of fanning out. `NLM_CLASSIFY_MAX_INFLIGHT` sets the cap (default 1).
 */
export interface Limiter {
  readonly max: number;
  run<T>(work: () => Promise<T>): Promise<T>;
}

const DEFAULT_MAX_INFLIGHT = 1;

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };
  return {
    max,
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

export function limiterFromEnv(env: NodeJS.ProcessEnv = process.env): Limiter {
  const parsed = Number(env["NLM_CLASSIFY_MAX_INFLIGHT"]);
  return createLimiter(Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_INFLIGHT);
}

let shared: Limiter | undefined;

/** The one limiter every daemon classifier call goes through. */
export function sharedClassifyLimiter(): Limiter {
  shared ??= limiterFromEnv();
  return shared;
}
