/**
 * Wiki projection alert builders.
 *
 * Return types are Extract<> narrowings rather than the bare AlertEvent union
 * so callers and tests keep the discriminant, matching the convention the
 * other producers in this directory follow.
 */
import type { AlertEvent } from "./types.js";
import type { ProjectionResult } from "@core/wiki/types.js";

export function buildWikiFailureEvent(
  error: unknown,
): Extract<AlertEvent, { type: "nlm.wiki.projection_failed" }> {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    type: "nlm.wiki.projection_failed",
    data: {
      reason: "projection_failed",
      qualifying: 0,
      onDisk: 0,
      drift: 0,
      message: `wiki projection failed and the previous tree was left untouched: ${detail}`,
    },
  };
}

export function buildWikiDriftEvent(
  result: ProjectionResult,
): Extract<AlertEvent, { type: "nlm.wiki.coverage_drift" }> | null {
  if (result.coverageDrift === 0) return null;
  const direction =
    result.coverageDrift > 0
      ? `${result.coverageDrift} page(s) the corpus earned are missing from disk`
      : `${-result.coverageDrift} stale page(s) survived removal`;
  return {
    type: "nlm.wiki.coverage_drift",
    data: {
      reason: "coverage_drift",
      qualifying: result.qualifying,
      onDisk: result.onDisk,
      drift: result.coverageDrift,
      message: `wiki coverage drift: ${direction} (${result.qualifying} qualifying, ${result.onDisk} on disk)`,
    },
  };
}
