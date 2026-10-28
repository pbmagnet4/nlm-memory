import type { ProviderRow } from "./registries.js";

/**
 * The daemon's active classifier only ever reports "openai" (ClassifierBox
 * has one generic OpenAI-compatible provider), but a Providers-registry row
 * for the same endpoint may be kind "openai" (real OpenAI) or
 * "openai-compatible" (local/self-hosted, e.g. LM Studio) — both ride the
 * same swap path server-side. Treat both as a match for an active "openai"
 * classifier so the right row pre-selects and the dirty-check doesn't fire
 * on page load for a provider that hasn't actually changed.
 */
export function providerKindMatchesClassifier(kind: string, classifierProvider: string): boolean {
  if (kind === classifierProvider) return true;
  if (classifierProvider === "openai") return kind === "openai-compatible";
  return false;
}

/** The enabled registry row for the active classifier provider, or null when there is none (never another provider). */
export function activeProviderRow(
  providers: ReadonlyArray<ProviderRow>,
  classifierProvider: string,
): ProviderRow | null {
  return providers.find((p) => p.enabled && providerKindMatchesClassifier(p.kind, classifierProvider)) ?? null;
}
