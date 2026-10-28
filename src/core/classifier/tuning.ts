/**
 * Classifier tuning: thinking mode, per-call timeout and output-token budget.
 * Effective value precedence: persisted setting > env var > built-in default.
 */

import type {
  ClassifierThinking,
  StoredClassifierSettings,
} from "@ports/classifier-settings-store.js";

export type TuningSource = "setting" | "env" | "default";

export interface Tuned<T> {
  readonly value: T;
  readonly source: TuningSource;
}

export interface ClassifierTuning {
  readonly thinking: Tuned<ClassifierThinking>;
  readonly timeoutMs: Tuned<number>;
  readonly maxTokens: Tuned<number>;
}

export const DEFAULT_THINKING: ClassifierThinking = "off";
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 120_000;
/** Matches the OpenAI-compatible client's built-in output budget. */
export const DEFAULT_CLASSIFY_MAX_TOKENS = 8192;

export const TIMEOUT_MS_RANGE = { min: 10_000, max: 900_000 } as const;
export const MAX_TOKENS_RANGE = { min: 256, max: 65_536 } as const;

export function isThinking(v: unknown): v is ClassifierThinking {
  return v === "off" || v === "on";
}

export function isIntInRange(v: unknown, range: { min: number; max: number }): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= range.min && v <= range.max;
}

function parseEnvInt(raw: string | undefined, range: { min: number; max: number }): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return isIntInRange(n, range) ? n : null;
}

function pick<T>(stored: T | null, env: T | null, fallback: T): Tuned<T> {
  if (stored !== null) return { value: stored, source: "setting" };
  if (env !== null) return { value: env, source: "env" };
  return { value: fallback, source: "default" };
}

/**
 * Pure resolver. An invalid env value is ignored (the default applies) and
 * reported through `warn`, which the daemon passes only at boot.
 */
export function resolveClassifierTuning(
  stored: StoredClassifierSettings,
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {},
): ClassifierTuning {
  const envThinkingRaw = env["NLM_CLASSIFIER_THINKING"];
  const envThinking = isThinking(envThinkingRaw) ? envThinkingRaw : null;
  if (envThinkingRaw !== undefined && envThinking === null) {
    warn(`ignoring NLM_CLASSIFIER_THINKING=${JSON.stringify(envThinkingRaw)}: expected "off" or "on"`);
  }
  const envTimeout = parseEnvInt(env["NLM_CLASSIFIER_TIMEOUT_MS"], TIMEOUT_MS_RANGE);
  if (env["NLM_CLASSIFIER_TIMEOUT_MS"] !== undefined && envTimeout === null) {
    warn(`ignoring NLM_CLASSIFIER_TIMEOUT_MS=${JSON.stringify(env["NLM_CLASSIFIER_TIMEOUT_MS"])}: expected an integer ${TIMEOUT_MS_RANGE.min}..${TIMEOUT_MS_RANGE.max}`);
  }
  const envMaxTokens = parseEnvInt(env["NLM_CLASSIFIER_MAX_TOKENS"], MAX_TOKENS_RANGE);
  if (env["NLM_CLASSIFIER_MAX_TOKENS"] !== undefined && envMaxTokens === null) {
    warn(`ignoring NLM_CLASSIFIER_MAX_TOKENS=${JSON.stringify(env["NLM_CLASSIFIER_MAX_TOKENS"])}: expected an integer ${MAX_TOKENS_RANGE.min}..${MAX_TOKENS_RANGE.max}`);
  }
  return {
    thinking: pick(stored.thinking, envThinking, DEFAULT_THINKING),
    timeoutMs: pick(stored.timeoutMs, envTimeout, DEFAULT_CLASSIFY_TIMEOUT_MS),
    maxTokens: pick(stored.maxTokens, envMaxTokens, DEFAULT_CLASSIFY_MAX_TOKENS),
  };
}

export const NO_STORED_SETTINGS: StoredClassifierSettings = { thinking: null, timeoutMs: null, maxTokens: null };
