import { corroborationKey } from "@ports/fact-store.js";
import { requireProperty } from "@core/properties/model.js";
import type { PropertyStore } from "@ports/property-store.js";
import { embedForRecall } from "@core/recall/request-budget.js";
import { executionWorkstreamIds, type RecallExecutionOptions } from "@core/recall/execution-options.js";
/**
 * FactRecallService — agent-facing recall over the FactStore.
 *
 * Mirrors RecallService's keyword / semantic / hybrid pattern but works on
 * Fact records, not Session records. Sessions and facts answer different
 * questions and have incompatibly-shaped results, so this is a separate
 * service with its own MCP tool — see Section 4 of factstore-design.md.
 *
 * Filter pipeline:
 *   1. Storage pre-filter (subject, predicate, kind, minConfidence,
 *      includeSuperseded). Cheap SQL.
 *   2. BM25 keyword scoring over (value, subject, predicate) with field
 *      boosts. Pure, in-memory; IDF/length stats computed over the
 *      recency-capped candidate window. M2 (T1036).
 *   3. Semantic KNN via fact_embeddings vec0 (when mode != keyword).
 *   4. Hybrid merge: semantic hits occupy the upper band, ordered by
 *      reciprocal rank fusion of the semantic and keyword rankings (M2);
 *      keyword-only hits backfill the lower band. Co-occurrence is NOT
 *      rewarded as a score — that was the dilution source.
 *
 * Confidence policy: default `minConfidence` is 0.6 (Section 1 of the plan).
 * Facts with classifier confidence in [0.4, 0.6) get written by
 * extractFacts but stay out of agent recall unless the caller lowers the
 * floor explicitly.
 */

import type { FactEligibility, FactStore } from "@ports/fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import type {
  Fact,
  FactHit,
  FactMatchField,
  FactRecallQuery,
  FactRecallResult,
  RecallMode,
} from "@shared/types.js";
import { laneHealth } from "@core/health/embedding-lane-state.js";
import { tokenSet } from "@core/recall/tokenize.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
export const DEFAULT_FACT_MIN_CONFIDENCE = 0.6;
const STORAGE_FETCH_CAP = 500;
const SEMANTIC_OVERFETCH = 3;
const DEFAULT_BOOST_CAP = 2.0;

function readBoostCap(): number {
  const raw = process.env["NLM_FACT_CORROBORATION_BOOST_CAP"];
  if (raw === undefined) return DEFAULT_BOOST_CAP;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BOOST_CAP;
  return parsed;
}

const FIELD_WEIGHTS = {
  value: 3,
  subject: 1,
  predicate: 1,
} as const;

type FactTextField = "value" | "subject" | "predicate";
const FACT_TEXT_FIELDS: ReadonlyArray<FactTextField> = ["value", "subject", "predicate"];

// BM25 tuning (M2). Standard defaults; IDF and length norms are computed
// over the recency-capped candidate window, not the whole corpus.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// Reciprocal rank fusion constant for upper-band ordering (M2).
const RRF_K = 60;

export type CorroborationPolicy = (count: number) => number;

export interface CorroborationRanking {
  readonly factor: CorroborationPolicy;
  readonly tieBreak: boolean;
}

export function corroborationRanking(cap: number, tieBreak = cap > 1): CorroborationRanking {
  return { factor: (count) => Math.min(cap, 1 + Math.log10(Math.max(1, count))), tieBreak };
}

export interface FactRecallServiceDeps {
  readonly properties?: Pick<PropertyStore, "list">;
  readonly corroborationRanking?: CorroborationRanking;
  readonly factStore: FactStore;
  readonly llm: LLMClient;
  readonly resolveWorkstreamMembers?: (tenantId: string, idOrLabel: string) => Promise<readonly string[]>;
}

export class FactRecallService {
  constructor(private readonly deps: FactRecallServiceDeps) {}

  get embeddingClient(): LLMClient { return this.deps.llm; }

  async search(tenantId: string, input: FactRecallQuery, options: RecallExecutionOptions = {}): Promise<FactRecallResult> {
    options.signal?.throwIfAborted();
    await requireProperty(tenantId, input.property, this.deps.properties);
    const mode: RecallMode = input.mode ?? "hybrid";
    const corroboration = new Map<string, number>();
    const limit = clampLimit(input.limit);
    const subject = input.subject ?? null;
    const predicate = input.predicate ?? null;
    const kind = input.kind ?? null;
    const queryText = (input.query ?? "").trim();

    const empty: FactRecallResult = {
      query: queryText,
      subject,
      predicate,
      kind,
      mode,
      limit,
      total: 0,
      results: [],
    };

    // A query with no signal at all → empty. Either free-text query, or a
    // structured filter (subject / predicate / kind) must be provided.
    if (!queryText && subject === null && predicate === null && kind === null && input.property === undefined) {
      return empty;
    }

    const workstreamIds = await executionWorkstreamIds(tenantId, input.workstream, options, this.deps.resolveWorkstreamMembers);
    options.signal?.throwIfAborted();
    if (workstreamIds?.length === 0) return empty;
    const filter: Parameters<FactStore["listForRecall"]>[1] = {
      includeSuperseded: input.includeSuperseded === true,
      minConfidence: input.minConfidence ?? DEFAULT_FACT_MIN_CONFIDENCE,
      limit: STORAGE_FETCH_CAP,
      ...(input.property !== undefined ? { property: input.property } : {}),
      ...(workstreamIds !== undefined ? { workstreamIds } : {}),
      ...(queryText && mode !== "semantic" ? { query: queryText } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
    };

    const candidates = await this.deps.factStore.listForRecall(tenantId, filter);

    const byId = new Map<string, Fact>(candidates.map((f) => [f.id, f]));
    const queryTokens = queryText ? new Set(tokenSet(queryText)) : new Set<string>();

    // Both search legs reach the full corpus; resolve semantic neighbours
    // outside the bounded lexical candidate set through the same filters.
    const accept = makeFilterPredicate(filter);
    const { query: _query, limit: _limit, ...eligibility } = filter;

    const kwHits =
      mode === "keyword" || mode === "hybrid"
        ? scoreAll(candidates, queryTokens)
        : [];

    if (options.onPartialFacts && mode === "hybrid" && queryText) {
      const boosted = await this.applyCorroboration(tenantId, mergeHybrid(kwHits, []), corroboration);
      await options.onPartialFacts(finalize(queryText, subject, predicate, kind, mode, limit, boosted));
    }

    let semHits: ReadonlyArray<SemanticHit> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && queryText) {
      if (laneHealth("prose") === "stale") {
        semError = "ollama_unreachable";
      } else {
        try {
          semHits = await this.runSemantic(tenantId, queryText, byId, accept, limit * SEMANTIC_OVERFETCH, eligibility, options);
        } catch (err) {
          if (err instanceof LLMUnreachableError) {
            semError = "ollama_unreachable";
          } else {
            throw err;
          }
        }
      }
    }

    if (mode === "semantic" && semError) {
      return { ...empty, modeUnavailable: semError };
    }

    // For pure structured queries (no query text, just subject/predicate),
    // a keyword pass with empty tokens scores zero and a semantic pass has
    // nothing to embed. Fall back to returning the storage filter result
    // ordered by created_at DESC. Applies to keyword AND hybrid — hybrid
    // is the MCP default, so this path catches exact subject+predicate
    // lookups from agent callers that pass no query text.
    if ((mode === "keyword" || mode === "hybrid") && !queryText) {
      const rows = candidates
        .slice(0, limit)
        .map((f) => factToHit(f, 0, []));
      const boosted = await this.applyCorroboration(tenantId, rows, corroboration);
      return finalize(queryText, subject, predicate, kind, mode, limit, boosted);
    }

    if (mode === "keyword") {
      const boosted = await this.applyCorroboration(tenantId, kwHits.map(toKeywordHit), corroboration);
      return finalize(queryText, subject, predicate, kind, mode, limit, boosted);
    }

    if (mode === "semantic") {
      const boosted = await this.applyCorroboration(tenantId, semHits.map(toSemanticHit), corroboration);
      return finalize(queryText, subject, predicate, kind, mode, limit, boosted);
    }

    // hybrid
    const merged = mergeHybrid(kwHits, semHits);
    const boosted = await this.applyCorroboration(tenantId, merged, corroboration);
    const result = finalize(queryText, subject, predicate, kind, mode, limit, boosted);
    return semError ? { ...result, modeUnavailable: semError } : result;
  }

  /**
   * Fetch corroboration counts for the candidate hits and apply a log-scale
   * boost to matchScore. Sessions that asserted the same (subject, predicate,
   * value) get a multiplicative bonus capped at NLM_FACT_CORROBORATION_BOOST_CAP
   * (default 2.0). Set the env var to 1.0 to disable the boost while still
   * returning the count on each hit.
   *
   * Failure mode: any DB error reverts to returning the raw hits unchanged.
   * The boost is a quality improvement, not a correctness contract.
   */
  private async applyCorroboration(tenantId: string, hits: ReadonlyArray<FactHit>, counts: Map<string, number>): Promise<ReadonlyArray<FactHit>> {
    if (hits.length === 0) return hits;
    try {
      const identity = (hit: Pick<Fact, "subject" | "predicate" | "value" | "property">) =>
        JSON.stringify([tenantId, hit.property?.slug ?? null, hit.subject, hit.predicate, hit.value]);
      const missing = new Map(hits.filter((hit) => !counts.has(identity(hit))).map((hit) =>
        [identity(hit), { subject: hit.subject, predicate: hit.predicate, value: hit.value, ...(hit.property?.slug ? { property: hit.property.slug } : {}) }]));
      if (missing.size > 0) {
        const fetched = await this.deps.factStore.corroborationCounts(tenantId, [...missing.values()]);
        for (const [key, triple] of missing) counts.set(key, fetched.get(corroborationKey(triple.subject, triple.predicate, triple.value, triple.property)) ?? 1);
      }
      const ranking = this.deps.corroborationRanking ?? corroborationRanking(readBoostCap());
      const boosted: FactHit[] = hits.map((h) => {
        const count = counts.get(identity(h))!;
        const factor = ranking.factor(count);
        return {
          ...h,
          matchScore: round4(h.matchScore * factor),
          corroborationCount: count,
        };
      });
      boosted.sort((a, b) => b.matchScore - a.matchScore || (ranking.tieBreak
        ? (b.corroborationCount ?? 0) - (a.corroborationCount ?? 0) : 0));
      return boosted;
    } catch {
      // Best-effort: corroboration boost skipped on any FactStore failure - recall proceeds unboosted. If boosts seem globally absent, look here first.
      return hits;
    }
  }

  private async runSemantic(
    tenantId: string,
    query: string,
    byId: ReadonlyMap<string, Fact>,
    accept: (fact: Fact) => boolean,
    fetchLimit: number,
    eligibility: FactEligibility,
    options: RecallExecutionOptions,
  ): Promise<ReadonlyArray<SemanticHit>> {
    const embedding = await embedForRecall(this.deps.llm, query, options, 2_000);
    options.signal?.throwIfAborted();
    const neighbors = await this.deps.factStore.semanticSearch(tenantId, embedding.vector, fetchLimit, eligibility, options);

    // Resolve neighbours that fall outside the recency-capped keyword window
    // in one batch, then apply the same filters the SQL pre-filter would have.
    const missingIds = neighbors.filter((n) => !byId.has(n.factId)).map((n) => n.factId);
    const fetched = missingIds.length > 0 ? await this.deps.factStore.getByIds(tenantId, missingIds) : [];
    const fetchedById = new Map<string, Fact>(fetched.map((f) => [f.id, f]));

    const hits: SemanticHit[] = [];
    for (const n of neighbors) {
      const fact = byId.get(n.factId) ?? fetchedById.get(n.factId);
      if (!fact || !accept(fact)) continue;
      hits.push({ fact, similarity: cosineFromL2(n.distance) });
    }
    return hits;
  }
}

/**
 * Replicates the SQL pre-filter (listForRecall) so semantic neighbours fetched
 * outside the keyword candidate window are held to the same standard:
 * non-superseded (unless requested), at/above the confidence floor, and
 * matching any structured subject/predicate/kind constraint.
 */
function makeFilterPredicate(
  filter: Parameters<FactStore["listForRecall"]>[1],
): (fact: Fact) => boolean {
  return (f: Fact): boolean => {
    // Defense-in-depth: a retired fact carries retiredAt and its supersededBy
    // may be null, so the supersededBy gate below does not catch it. The SQL
    // pre-filter already excludes retired_at IS NOT NULL; this guards semantic
    // neighbours resolved outside that window from leaking a retired fact.
    if (filter.property !== undefined && f.property?.slug !== filter.property) return false;
    if (f.retiredAt != null) return false;
    if (filter.includeSuperseded !== true && f.supersededBy !== null) return false;
    if (filter.minConfidence !== undefined && f.confidence < filter.minConfidence) return false;
    if (filter.kind !== undefined && f.kind !== filter.kind) return false;
    if (filter.subject !== undefined && f.subject !== filter.subject) return false;
    if (filter.predicate !== undefined && f.predicate !== filter.predicate) return false;
    return true;
  };
}

export { makeFilterPredicate as makeFilterPredicateForTest };

interface KeywordHit {
  readonly fact: Fact;
  readonly score: number;
  readonly matchedIn: ReadonlyArray<FactMatchField>;
}

interface SemanticHit {
  readonly fact: Fact;
  readonly similarity: number;
}

interface FieldCorpusStats {
  readonly docFreq: ReadonlyMap<string, number>;
  readonly avgLen: number;
}

function fieldTokens(fact: Fact, field: FactTextField): ReadonlyArray<string> {
  return [...tokenSet(fact[field])];
}

/**
 * BM25 support stats over the candidate window: per-field document
 * frequencies (query tokens only) and mean field length. Computed once per
 * search; the window is capped at STORAGE_FETCH_CAP rows.
 */
function collectFieldStats(
  facts: ReadonlyArray<Fact>,
  queryTokens: ReadonlySet<string>,
): Record<FactTextField, FieldCorpusStats> {
  const stats = {} as Record<FactTextField, FieldCorpusStats>;
  for (const field of FACT_TEXT_FIELDS) {
    const docFreq = new Map<string, number>();
    let totalLen = 0;
    for (const f of facts) {
      const toks = fieldTokens(f, field);
      totalLen += toks.length;
      const seen = new Set<string>();
      for (const t of toks) {
        if (queryTokens.has(t)) seen.add(t);
      }
      for (const t of seen) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    stats[field] = { docFreq, avgLen: facts.length > 0 ? totalLen / facts.length : 0 };
  }
  return stats;
}

function bm25TermScore(tf: number, df: number, nDocs: number, fieldLen: number, avgLen: number): number {
  const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
  const norm = 1 - BM25_B + BM25_B * (avgLen > 0 ? fieldLen / avgLen : 1);
  return (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
}

function scoreAll(
  facts: ReadonlyArray<Fact>,
  queryTokens: ReadonlySet<string>,
): ReadonlyArray<KeywordHit> {
  if (queryTokens.size === 0) return [];
  const stats = collectFieldStats(facts, queryTokens);
  const hits: KeywordHit[] = [];
  for (const f of facts) {
    const { score, matchedIn } = scoreFact(f, queryTokens, stats, facts.length);
    if (score > 0) hits.push({ fact: f, score, matchedIn });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function scoreFact(
  fact: Fact,
  queryTokens: ReadonlySet<string>,
  stats: Record<FactTextField, FieldCorpusStats>,
  nDocs: number,
): { score: number; matchedIn: ReadonlyArray<FactMatchField> } {
  let score = 0;
  const matchedIn: FactMatchField[] = [];

  for (const field of FACT_TEXT_FIELDS) {
    const toks = fieldTokens(fact, field);
    if (toks.length === 0) continue;
    const tfByToken = new Map<string, number>();
    for (const t of toks) {
      if (queryTokens.has(t)) tfByToken.set(t, (tfByToken.get(t) ?? 0) + 1);
    }
    if (tfByToken.size === 0) continue;
    const { docFreq, avgLen } = stats[field];
    let fieldScore = 0;
    for (const [token, tf] of tfByToken) {
      fieldScore += bm25TermScore(tf, docFreq.get(token) ?? 0, nDocs, toks.length, avgLen);
    }
    score += FIELD_WEIGHTS[field] * fieldScore;
    matchedIn.push(field);
  }

  return { score, matchedIn };
}

/**
 * Semantic-primary hybrid merge.
 *
 * For short fact triples, semantic similarity is the dominant quality signal
 * and the keyword leg can be noisy
 * (few tokens to match on). An equal-weight blend let high keyword scores on
 * recent-but-wrong facts dilute strong semantic hits — measured ~14pts of R@5
 * lost vs pure semantic on the paraphrase gold set (2026-06-16 report).
 *
 * So semantic hits occupy the upper score band [0.5, 1.0], ordered by
 * reciprocal rank fusion of the semantic ranking and the BM25 keyword
 * ranking (M2) — consensus across both legs outranks a single-leg standout,
 * but a semantic-only hit is never pushed below the band. Keyword-only
 * hits — facts semantic never surfaced — backfill the lower band [0, 0.5).
 * Raw-score co-occurrence is NOT rewarded (that was the dilution source);
 * only ranks fuse. When semantic is unavailable (Ollama down) semHits is
 * empty and this degrades to pure keyword, preserving the
 * graceful-degradation contract.
 */
function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
): ReadonlyArray<FactHit> {
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const kwMap = new Map<string, KeywordHit>(kwHits.map((h) => [h.fact.id, h]));
  const kwRank = new Map<string, number>(kwHits.map((h, i) => [h.fact.id, i + 1]));
  const missingKwRank = kwHits.length + 1;

  const ranked = semHits.map((sem, i) => {
    const semRank = i + 1;
    const kRank = kwRank.get(sem.fact.id) ?? missingKwRank;
    return { sem, rrf: 1 / (RRF_K + semRank) + 1 / (RRF_K + kRank) };
  });
  ranked.sort(
    (a, b) =>
      b.rrf - a.rrf ||
      b.sem.similarity - a.sem.similarity ||
      (a.sem.fact.id < b.sem.fact.id ? -1 : 1),
  );
  const maxRrf = Math.max(...ranked.map((r) => r.rrf), Number.EPSILON);

  const rows: FactHit[] = [];
  const seen = new Set<string>();

  for (const { sem, rrf } of ranked) {
    const semNorm = sem.similarity / maxSem;
    const kw = kwMap.get(sem.fact.id);
    rows.push({
      ...sem.fact,
      matchScore: round4(0.5 + 0.5 * (rrf / maxRrf)),
      matchedIn: uniqueFields(kw?.matchedIn ?? [], ["semantic"]),
      keywordScore: round4(kw ? kw.score / maxKw : 0),
      semanticScore: round4(semNorm),
    });
    seen.add(sem.fact.id);
  }

  for (const kw of kwHits) {
    if (seen.has(kw.fact.id)) continue;
    rows.push({
      ...kw.fact,
      matchScore: round4(0.5 * (kw.score / maxKw)),
      matchedIn: kw.matchedIn,
      keywordScore: round4(kw.score / maxKw),
      semanticScore: 0,
    });
  }

  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}

function factToHit(
  fact: Fact,
  score: number,
  matchedIn: ReadonlyArray<FactMatchField>,
): FactHit {
  return { ...fact, matchScore: score, matchedIn };
}

function toKeywordHit(h: KeywordHit): FactHit {
  return factToHit(h.fact, h.score, h.matchedIn);
}

function toSemanticHit(h: SemanticHit): FactHit {
  return factToHit(h.fact, h.similarity, ["semantic"]);
}

function finalize(
  query: string,
  subject: string | null,
  predicate: string | null,
  kind: FactRecallResult["kind"],
  mode: RecallMode,
  limit: number,
  hits: ReadonlyArray<FactHit>,
): FactRecallResult {
  return {
    query,
    subject,
    predicate,
    kind,
    mode,
    limit,
    total: hits.length,
    results: hits.slice(0, limit),
  };
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(MAX_LIMIT, Math.trunc(n));
}

function cosineFromL2(distance: number): number {
  const cos = 1 - (distance * distance) / 2;
  return round4(Math.max(-1, Math.min(1, cos)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function uniqueFields(
  a: ReadonlyArray<FactMatchField>,
  b: ReadonlyArray<FactMatchField>,
): ReadonlyArray<FactMatchField> {
  const seen = new Set<FactMatchField>();
  const out: FactMatchField[] = [];
  for (const f of [...a, ...b]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
