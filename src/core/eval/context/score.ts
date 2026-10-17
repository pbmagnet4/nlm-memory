import type { ConfidenceInterval, ContextCase, ContextScore, ReaderAnswer } from "./types.js";

export function scoreContext(c: ContextCase, answer: ReaderAnswer): ContextScore {
  const expected = c.expected;
  const missingClaims = expected.claims.filter((text) => !answer.text.includes(text));
  const missingAlternatives = expected.alternatives.filter((text) => !answer.text.includes(text));
  const missingRanges = expected.sourceRanges.filter((range) => !answer.evidence.some((e) => e.sourceId === range.sourceId && e.text.includes(range.text)));
  return { sufficient: expected.answerable
    ? !answer.abstained && !missingClaims.length && !missingAlternatives.length && !missingRanges.length
    : answer.abstained && answer.evidence.length === 0,
  missingClaims, missingAlternatives, missingRanges };
}

export function groupedBootstrap(rows: readonly { family: string; baseline: number; candidate: number }[], samples = 2_000): ConfidenceInterval {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const values = groups.get(row.family) ?? [];
    values.push(row.candidate - row.baseline);
    groups.set(row.family, values);
  }
  const families = [...groups.values()];
  const delta = rows.length ? rows.reduce((sum, r) => sum + r.candidate - r.baseline, 0) / rows.length : null;
  if (families.length < 2) return { groups: families.length, samples: 0, delta, lower: null, upper: null };
  let seed = 806;
  const draws: number[] = [];
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < families.length; j++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const group = families[seed % families.length]!;
      sum += group.reduce((a, b) => a + b, 0);
      n += group.length;
    }
    draws.push(sum / n);
  }
  draws.sort((a, b) => a - b);
  return { groups: families.length, samples, delta, lower: draws[Math.floor(samples * 0.025)]!, upper: draws[Math.min(samples - 1, Math.floor(samples * 0.975))]! };
}
