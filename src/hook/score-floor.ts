/**
 * Parses the NLM_RECALL_SCORE_FLOOR env knob into a safe BM25 score cutoff.
 *
 * A bad value (NaN, non-finite, negative) must never silently flip recall into
 * admit-all or deny-all. The unguarded `Number(env ?? "0")` returns NaN for a
 * non-numeric value, and `matchScore >= NaN` is always false in select.ts —
 * that would silently deny-all. This guard collapses every invalid input back
 * to the safe default of 0 (no cutoff, FTS5 MATCH still gates relevance).
 *
 * Default stays 0: the calibrated keyword-mode floor (2.0, per the score-floor
 * diagnostic on raw BM25 scores) is NOT a safe global default — the
 * session-start hook recalls in hybrid mode whose matchScore is normalized to
 * 0..1, so a 2.0 floor would deny-all there. The calibrated value is pending a
 * per-mode application and ships as an opt-in env override only.
 */
export function parseScoreFloor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Parses NLM_RECALL_REL_FLOOR into a fire-median-relative cutoff: drop hits
 * scoring below this fraction of the fire's median score. Unlike the absolute
 * floor above, this is scale-invariant (a ratio), so the SAME value works on
 * raw BM25 (keyword) or normalized (hybrid) scores and ports across installs.
 * Invalid input collapses to the supplied default; 0 disables. Calibrated to
 * 0.9 on the keyword/per-message path (scripts/eval/floor-calibration.ts, #284):
 * keeps ~97% of cited recalls, trims weak tail noise. Set to 0.8 for zero
 * measured gold loss, or 0 to disable.
 */
export function parseRelativeFloor(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
