import { existsSync } from "node:fs";
import type { Card } from "./property-holdout-cards.js";
import { fileHash, pathsIn, readJson, writePrivate, type Manifest } from "./property-holdout-io.js";
import { readSeal, type CardLabel, type FactLabel, type LabelsFile, type SessionLabel } from "./property-holdout-labels.js";
import type { Predictions, PredictionEntry } from "./property-holdout.js";
import { cohenKappa, postStratified, wilson } from "./property-holdout-stats.js";

const Q2_MIN_REFS = 100;
const Q2_POINT = 0.95;
const Q2_LOWER = 0.9;
const STRATUM_FLOOR = 0.8;
const KAPPA_FLAG = 0.6;

export const Q1_OUT_OF_SCOPE = "out of scope (fact lane off)";
export const SCOPE_STATEMENT = "These are acceptance results for one frozen candidate on one frozen, source-disjoint holdout. They are not a population precision claim.";

export class ScoringRefused extends Error {}
const refuse = (why: string): never => { throw new ScoringRefused(why); };

const isFact = (l: CardLabel): l is FactLabel => "owner" in l;
const isSession = (l: CardLabel): l is SessionLabel => "relevant" in l;
const finalConfidence = (l: SessionLabel) => l.adjudicated?.confidence ?? l.confidence;

export interface Scores {
  scope: string; scoredAt: string;
  q1: typeof Q1_OUT_OF_SCOPE;
  q2: { references: number; pooledPrecision: number | null; postStratified: number | null; wilson: { low: number; high: number } | null; underPowered: boolean;
    unsampledStrata: string[]; perStratum: Record<string, { references: number; relevant: number; precision: number | null; belowFloor: boolean }>; passed: boolean };
  coverage: { sessionRefsPerSessionWithEntities: number | null; abstentionCorrectRate: number | null; abstentionCards: number };
  kappa: { fact: number | null; session: number | null; flagged: boolean; l2Present: boolean; disagreementsOnProposals: string[] };
  annotationLimits: { cards: number; cardsPerStratum: Record<string, number>; sessionCardsDropped: number; unsureFact: number; unsureSession: number;
    adjudicationChanged: number; l1Minutes: number; l1IsOperator: string };
  contamination: string[];
  decision: { gatesPassed: boolean; stillRequired: string[] };
}

export function scoreHoldout(dir: string, now: Date, write = true): Scores {
  const p = pathsIn(dir);
  const manifest = readJson<Manifest>(p.manifest);
  if (!manifest.draw) refuse("manifest has no draw record");
  const draw = manifest.draw!;
  if (!existsSync(p.cards) || fileHash(p.cards) !== draw.cardsHash) refuse("cards.json does not match the manifest hash");
  // The seal is checked before predictions.json is opened or hashed.
  if (!existsSync(p.sealed)) refuse("labels.sealed is missing: predictions stay unread until labels are sealed");
  if (!existsSync(p.labels)) refuse("labels.json is missing");
  const seal = readSeal(dir);
  if (fileHash(p.labels) !== seal.labelsHash) refuse("labels.json does not match labels.sealed (edited after the seal)");
  if (Date.parse(seal.sealedAt) < Date.parse(draw.drawnAt)) refuse("labels were sealed before the draw");
  const cards = readJson<{ cards: Card[] }>(p.cards).cards;
  const labels = readJson<LabelsFile>(p.labels).labels;
  const unlabelled = cards.filter((c) => !(c.id in labels)); const extra = Object.keys(labels).filter((id) => !cards.some((c) => c.id === id));
  if (unlabelled.length > 0 || extra.length > 0) refuse(`labels do not cover the cards exactly (${unlabelled.length} missing, ${extra.length} unknown)`);
  if (!existsSync(p.predictions) || fileHash(p.predictions) !== draw.predictionsHash) refuse("predictions.json does not match the manifest hash");
  const predictions = readJson<Predictions>(p.predictions);
  const l2 = existsSync(p.l2) ? readJson<LabelsFile>(p.l2).labels : null;

  const entries = Object.entries(predictions.cards) as [string, PredictionEntry][];
  const abstentions = entries.filter(([, e]) => e.lane === "abstention");
  const sessionCards = entries.filter(([, e]) => e.lane === "session");

  // Q2: references on session cards that survived adjudication.
  const kept = sessionCards.filter(([id]) => { const l = labels[id]!; return isSession(l) && finalConfidence(l) === "sure"; });
  const q2Strata: Scores["q2"]["perStratum"] = {}; const counts = [];
  let relevantTotal = 0; let refsTotal = 0;
  for (const stratum of Object.keys(predictions.population.sessionRefs)) {
    let refs = 0; let relevant = 0;
    for (const [id, e] of kept.filter(([, e]) => e.stratum === stratum)) {
      const l = labels[id] as SessionLabel;
      for (const slug of e.proposed) { refs++; if (l.relevant.includes(slug)) relevant++; }
    }
    relevantTotal += relevant; refsTotal += refs;
    const precision = refs === 0 ? null : relevant / refs;
    q2Strata[stratum] = { references: refs, relevant, precision, belowFloor: precision !== null && precision < STRATUM_FLOOR };
    counts.push({ stratum, population: predictions.population.sessionRefs[stratum]!, n: refs, correct: relevant });
  }
  const ps = postStratified(counts);
  const interval = ps.estimate === null ? null : wilson(Math.round(ps.estimate * refsTotal), refsTotal);
  const q2Passed = ps.estimate !== null && interval !== null && refsTotal >= Q2_MIN_REFS && ps.estimate >= Q2_POINT && interval.low >= Q2_LOWER
    && Object.values(q2Strata).every((s) => !s.belowFloor);
  const q2 = { references: refsTotal, pooledPrecision: refsTotal === 0 ? null : relevantTotal / refsTotal, postStratified: ps.estimate, wilson: interval, underPowered: refsTotal < Q2_MIN_REFS,
    unsampledStrata: ps.unsampled, perStratum: q2Strata, passed: q2Passed };

  // Coverage has no gate. An unsure abstention card is a correct abstention (§3).
  const abstentionCorrect = abstentions.filter(([id]) => { const l = labels[id]; return l !== undefined && isFact(l) && (l.confidence === "unsure" || l.owner === "none" || l.owner === "ambiguous"); }).length;
  const coverage = {
    sessionRefsPerSessionWithEntities: draw.population.sessionsWithEntities === 0 ? null : Object.values(draw.population.sessionRefs).reduce((a, b) => a + b, 0) / draw.population.sessionsWithEntities,
    abstentionCorrectRate: abstentions.length === 0 ? null : abstentionCorrect / abstentions.length, abstentionCards: abstentions.length,
  };

  // Kappa and disagreements; L2 never decides a gate.
  const factIds = cards.filter((c) => c.type === "fact" && l2 && c.id in l2).map((c) => c.id);
  const factKappa = l2 ? cohenKappa(factIds.map((id) => (labels[id] as FactLabel).owner), factIds.map((id) => (l2[id] as FactLabel).owner)) : null;
  const sessionUnits: [string, string][] = l2 ? cards.filter((c) => c.type === "session" && c.id in l2).flatMap((c) => {
    const a = labels[c.id] as SessionLabel; const b = l2[c.id] as SessionLabel;
    return [...new Set([...a.relevant, ...b.relevant, ...(predictions.cards[c.id]?.proposed ?? [])])].map((slug): [string, string] => [a.relevant.includes(slug) ? "y" : "n", b.relevant.includes(slug) ? "y" : "n"]);
  }) : [];
  const sessionKappa = l2 ? cohenKappa(sessionUnits.map((u) => u[0]), sessionUnits.map((u) => u[1])) : null;
  const disagreements = l2 ? sessionCards.map(([id]) => id).filter((id) => id in l2 && disagree(labels[id]!, l2[id]!)) : [];
  const kappa = { fact: factKappa, session: sessionKappa, flagged: [factKappa, sessionKappa].some((k) => k !== null && k < KAPPA_FLAG), l2Present: l2 !== null, disagreementsOnProposals: disagreements };

  const perStratum: Record<string, number> = {};
  for (const [, e] of entries) perStratum[e.stratum] = (perStratum[e.stratum] ?? 0) + 1;
  const labelFile = readJson<LabelsFile>(p.labels);
  const annotationLimits = {
    cards: cards.length, cardsPerStratum: perStratum, sessionCardsDropped: sessionCards.length - kept.length,
    unsureFact: Object.values(labels).filter((l) => isFact(l) && l.confidence === "unsure").length,
    unsureSession: Object.values(labels).filter((l) => isSession(l) && l.confidence === "unsure").length,
    adjudicationChanged: Object.values(labels).filter((l) => isSession(l) && l.adjudicated?.changed).length,
    l1Minutes: Math.round(labelFile.sittings.reduce((n, s) => n + (Date.parse(s.endedAt) - Date.parse(s.startedAt)), 0) / 60_000),
    l1IsOperator: "L1 is the operator of the system under evaluation, not a disinterested annotator.",
  };
  const contamination = [...draw.flags];
  const gatesPassed = q2.passed && contamination.length === 0 && (kappa.fact !== null || kappa.session !== null);
  const scores: Scores = {
    scope: SCOPE_STATEMENT, scoredAt: now.toISOString(), q1: Q1_OUT_OF_SCOPE, q2, coverage, kappa, annotationLimits, contamination,
    decision: { gatesPassed, stillRequired: ["section 6 regression and contract tests on the frozen SHA (SQLite and PostgreSQL)", "independent review findings fixed or rejected in writing", "Edward's decision on NLM_SESSION_PROPERTY_INFERENCE"] },
  };
  if (write) {
    writePrivate(p.scores, scores); writePrivate(p.abstention, { abstentionCards: abstentions.length, correct: abstentionCorrect, rate: coverage.abstentionCorrectRate }); writePrivate(p.limits, annotationLimits);
  }
  return scores;
}

function disagree(a: CardLabel, b: CardLabel): boolean {
  if (isFact(a) && isFact(b)) return a.owner !== b.owner;
  if (isSession(a) && isSession(b)) return [...a.relevant].sort().join() !== [...b.relevant].sort().join();
  return true;
}
