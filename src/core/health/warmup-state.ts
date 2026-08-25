interface WarmupState {
  fts5: boolean;
  textEmbedder: boolean;
}

/**
 * Why a stage is still cold. A bare `false` is indistinguishable between "the
 * backend was absent at boot" and "this build is broken", and that ambiguity
 * cost three weeks chasing a release regression that did not exist. `since`
 * holds the FIRST failure so health can report how long the lane has been down
 * rather than only the latest retry.
 */
export interface WarmupFailure {
  readonly reason: string;
  readonly attempts: number;
  readonly since: string;
}

type FailureMap = Partial<Record<keyof WarmupState, WarmupFailure>>;

const state: WarmupState = { fts5: false, textEmbedder: false };
let failures: FailureMap = {};

export function markWarm(stage: keyof WarmupState): void {
  state[stage] = true;
  delete failures[stage];
}

export function markWarmFailure(stage: keyof WarmupState, reason: string, attempts: number): void {
  const since = failures[stage]?.since ?? new Date().toISOString();
  failures[stage] = { reason, attempts, since };
}

export function warmupSnapshot(): {
  fts5: boolean;
  textEmbedder: boolean;
  ready: boolean;
  lastError?: FailureMap;
} {
  const ready = state.fts5 && state.textEmbedder;
  const hasFailure = Object.keys(failures).length > 0;
  return {
    fts5: state.fts5,
    textEmbedder: state.textEmbedder,
    ready,
    ...(hasFailure ? { lastError: { ...failures } } : {}),
  };
}

export function resetWarmupState(): void {
  state.fts5 = false;
  state.textEmbedder = false;
  failures = {};
}
