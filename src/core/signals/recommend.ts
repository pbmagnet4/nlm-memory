/**
 * Turn failure modes into human-actionable recommendations. Surface + recommend
 * only - nothing here mutates config or swaps models (v1 scope guardrail).
 */

import type { FailureMode } from "./aggregate.js";

export interface Recommendation {
  readonly kind: "model-swap" | "agents-rule";
  readonly text: string;
}

export interface RecommendOptions {
  readonly swapThreshold?: number;
}

export function recommendActions(modes: ReadonlyArray<FailureMode>, opts: RecommendOptions = {}): ReadonlyArray<Recommendation> {
  const swapThreshold = opts.swapThreshold ?? 0.5;
  const recs: Recommendation[] = [];
  for (const m of modes) {
    if (m.failRate >= swapThreshold) {
      recs.push({
        kind: "model-swap",
        text: `Consider a different default model for ${m.repo}: ${m.model} fails ${Math.round(m.failRate * 100)}% of ${m.kind} checks (n=${m.total}).`,
      });
    }
    if (m.step) {
      recs.push({
        kind: "agents-rule",
        text: `Propose an AGENTS.md rule in ${m.repo} addressing the "${m.step}" step (${m.model} fails it ${Math.round(m.failRate * 100)}% of the time).`,
      });
    }
  }
  return recs;
}
