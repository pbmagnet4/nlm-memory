/**
 * Dream-pass scoring core.
 *
 * Pure functions that turn the eval pipeline's *existing* labeled row shapes
 * into dream-pass metrics. No LLM calls, no DB access, no I/O — every function
 * is deterministic and unit-testable on plain inputs.
 *
 * The row types here mirror, field for field, the formats already produced by
 * the labelling pipeline; they are re-declared (not imported) only because the
 * src tree cannot import from scripts/. If a format changes there, change it
 * here:
 *
 *  - ReDerivationLabelRow  ← labels.jsonl written by scripts/eval/re-derivation-label.ts,
 *    plus pair timestamps taken verbatim from SampleSide.startedAt
 *    (scripts/eval/lib/re-derivation-rubric.ts).
 *  - FactJudgeLabelItem    ← items[] written by scripts/eval/fact-judge-label.ts.
 *  - HookFireRow / CitationRow ← hook-log.jsonl (HookLogEntry in
 *    src/core/hook/hook-log.ts) and citation-log.jsonl (src/core/recall/citation-log.ts).
 *
 * Scoring conventions inherited from the labelling pipeline:
 *  - A null verdict means "unparseable / failed" and is EXCLUDED from scoring,
 *    never coerced to a negative — coercing would quietly inflate recall
 *    (see re-derivation-label.ts header note 3).
 *  - A rate whose denominator is empty is null, not 0 (fact-judge-label
 *    summary: `rate: mut.length ? ... : null`).
 */

// ── Family 1: re-derivation rate over time windows ──────────────────────────

/** Verdict labels — verbatim from scripts/eval/lib/re-derivation-rubric.ts. */
export type VerdictLabel =
  | "GENUINE"
  | "REVISIT"
  | "RITUAL"
  | "SAME_TOPIC_DIFFERENT_DECISION"
  | "UNRELATED"
  | "DUPLICATE";

/** Verdict shape — verbatim from re-derivation-rubric.ts. */
export interface RubricVerdict {
  readonly label: VerdictLabel;
  readonly confidence: number;
  readonly reason: string;
}

/**
 * One line of labels.jsonl (re-derivation-label.ts output), enriched with the
 * pair's earlier-session `startedAt` copied verbatim from the SampleSide that
 * fed the judge. GENUINE is the only positive label.
 */
export interface ReDerivationLabelRow {
  readonly pairId: string;
  readonly stratum: string;
  /** null = judge failed or reply unparseable → excluded from scoring. */
  readonly verdict: RubricVerdict | null;
  /** ISO date, copied verbatim from SampleSide.startedAt. Unparseable timestamps are excluded. */
  readonly startedAt: string;
}

export interface ReDerivationWindow {
  /** Inclusive UTC window start, ISO. */
  readonly start: string;
  readonly judged: number;
  readonly positives: number;
  /** positives / judged, or null when judged === 0. */
  readonly rate: number | null;
}

export interface ReDerivationRate {
  readonly windows: ReadonlyArray<ReDerivationWindow>;
  readonly totalJudged: number;
  readonly totalPositives: number;
  readonly overallRate: number | null;
  /** Rows excluded because the verdict was missing or the timestamp unparseable. */
  readonly excluded: number;
}

/**
 * GENUINE-positive rate per fixed-size UTC window over the labelled pairs.
 * Windows with zero judged rows are still emitted (rate: null) so a timeline
 * plot has no silent gaps. Output windows are sorted by start.
 */
export function reDerivationRateByWindow(
  rows: ReadonlyArray<ReDerivationLabelRow>,
  windowMs: number,
): ReDerivationRate {
  if (!(windowMs > 0) || !Number.isFinite(windowMs)) {
    throw new RangeError(`windowMs must be a positive finite number, got ${windowMs}`);
  }
  const buckets = new Map<number, { judged: number; positives: number }>();
  let excluded = 0;
  for (const row of rows) {
    const t = Date.parse(row.startedAt);
    if (row.verdict === null || !Number.isFinite(t)) {
      excluded++;
      continue;
    }
    const start = Math.floor(t / windowMs) * windowMs;
    const b = buckets.get(start) ?? { judged: 0, positives: 0 };
    b.judged++;
    if (row.verdict.label === "GENUINE") b.positives++;
    buckets.set(start, b);
  }
  const starts = [...buckets.keys()].sort((a, b) => a - b);
  let totalJudged = 0;
  let totalPositives = 0;
  const windows = starts.map((start): ReDerivationWindow => {
    const b = buckets.get(start)!;
    totalJudged += b.judged;
    totalPositives += b.positives;
    return {
      start: new Date(start).toISOString(),
      judged: b.judged,
      positives: b.positives,
      rate: b.judged > 0 ? b.positives / b.judged : null,
    };
  });
  return {
    windows,
    totalJudged,
    totalPositives,
    overallRate: totalJudged > 0 ? totalPositives / totalJudged : null,
    excluded,
  };
}

// ── Family 2: correction precision / recall ─────────────────────────────────

export type JudgeAction = "KEEP_BOTH" | "SKIP_NEW" | "SUPERSEDE_OLD";
export type JudgeVerdict = "correct" | "incorrect";

/**
 * One item of labels.json (fact-judge-label.ts output). `independent` is the
 * labeler's own resolution as rendered there: "KEEP_BOTH" or
 * "<ACTION> <targetId>", and "unparsed" when the labeler's reply couldn't be
 * read. `verdict` null = unparseable verdict → excluded, per the pipeline rule.
 */
export interface FactJudgeLabelItem {
  readonly newId: string;
  readonly arm: "conflict" | "other";
  readonly action: JudgeAction;
  /** Judge's decision as rendered: "KEEP_BOTH" or "<ACTION> <targetId>". */
  readonly decision: string;
  readonly labeler: {
    readonly independent: string;
    readonly verdict: JudgeVerdict | null;
    readonly verdictRaw?: string | undefined;
  };
}

export interface CorrectionMetrics {
  /** Mutating decisions with a readable verdict, and how many were correct. */
  readonly mutatingJudged: number;
  readonly mutatingCorrect: number;
  /** mutatingCorrect / mutatingJudged — null when nothing mutating was judged. */
  readonly precision: number | null;
  /** Gold mutating rows (labeler independent is mutating, not KEEP_BOTH/unparsed). */
  readonly goldMutating: number;
  readonly truePositives: number;
  /** truePositives / goldMutating — null when there is no gold positive. */
  readonly recall: number | null;
  /** Rows whose independent resolution was "unparsed" (excluded from recall). */
  readonly independentUnparsed: number;
  /** Mutating rows whose verdict was null (excluded from precision). */
  readonly verdictUnparsed: number;
}

const isMutatingAction = (a: JudgeAction): boolean => a !== "KEEP_BOTH";
const isMutatingIndependent = (s: string): boolean => s !== "KEEP_BOTH" && s !== "unparsed";

/**
 * Precision/recall of the judge's corrections (mutating actions) against the
 * blind labeler. Precision: of the mutating decisions with a readable verdict,
 * the share the labeler marked correct (the inverse of the summary's
 * falseSupersession rate). Recall: of the rows the labeler independently
 * resolved as mutating, the share the judge actually mutated. Recall counts
 * predictions against the gold resolution, so it needs no verdict and is not
 * gated on precision's exclusions beyond the "unparsed" independent.
 */
export function correctionMetrics(
  items: ReadonlyArray<FactJudgeLabelItem>,
): CorrectionMetrics {
  let mutatingJudged = 0;
  let mutatingCorrect = 0;
  let verdictUnparsed = 0;
  let independentUnparsed = 0;
  let goldMutating = 0;
  let truePositives = 0;
  for (const it of items) {
    const predicted = isMutatingAction(it.action);
    if (predicted) {
      if (it.labeler.verdict === null) verdictUnparsed++;
      else {
        mutatingJudged++;
        if (it.labeler.verdict === "correct") mutatingCorrect++;
      }
    }
    if (it.labeler.independent === "unparsed") {
      independentUnparsed++;
    } else if (isMutatingIndependent(it.labeler.independent)) {
      goldMutating++;
      if (predicted) truePositives++;
    }
  }
  return {
    mutatingJudged,
    mutatingCorrect,
    precision: mutatingJudged > 0 ? mutatingCorrect / mutatingJudged : null,
    goldMutating,
    truePositives,
    recall: goldMutating > 0 ? truePositives / goldMutating : null,
    independentUnparsed,
    verdictUnparsed,
  };
}

// ── Family 3: merge precision ───────────────────────────────────────────────

/**
 * A labeled merge pair: the SKIP_NEW arm of the fact-judge decision — "this
 * new fact restates an existing one" — judged correct/incorrect by the blind
 * labeler (same item shape as fact-judge-label.ts; the runner filters to
 * action = SKIP_NEW before calling).
 */
export interface MergePairLabel {
  readonly newId: string;
  /** The existing fact the new one was merged into (null = nothing to merge). */
  readonly targetId: string | null;
  readonly verdict: JudgeVerdict | null;
}

export interface MergePrecision {
  readonly merges: number;
  readonly correct: number;
  /** correct / merges — null when no merge pair carries a readable verdict. */
  readonly precision: number | null;
  /** Pairs excluded because the verdict was null. */
  readonly excluded: number;
}

/**
 * Of the merges (new fact treated as a restatement of an existing one) that
 * the labeler actually judged, the share judged correct. Null verdicts are
 * excluded, never counted as incorrect.
 */
export function mergePrecision(pairs: ReadonlyArray<MergePairLabel>): MergePrecision {
  let merges = 0;
  let correct = 0;
  let excluded = 0;
  for (const p of pairs) {
    if (p.verdict === null) {
      excluded++;
      continue;
    }
    merges++;
    if (p.verdict === "correct") correct++;
  }
  return {
    merges,
    correct,
    precision: merges > 0 ? correct / merges : null,
    excluded,
  };
}

// ── Family 4: injection tokens per useful hit ───────────────────────────────

/**
 * One hook-log.jsonl fire (subset of HookLogEntry, src/core/hook/hook-log.ts).
 * `estTokens` is what the fire injected; `conversationId` matches the
 * citation-log's `conversation_id` join key.
 */
export interface HookFireRow {
  readonly conversationId: string;
  readonly estTokens: number;
  readonly hits: ReadonlyArray<{ readonly id: string; readonly score: number }>;
}

/**
 * One citation-log.jsonl row (subset of the stored row:
 * conversation_id / cited_id in src/core/recall/citation-log.ts). kind is
 * optional and ignored for usefulness — a citation of any kind marks the
 * surfaced hit useful.
 */
export interface CitationRow {
  readonly conversationId: string;
  readonly citedId: string;
}

export interface InjectionCost {
  /** Fires counted (non-negative estTokens, hits present). */
  readonly fires: number;
  /** Total estTokens across counted fires. */
  readonly injectedTokens: number;
  /** Surfaced hits that were cited in the same conversation. */
  readonly usefulHits: number;
  /** injectedTokens / usefulHits — null when nothing useful was surfaced. */
  readonly tokensPerUsefulHit: number | null;
}

/**
 * Cost side of the dream-pass ledger: how many injected tokens it took, on
 * average, to land one hit the agent actually cited. Joins hook fires to
 * citations by conversationId; a hit counts once per fire, deduplicated by id
 * within the fire. Fires with no hits or a negative token count are skipped
 * (malformed telemetry, not a signal).
 */
export function injectionCostPerUsefulHit(
  fires: ReadonlyArray<HookFireRow>,
  citations: ReadonlyArray<CitationRow>,
): InjectionCost {
  const citedByConv = new Map<string, Set<string>>();
  for (const c of citations) {
    if (!citedByConv.has(c.conversationId)) citedByConv.set(c.conversationId, new Set());
    citedByConv.get(c.conversationId)!.add(c.citedId);
  }
  let fireCount = 0;
  let injectedTokens = 0;
  let usefulHits = 0;
  for (const f of fires) {
    if (f.hits.length === 0 || !(f.estTokens >= 0)) continue;
    fireCount++;
    injectedTokens += f.estTokens;
    const cited = citedByConv.get(f.conversationId);
    if (!cited) continue;
    const seen = new Set<string>();
    for (const h of f.hits) {
      if (cited.has(h.id) && !seen.has(h.id)) {
        seen.add(h.id);
        usefulHits++;
      }
    }
  }
  return {
    fires: fireCount,
    injectedTokens,
    usefulHits,
    tokensPerUsefulHit: usefulHits > 0 ? injectedTokens / usefulHits : null,
  };
}
