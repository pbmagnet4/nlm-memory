// src/core/workstream/match.ts
import type { MatchDecision, MatchInputs } from "./model.js";

export function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a), setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function matchWorkstream(inputs: MatchInputs): MatchDecision {
  const { sessionEntities, neighborScores, candidates, thresholds, weights } = inputs;

  const scored = candidates
    .map((c) => {
      const semantic = neighborScores.get(c.workstreamId) ?? 0;
      const entity = jaccard(sessionEntities, c.entities);
      return { workstreamId: c.workstreamId, score: weights.semantic * semantic + weights.entity * entity };
    })
    .sort((x, y) => y.score - x.score);

  const top = scored[0];
  if (!top || top.score < thresholds.low) {
    return { kind: "create", confidence: top?.score ?? 0 };
  }
  if (top.score >= thresholds.high) {
    return { kind: "bind", workstreamId: top.workstreamId, confidence: top.score };
  }
  return { kind: "ambiguous", candidates: scored.slice(0, 5) };
}
