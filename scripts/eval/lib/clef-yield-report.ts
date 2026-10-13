import { auc, wilson } from "./clef-stats.js";

export interface YieldRow {
  readonly id: string;
  readonly runtime: string;
  readonly chars: number;
  readonly score: number | null;
  readonly ms: number;
  readonly decisions: number;
  readonly facts: number;
  readonly opens: number;
}

export const yields = (r: YieldRow): boolean => r.decisions + r.facts > 0;

export interface YieldStats {
  readonly scored: number;
  readonly skipped: number;
  readonly skippableTotal: number;
  readonly skippableSkipped: number;
  readonly yieldingTotal: number;
  readonly yieldingLost: number;
  readonly yieldingLostUpper: number;
  readonly decisionsTotal: number;
  readonly decisionsLost: number;
  readonly factsTotal: number;
  readonly factsLost: number;
}

/** Cost of skipping every session whose score is under `threshold`. Unscored sessions are kept. */
export function yieldStats(rows: ReadonlyArray<YieldRow>, threshold: number): YieldStats {
  const scored = rows.filter((r) => r.score !== null);
  const skipped = scored.filter((r) => (r.score as number) < threshold);
  const yielding = scored.filter(yields);
  const lost = skipped.filter(yields);
  const skippable = scored.filter((r) => !yields(r));
  const sum = (xs: ReadonlyArray<YieldRow>, f: (r: YieldRow) => number) => xs.reduce((s, r) => s + f(r), 0);
  return {
    scored: scored.length,
    skipped: skipped.length,
    skippableTotal: skippable.length,
    skippableSkipped: skipped.filter((r) => !yields(r)).length,
    yieldingTotal: yielding.length,
    yieldingLost: lost.length,
    yieldingLostUpper: wilson(lost.length, yielding.length)[1],
    decisionsTotal: sum(scored, (r) => r.decisions),
    decisionsLost: sum(skipped, (r) => r.decisions),
    factsTotal: sum(scored, (r) => r.facts),
    factsLost: sum(skipped, (r) => r.facts),
  };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

export function printYieldReport(rows: ReadonlyArray<YieldRow>, threshold: number, thresholds: ReadonlyArray<number> = [1, 1.25, 1.5, 1.75, 2]): void {
  const scored = rows.filter((r): r is YieldRow & { score: number } => r.score !== null);
  console.log(`sessions scored: ${scored.length} of ${rows.length}; with stored decisions or facts: ${scored.filter(yields).length}; none stored: ${scored.filter((r) => !yields(r)).length}`);
  console.log(`AUC of gate score for "stored anything": ${auc(scored.map((r) => ({ score: r.score, positive: yields(r) }))).toFixed(3)}`);
  const line = (label: string, part: ReadonlyArray<YieldRow>, t: number) => {
    const s = yieldStats(part, t);
    console.log(`${label} thr ${t}: skip ${pct(s.skipped, s.scored)} of sessions | stored-nothing sessions skipped ${s.skippableSkipped} of ${s.skippableTotal} | yielding sessions lost ${s.yieldingLost} of ${s.yieldingTotal} (upper ${(100 * s.yieldingLostUpper).toFixed(1)}%) | decisions lost ${s.decisionsLost} of ${s.decisionsTotal} (${pct(s.decisionsLost, s.decisionsTotal)}), facts lost ${s.factsLost} of ${s.factsTotal} (${pct(s.factsLost, s.factsTotal)})`);
  };
  for (const t of thresholds) line("all", rows, t);
  console.log(`\nfrozen threshold ${threshold} by runtime:`);
  for (const rt of [...new Set(rows.map((r) => r.runtime))]) {
    const part = rows.filter((r) => r.runtime === rt);
    if (part.filter((r) => r.score !== null).length >= 15) line(rt, part, threshold);
  }
  const losses = scored.filter((r) => r.score < threshold && yields(r)).sort((a, b) => b.decisions + b.facts - (a.decisions + a.facts)).slice(0, 5);
  console.log(`\nlargest losses at ${threshold} (id prefix, score, decisions, facts, chars): ${losses.map((r) => `${r.id.slice(0, 12)} ${r.score.toFixed(2)} ${r.decisions} ${r.facts} ${r.chars}`).join(" | ")}`);
  const ms = scored.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`clef latency p50 ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms`);
}
