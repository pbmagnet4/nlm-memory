/**
 * Population-weighted precision/recall scoring for Stage A calibration.
 *
 * Strata are sampled at rates differing by four orders of magnitude (A1: 53
 * of a 53-pair population, weight 1.0; A5: 30 of 176,133, weight ~5,871).
 * Precision or recall computed on raw sample counts would be dominated by
 * whichever stratum happened to be drawn most heavily and would read far off
 * the true rate. Every count is multiplied by `population / drawn` before
 * any ratio is taken. A stratum with `drawn === 0` has no sampled evidence:
 * `population / 0` is Infinity and would silently swallow every other
 * stratum's contribution, so it is skipped and reported as uncovered
 * instead of weighted.
 *
 * No I/O. Consumes `PairFeatures` from re-derivation-features.ts.
 */

import type { PairFeatures } from "./re-derivation-features.js";

export type Tokenizer = "raw" | "stripped";
export type Unit = "pooled" | "maxPair";

/** Shorthand that names a tokenizer+unit combination in one string, so a
 *  sweep can address any lexical cell of the grid with a single field. */
export type LexicalSignal = "rawPooled" | "strippedPooled" | "rawMaxPair" | "strippedMaxPair";

export type Signal = LexicalSignal | "lexical" | "cosine" | "max";

export interface PredicateConfig {
  /** Which score to threshold against `floor`. A lexical shorthand fixes
   *  tokenizer+unit and implies `signal: "lexical"`. "cosine" and "max"
   *  fall back to `tokenizer`/`unit` (default stripped+pooled) for their
   *  lexical component. Default: "lexical". */
  readonly signal?: Signal;
  readonly tokenizer?: Tokenizer;
  readonly unit?: Unit;
  readonly floor: number;
  /** Minimum token count (in the resolved tokenizer) either side must clear
   *  to be eligible to fire. Short decision text is weak evidence. */
  readonly minTokens?: number;
  /** Minimum gapDays required to fire. */
  readonly gapDays?: number;
  /** Require at least one shared entity to fire. */
  readonly requireEntity?: boolean;
  /** Suppress firing when either side is a subagent session. */
  readonly excludeSubagents?: boolean;
}

export interface FrameStratum {
  readonly population: number;
  readonly drawn: number;
}

export type FrameStrata = Readonly<Record<string, FrameStratum>>;

export interface LabeledPair {
  readonly stratum: string;
  readonly genuine: boolean;
  readonly features: PairFeatures;
}

export interface ScoreResult {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly weightedTP: number;
  readonly weightedFP: number;
  readonly weightedFN: number;
  readonly precisionCI: readonly [number, number];
  readonly recallCI: readonly [number, number];
  readonly uncoveredStrata: ReadonlyArray<string>;
}

function resolveTokenizerUnit(config: PredicateConfig): { tokenizer: Tokenizer; unit: Unit } {
  switch (config.signal) {
    case "rawPooled":
      return { tokenizer: "raw", unit: "pooled" };
    case "strippedPooled":
      return { tokenizer: "stripped", unit: "pooled" };
    case "rawMaxPair":
      return { tokenizer: "raw", unit: "maxPair" };
    case "strippedMaxPair":
      return { tokenizer: "stripped", unit: "maxPair" };
    default:
      return { tokenizer: config.tokenizer ?? "stripped", unit: config.unit ?? "pooled" };
  }
}

function signalKind(signal: Signal | undefined): "lexical" | "cosine" | "max" {
  if (signal === "cosine") return "cosine";
  if (signal === "max") return "max";
  return "lexical";
}

function lexicalScore(f: PairFeatures, tokenizer: Tokenizer, unit: Unit): number {
  if (tokenizer === "raw") {
    return unit === "pooled" ? f.rawPooledJaccard : f.rawMaxPairJaccard;
  }
  return unit === "pooled" ? f.strippedPooledJaccard : f.strippedMaxPairJaccard;
}

function signalScore(f: PairFeatures, config: PredicateConfig): number {
  const { tokenizer, unit } = resolveTokenizerUnit(config);
  const lexical = lexicalScore(f, tokenizer, unit);
  const kind = signalKind(config.signal);
  if (kind === "lexical") return lexical;
  const cosine = f.maxPairCosine ?? 0;
  if (kind === "cosine") return cosine;
  return Math.max(lexical, cosine);
}

export function predicate(config: PredicateConfig): (f: PairFeatures) => boolean {
  const { tokenizer } = resolveTokenizerUnit(config);
  return (f: PairFeatures): boolean => {
    if (config.excludeSubagents && f.subagentSides > 0) return false;
    if (config.requireEntity && f.sharedEntityCount === 0) return false;
    if (config.gapDays !== undefined && f.gapDays < config.gapDays) return false;
    if (config.minTokens !== undefined) {
      const tokens = tokenizer === "raw" ? f.minRawTokens : f.minStrippedTokens;
      if (tokens < config.minTokens) return false;
    }
    return signalScore(f, config) >= config.floor;
  };
}

const Z95 = 1.959963984540054;

/** Wilson score interval at 95% confidence. `n === 0` returns [0, 1] rather
 *  than NaN: no evidence means no basis to narrow the interval at all. */
export function wilson(successes: number, n: number): readonly [number, number] {
  if (n <= 0) return [0, 1];
  const phat = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = Z95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

/**
 * Wilson interval for a weighted (stratified) proportion via Kish's
 * effective-sample-size correction: n_eff = (sum w)^2 / sum(w^2). For a
 * single stratum every weight is equal and this reduces to the raw sample
 * size; combining strata of wildly different weight shrinks n_eff toward
 * whichever stratum's raw draw is actually small, which is the honest
 * reflection of how little evidence backs a rare, heavily-upweighted
 * stratum like A5. This is what "unweighted successes and n within each
 * stratum, then propagate" resolves to once weights are unequal.
 */
function wilsonEffective(successesWeighted: number, sumW: number, sumW2: number): readonly [number, number] {
  if (sumW <= 0) return [0, 1];
  const phat = successesWeighted / sumW;
  const nEff = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  return wilson(phat * nEff, nEff);
}

export function scoreConfig(
  labeled: ReadonlyArray<LabeledPair>,
  frame: FrameStrata,
  config: PredicateConfig,
): ScoreResult {
  const pred = predicate(config);
  const uncovered = new Set<string>();

  let weightedTP = 0;
  let weightedFP = 0;
  let weightedFN = 0;

  // Effective-sample-size accumulators for the two Wilson intervals:
  // precision is a proportion over "fired" rows, recall over "genuine" rows.
  let firedW = 0;
  let firedW2 = 0;
  let genuineW = 0;
  let genuineW2 = 0;

  for (const row of labeled) {
    const stratum = frame[row.stratum];
    if (!stratum || stratum.drawn === 0) {
      uncovered.add(row.stratum);
      continue;
    }
    const w = stratum.population / stratum.drawn;
    const fires = pred(row.features);

    if (fires) {
      firedW += w;
      firedW2 += w * w;
      if (row.genuine) weightedTP += w;
      else weightedFP += w;
    } else if (row.genuine) {
      weightedFN += w;
    }

    if (row.genuine) {
      genuineW += w;
      genuineW2 += w * w;
    }
  }

  const precision = weightedTP + weightedFP > 0 ? weightedTP / (weightedTP + weightedFP) : 0;
  const recall = weightedTP + weightedFN > 0 ? weightedTP / (weightedTP + weightedFN) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    precision,
    recall,
    f1,
    weightedTP,
    weightedFP,
    weightedFN,
    precisionCI: wilsonEffective(weightedTP, firedW, firedW2),
    recallCI: wilsonEffective(weightedTP, genuineW, genuineW2),
    uncoveredStrata: [...uncovered],
  };
}

/** Keeps only results not dominated on both precision and recall by another
 *  result in the set. */
export function paretoFront<T extends { readonly precision: number; readonly recall: number }>(
  results: ReadonlyArray<T>,
): T[] {
  return results.filter((candidate) => {
    return !results.some((other) => {
      if (other === candidate) return false;
      const atLeastAsGood = other.precision >= candidate.precision && other.recall >= candidate.recall;
      const strictlyBetter = other.precision > candidate.precision || other.recall > candidate.recall;
      return atLeastAsGood && strictlyBetter;
    });
  });
}
