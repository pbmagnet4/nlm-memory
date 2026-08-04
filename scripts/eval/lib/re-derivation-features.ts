/**
 * Pure feature computation for a candidate re-derivation pair (Stage A).
 *
 * `tokenize(texts, false)` is deliberately byte-identical to the incumbent
 * detector's tokenizer in src/core/metrics/re-derivation.ts, so the
 * calibration can score the shipped configuration as one point in the sweep
 * rather than an approximation of it. Every other feature here exists because
 * the 2026-08-04 ground-truth check found the incumbent confounded with
 * decision-set size and floated off zero by function words.
 *
 * No I/O. All corpus reads live in re-derivation-sample.ts.
 */

export interface SessionDecisions {
  readonly id: string;
  readonly startedAt: string;
  readonly decisions: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
}

export interface PairFeatures {
  readonly aId: string;
  readonly bId: string;
  readonly gapDays: number;
  readonly sharedEntityCount: number;
  readonly rawPooledJaccard: number;
  readonly strippedPooledJaccard: number;
  readonly rawMaxPairJaccard: number;
  readonly strippedMaxPairJaccard: number;
  readonly maxPairCosine: number | null;
  readonly minDecisionCount: number;
  readonly minRawTokens: number;
  readonly minStrippedTokens: number;
  readonly subagentSides: number;
  readonly linked: boolean;
}

/** Standard English function words. Not tuned per-corpus: a corpus-fitted list
 *  would not transfer to another install, the same portability argument that
 *  drove median-relative floors in floor-calibration.ts. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the and or but if then to of in on at for with by from as is are was were be been
being it its this that these those we i you they he she them us our your their my not no do does did
so than too very can will just should now here there what which who whom when where why how all any
both each few more most other some such only own same s t don use using used into over under
again further once about against between during before after above below up down out off`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD = /\W+/;
const MS_PER_DAY = 86_400_000;

export function tokenize(
  texts: ReadonlyArray<string>,
  stripStopwords: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const w of texts.join(" ").toLowerCase().split(WORD)) {
    if (!w) continue;
    if (stripStopwords && STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface BestMatch {
  readonly score: number;
  readonly aIndex: number;
  readonly bIndex: number;
}

export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
): number;
export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
  withIndices: true,
): BestMatch;
export function maxPairJaccard(
  aDecisions: ReadonlyArray<string>,
  bDecisions: ReadonlyArray<string>,
  stripStopwords: boolean,
  withIndices?: true,
): number | BestMatch {
  const aTok = aDecisions.map((d) => tokenize([d], stripStopwords));
  const bTok = bDecisions.map((d) => tokenize([d], stripStopwords));
  let best: BestMatch = { score: 0, aIndex: -1, bIndex: -1 };
  for (let i = 0; i < aTok.length; i++) {
    for (let j = 0; j < bTok.length; j++) {
      const s = jaccardSets(aTok[i]!, bTok[j]!);
      if (s > best.score) best = { score: s, aIndex: i, bIndex: j };
    }
  }
  return withIndices ? best : best.score;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function maxPairCosine(
  aVecs: ReadonlyArray<Float32Array>,
  bVecs: ReadonlyArray<Float32Array>,
): number {
  let best = 0;
  for (const v of aVecs) for (const w of bVecs) best = Math.max(best, cosine(v, w));
  return best;
}

export interface PairFeatureOptions {
  readonly aVectors?: ReadonlyArray<Float32Array>;
  readonly bVectors?: ReadonlyArray<Float32Array>;
  readonly linked?: boolean;
}

function isSubagent(id: string): boolean {
  return id.startsWith("cc_sub_");
}

export function pairFeatures(
  x: SessionDecisions,
  y: SessionDecisions,
  opts: PairFeatureOptions,
): PairFeatures {
  const flip = new Date(y.startedAt).getTime() < new Date(x.startedAt).getTime();
  const a = flip ? y : x;
  const b = flip ? x : y;
  const aVecs = (flip ? opts.bVectors : opts.aVectors) ?? [];
  const bVecs = (flip ? opts.aVectors : opts.bVectors) ?? [];

  const aRaw = tokenize(a.decisions, false);
  const bRaw = tokenize(b.decisions, false);
  const aStr = tokenize(a.decisions, true);
  const bStr = tokenize(b.decisions, true);
  const bEnt = new Set(b.entities);

  return {
    aId: a.id,
    bId: b.id,
    gapDays:
      Math.abs(new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()) / MS_PER_DAY,
    sharedEntityCount: a.entities.filter((e) => bEnt.has(e)).length,
    rawPooledJaccard: jaccardSets(aRaw, bRaw),
    strippedPooledJaccard: jaccardSets(aStr, bStr),
    rawMaxPairJaccard: maxPairJaccard(a.decisions, b.decisions, false),
    strippedMaxPairJaccard: maxPairJaccard(a.decisions, b.decisions, true),
    maxPairCosine: aVecs.length && bVecs.length ? maxPairCosine(aVecs, bVecs) : null,
    minDecisionCount: Math.min(a.decisions.length, b.decisions.length),
    minRawTokens: Math.min(aRaw.size, bRaw.size),
    minStrippedTokens: Math.min(aStr.size, bStr.size),
    subagentSides: Number(isSubagent(a.id)) + Number(isSubagent(b.id)),
    linked: opts.linked ?? false,
  };
}
