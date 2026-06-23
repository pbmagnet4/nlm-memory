import type { Interval } from "./types.js";

/**
 * Collapse a session's message timestamps into activity intervals. Consecutive
 * messages no more than `idleThresholdMin` apart belong to the same span; a
 * larger gap means the operator was away and starts a new span. A lone message
 * yields a zero-length span (it marks activity but adds no minutes).
 */
export function activeSpans(
  timestampsMs: ReadonlyArray<number>,
  idleThresholdMin: number,
): Interval[] {
  const ts = [...timestampsMs].sort((a, b) => a - b);
  if (ts.length === 0) return [];
  const gapMs = idleThresholdMin * 60_000;
  const spans: Interval[] = [];
  let start = ts[0]!;
  let prev = ts[0]!;
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t - prev <= gapMs) {
      prev = t;
    } else {
      spans.push({ start, end: prev });
      start = t;
      prev = t;
    }
  }
  spans.push({ start, end: prev });
  return spans;
}
