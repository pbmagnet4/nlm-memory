/**
 * ClassifierSettingsStore — daemon-wide persisted classifier tuning (one row,
 * not per-tenant: one classifier serves the whole daemon). `null` means "not
 * set": the effective value falls back to env, then the built-in default.
 */

export type ClassifierThinking = "off" | "on";

export interface StoredClassifierSettings {
  readonly thinking: ClassifierThinking | null;
  readonly timeoutMs: number | null;
  readonly maxTokens: number | null;
}

/** A key left undefined is untouched; `null` clears the stored value. */
export type ClassifierSettingsUpdate = Partial<StoredClassifierSettings>;

export interface ClassifierSettingsStore {
  get(): Promise<StoredClassifierSettings>;
  update(patch: ClassifierSettingsUpdate): Promise<StoredClassifierSettings>;
}

export function applySettingsUpdate(
  current: StoredClassifierSettings,
  patch: ClassifierSettingsUpdate,
): StoredClassifierSettings {
  return {
    thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
    timeoutMs: patch.timeoutMs === undefined ? current.timeoutMs : patch.timeoutMs,
    maxTokens: patch.maxTokens === undefined ? current.maxTokens : patch.maxTokens,
  };
}
