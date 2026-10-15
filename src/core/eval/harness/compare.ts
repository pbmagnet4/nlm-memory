/**
 * Delta view between two harness reports (baseline vs candidate), with the
 * plan's rule 4 check: any fact R@1 loss is a regression regardless of gains.
 */

import type { HarnessReport } from "./run.js";

export interface Delta {
  readonly metric: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
}

export interface Comparison {
  readonly deltas: ReadonlyArray<Delta>;
  readonly factR1Regressions: ReadonlyArray<Delta>;
}

const EPS = 1e-9;

function row(metric: string, a: number | null | undefined, b: number | null | undefined): Delta {
  const baseline = a ?? null;
  const candidate = b ?? null;
  return { metric, baseline, candidate, delta: baseline === null || candidate === null ? null : candidate - baseline };
}

export function compareReports(base: HarnessReport, cand: HarnessReport): Comparison {
  const deltas: Delta[] = [];
  const factR1: Delta[] = [];
  for (const lane of ["session", "fact"] as const) {
    for (const split of ["dev", "heldout"] as const) {
      const modes = new Set([...Object.keys(base.retrieval[lane][split]), ...Object.keys(cand.retrieval[lane][split])]);
      for (const mode of modes) {
        const a = base.retrieval[lane][split][mode];
        const b = cand.retrieval[lane][split][mode];
        for (const m of ["rAt1", "rAt5", "mrr"] as const) {
          const d = row(`${lane}.${split}.${mode}.${m}`, a?.[m], b?.[m]);
          deltas.push(d);
          if (lane === "fact" && m === "rAt1" && d.delta !== null && d.delta < -EPS) factR1.push(d);
        }
      }
    }
  }
  deltas.push(
    row("store.conflictingActiveFacts", base.store.conflictingActiveFacts, cand.store.conflictingActiveFacts),
    row("store.missingEmbeddingShare", base.store.missingEmbeddingShare, cand.store.missingEmbeddingShare),
    row("store.dbBytes", sum(base.store.dbBytesByTable), sum(cand.store.dbBytesByTable)),
    row("hook.p50Tokens", base.hookTokens.p50, cand.hookTokens.p50),
    row("hook.p95Tokens", base.hookTokens.p95, cand.hookTokens.p95),
    row("hook.meanTokens", base.hookTokens.meanPerCall, cand.hookTokens.meanPerCall),
    row("reDerivation.rate", base.reDerivation.rate, cand.reDerivation.rate),
    row("citation.blendedHookPrecision", base.citation.blendedHookPrecision, cand.citation.blendedHookPrecision),
  );
  const sources = new Set([...base.citation.perSource, ...cand.citation.perSource].map((p) => p.source));
  for (const s of sources) {
    deltas.push(
      row(
        `citation.${s}`,
        base.citation.perSource.find((p) => p.source === s)?.precision,
        cand.citation.perSource.find((p) => p.source === s)?.precision,
      ),
    );
  }
  return { deltas, factR1Regressions: factR1 };
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

const fmt = (v: number | null): string => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(4));

export function formatComparison(c: Comparison): string {
  const lines = ["metric".padEnd(44) + "baseline".padStart(14) + "candidate".padStart(14) + "delta".padStart(12)];
  for (const d of c.deltas) {
    const sign = d.delta !== null && d.delta > 0 ? "+" : "";
    lines.push(
      d.metric.padEnd(44) + fmt(d.baseline).padStart(14) + fmt(d.candidate).padStart(14) + (d.delta === null ? "n/a" : sign + fmt(d.delta)).padStart(12),
    );
  }
  if (c.factR1Regressions.length > 0) {
    lines.push("", "REGRESSION (plan rule 4: a fact R@1 loss rejects the change):");
    for (const d of c.factR1Regressions) lines.push(`  ${d.metric}: ${fmt(d.baseline)} -> ${fmt(d.candidate)}`);
  } else {
    lines.push("", "No fact R@1 regression.");
  }
  return lines.join("\n");
}
