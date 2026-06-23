import type { Interval } from "./types.js";

/**
 * Union overlapping/touching activity intervals into a single wall-clock
 * timeline so concurrently-supervised agents are not double-counted, and
 * report the total active minutes of that timeline.
 */
export function mergeIntervals(
  intervals: ReadonlyArray<Interval>,
): { merged: Interval[]; totalMinutes: number } {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) merged[merged.length - 1] = { start: last.start, end: iv.end };
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  const totalMinutes = merged.reduce((t, iv) => t + (iv.end - iv.start) / 60_000, 0);
  return { merged, totalMinutes };
}
