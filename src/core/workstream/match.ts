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

export function scoreCandidates(inputs: MatchInputs): Array<{ workstreamId: string; score: number }> {
  const { sessionEntities, neighborScores, candidates, weights } = inputs;
  return candidates
    .map((c) => ({
      workstreamId: c.workstreamId,
      score: weights.semantic * (neighborScores.get(c.workstreamId) ?? 0) + weights.entity * jaccard(sessionEntities, c.entities),
    }))
    .sort((x, y) => y.score - x.score);
}

export function matchWorkstream(inputs: MatchInputs): MatchDecision {
  const { thresholds } = inputs;
  const scored = scoreCandidates(inputs);

  const top = scored[0];
  if (!top || top.score < thresholds.low) {
    return { kind: "create", confidence: top?.score ?? 0 };
  }
  if (top.score >= thresholds.high) {
    return { kind: "bind", workstreamId: top.workstreamId, confidence: top.score };
  }
  return { kind: "ambiguous", candidates: scored.slice(0, 5) };
}
