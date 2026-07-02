/**
 * RecallService — the use case. Composes filters, keyword scoring, and
 * semantic search into a single recall operation.
 *
 * Depends only on ports (SessionStore, LLMClient). No framework imports,
 * no SQLite, no HTTP. Tests substitute fake adapters.
 */

import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { FactStore } from "@ports/fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import type {
  KeywordNeighbor,
  SearchOptions,
  SemanticNeighbor,
  SessionStore,
} from "@ports/session-store.js";
import type {
  MatchField,
  RecallHit,
  RecallMode,
  RecallQuery,
  RecallResult,
  Session,
} from "@shared/types.js";
import { applyFilter } from "./filter.js";
import { keywordMatchFields } from "./match-fields.js";
import { detectQueryShape } from "./query-shape.js";
import { recencyMultiplier } from "./recency.js";
import { pickRelatedFacts } from "./related-facts.js";
import { pickRelatedExemplars } from "./related-exemplars.js";
import { RewriteCache } from "./rewrite-cache.js";
import { tokenSet } from "./tokenize.js";
import { tiebreakFactor } from "./metadata-tiebreaker.js";

const DEFAULT_LIMIT = 20;
const EXEMPLAR_RECALL_TIMEOUT_MS = 800;
const MAX_LIMIT = 100;

function isFactInjectionEnabled(): boolean {
  const raw = process.env["NLM_HOOK_INJECT_FACTS"];
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}
const SEMANTIC_OVERFETCH = 3;
const KEYWORD_OVERFETCH = 3;

// Down-rank factor for superseded hits in investigative recall. Applied once
// in finalize() after the recency multiplier so a superseded session can never
// outrank an equally-matching active one. Keyed on status, so it only ever
// touches the superseded hits that includeSuperseded let through. Task #303.
const SUPERSEDED_SCORE_MULTIPLIER = 0.7;

export interface RecallServiceDeps {
  readonly store: SessionStore;
  readonly llm: LLMClient;
  /**
   * Spec G.2: when present, RecallService can attach `relatedFacts` to its
   * results for callers that request `withRelatedFacts`. Optional — tests
   * and lightweight callers (CLI debugging) can omit it without losing
   * core recall functionality.
   */
  readonly factStore?: FactStore;
  /** Passive code-exemplar recall: when all three are present + the flag is
   *  on, search() attaches relatedExemplars for callers that opt in. */
  readonly exemplarStore?: CodeExemplarStore;
  readonly codeEmbedder?: CodeEmbedder;
  readonly installScope?: string;
  /**
   * Optional resolver for workstream-filter queries. Given an idOrLabel,
   * returns the array of member workstream ids (merge chains resolve to the
   * live survivor). Passed as `workstreamIds` into both search legs so the
   * SQL layer filters by workstream_id. When absent, `query.workstream` is a
   * no-op. Injected by buildStack(); tests can stub with a plain fn.
   */
  readonly resolveWorkstreamMembers?: (idOrLabel: string) => Promise<ReadonlyArray<string>>;
}

export class RecallService {
  private readonly rewriteCache = new RewriteCache();

  constructor(private readonly deps: RecallServiceDeps) {}

  async search(input: RecallQuery): Promise<RecallResult> {
    const mode: RecallMode = input.mode ?? "keyword";
    const limit = clampLimit(input.limit);
    const entity = input.entity ?? null;
    const kind = input.kind ?? null;

    const empty: RecallResult = {
      query: input.query,
      entity,
      kind,
      mode,
      limit,
      total: 0,
      results: [],
    };

    if (!input.query && !entity && !kind) return empty;

    // 0. Optional query rewrite. Fails open on LLM unreachable / parse error:
    //    keyword and semantic both fall back to the raw query, preserving
    //    pre-spec-C behavior. Cached for 5min to amortize repeat calls.
    let keywordQuery = input.query;
    let semanticQuery = input.query;
    if (input.rewrite === true && input.query) {
      const cached = this.rewriteCache.get(input.query);
      if (cached) {
        keywordQuery = cached.keywordQuery;
        semanticQuery = cached.semanticQuery;
      } else {
        try {
          const rewritten = await this.deps.llm.rewriteForRecall(input.query);
          this.rewriteCache.set(input.query, rewritten);
          keywordQuery = rewritten.keywordQuery;
          semanticQuery = rewritten.semanticQuery;
        } catch (err) {
          if (!(err instanceof LLMUnreachableError)) throw err;
          // fail-open: keywordQuery / semanticQuery already set to raw input.query
        }
      }
    }

    // 1. Resolve workstream membership before the search legs so the SQL can
    //    filter by workstream_id directly, eliminating the post-fetch JS filter.
    let workstreamIds: ReadonlyArray<string> | null = null;
    if (input.workstream && this.deps.resolveWorkstreamMembers) {
      workstreamIds = await this.deps.resolveWorkstreamMembers(input.workstream);
      if (workstreamIds.length === 0) return empty;
    }

    const searchOpts: SearchOptions = {
      ...(input.includeSuperseded === true ? { includeSuperseded: true } : {}),
      ...(workstreamIds ? { workstreamIds } : {}),
    };

    const kwNeighbors: ReadonlyArray<KeywordNeighbor> =
      (mode === "keyword" || mode === "hybrid") && keywordQuery
        ? await this.deps.store.keywordSearch(keywordQuery, limit * KEYWORD_OVERFETCH, searchOpts)
        : [];

    let semNeighbors: ReadonlyArray<SemanticNeighbor> = [];
    let semError: "ollama_unreachable" | null = null;
    if ((mode === "semantic" || mode === "hybrid") && semanticQuery) {
      try {
        const embedding = await this.deps.llm.embed(semanticQuery, "query");
        semNeighbors = await this.deps.store.semanticSearch(
          embedding.vector,
          limit * SEMANTIC_OVERFETCH,
          searchOpts,
        );
      } catch (err) {
        if (err instanceof LLMUnreachableError) {
          semError = "ollama_unreachable";
        } else {
          throw err;
        }
      }
    }

    if (mode === "semantic" && semError) {
      return { ...empty, modeUnavailable: semError };
    }

    // 2. Resolve ONLY the hit sessions — never the whole corpus. The
    //    entity/kind filter is applied to the fetched hits; a filtered-out
    //    session is absent from byId and is skipped during resolution.
    const hitIds = uniqueIds(kwNeighbors, semNeighbors);
    const hitSessions = await this.deps.store.getByIds(hitIds);
    const filterArgs: { entity?: string; kind?: typeof input.kind } = {};
    if (input.entity !== undefined) filterArgs.entity = input.entity;
    if (input.kind !== undefined) filterArgs.kind = input.kind;

    const byId = new Map<string, Session>(
      applyFilter(hitSessions, filterArgs).map((s) => [s.id, s]),
    );

    // 3. Build hits from the resolved sessions, preserving leg rank order.
    //    matchedIn uses the keyword (possibly rewritten) query so the badge
    //    reflects the tokens that actually drove the search.
    const queryTokens = keywordQuery
      ? new Set(tokenSet(keywordQuery))
      : new Set<string>();

    const kwHits: KeywordHit[] = [];
    for (const n of kwNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      kwHits.push({
        session,
        score: n.score,
        matchedIn: keywordMatchFields(session, queryTokens),
      });
    }

    const semHits: SemanticHit[] = [];
    for (const n of semNeighbors) {
      const session = byId.get(n.sessionId);
      if (!session) continue;
      semHits.push({ session, similarity: cosineFromL2(n.distance) });
    }

    // 4. Finalize per mode.
    let result: RecallResult;
    if (mode === "keyword") {
      result = finalize(input.query, entity, kind, mode, limit, kwHits.map(toKeywordHit), queryTokens);
    } else if (mode === "semantic") {
      result = finalize(input.query, entity, kind, mode, limit, semHits.map(toSemanticHit));
    } else {
      const merged = mergeHybrid(kwHits, semHits);
      const shape = detectQueryShape(input.query);
      const forceIncluded = (shape.hasTemporal && shape.hasNamedEntity)
        ? forceIncludeKeywordTop(merged, kwHits, limit)
        : merged;
      result = finalize(input.query, entity, kind, mode, limit, forceIncluded);
      if (semError) result = { ...result, modeUnavailable: semError };
    }

    // 5. Citation-frequency reranking is intentionally NOT applied. The offline
    //    ablation (scripts/eval/reranker-ablation.ts, docs/reranker-ablation-
    //    findings.md) showed it cannot help: inert at the raw FTS5 scale (the
    //    boost is swamped), and net-negative at every weight once scores are
    //    normalized — a globally-popular session displaces the genuinely-best
    //    per-query match (alpha 0.15 → R@1 -2.6pp; no alpha helps). citation
    //    frequency is a popularity prior, not a per-query relevance signal.
    //    buildCitationBoosts/applyBoosts are retained as the harness's tested
    //    utility and a hook for a future relevance-aware reranker.

    // 6. Spec G.2: optionally attach high-confidence facts about top entities.
    //    Only runs when the caller opts in AND a FactStore is wired. Failures
    //    silently no-op so recall never breaks because of fact lookup.
    //    (Note: citation boost in step 5 may have re-sorted results)
    if (input.withRelatedFacts === true && this.deps.factStore && isFactInjectionEnabled()) {
      const relatedFacts = await pickRelatedFacts(result.results, this.deps.factStore);
      if (relatedFacts.length > 0) {
        result = { ...result, relatedFacts };
      }
    }

    // 6b. Passive code-exemplar recall. Flag-gated, opt-in, and wrapped in a
    //     timeout so a slow/cold CodeRankEmbed call can never blow the hook's
    //     latency budget — on timeout or error we simply omit exemplars.
    if (
      input.withRelatedExemplars === true &&
      this.deps.exemplarStore &&
      this.deps.codeEmbedder &&
      this.deps.installScope &&
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1" &&
      (semanticQuery || input.query)
    ) {
      const store = this.deps.exemplarStore;
      const embedder = this.deps.codeEmbedder;
      const scope = this.deps.installScope;
      const q = semanticQuery || input.query;
      // AbortController lets us cancel the in-flight Ollama embed request the
      // moment the race timeout fires, rather than leaving it running in the
      // background where it ties up Ollama and delays the next embedding call.
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          abort.abort();
          rej(new Error("exemplar recall timeout"));
        }, EXEMPLAR_RECALL_TIMEOUT_MS);
      });
      try {
        const related = await Promise.race([
          pickRelatedExemplars(q, store, embedder, scope, { signal: abort.signal }),
          timeout,
        ]);
        if (related.length > 0) result = { ...result, relatedExemplars: related };
      } catch {
        // timed out or failed — proceed without exemplars
      } finally {
        clearTimeout(timer!);
      }
    }

    // 7. Resolve successor ids for any superseded hits that survived to the
    //    final result set (only possible when includeSuperseded was set).
    //    Edge-only lookup over the small returned hit set — never joined into
    //    the ranking query. Task #303.
    const supersededIds = result.results
      .filter((r) => r.status === "superseded")
      .map((r) => r.id);
    if (supersededIds.length > 0) {
      const successors = await this.deps.store.resolveSuccessors(supersededIds);
      result = {
        ...result,
        results: result.results.map((r) =>
          r.status === "superseded"
            ? { ...r, supersededBy: successors.get(r.id) ?? null }
            : r,
        ),
      };
    }

    return result;
  }
}

function uniqueIds(
  kw: ReadonlyArray<KeywordNeighbor>,
  sem: ReadonlyArray<SemanticNeighbor>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const n of kw) ids.add(n.sessionId);
  for (const n of sem) ids.add(n.sessionId);
  return [...ids];
}

interface KeywordHit {
  readonly session: Session;
  readonly score: number;
  readonly matchedIn: ReadonlyArray<MatchField>;
}

interface SemanticHit {
  readonly session: Session;
  readonly similarity: number;
}

/**
 * Keyword-primary hybrid merge (the inverse of the fact lane's semantic-primary
 * banding).
 *
 * For sessions the dominant quality signal is FTS5 BM25: only lexically-matching
 * sessions come back, and the keyword winner is almost always the intended hit.
 * RRF fused by rank let strong semantic-only neighbours demote keyword winners
 * at scale (hybrid 65% vs keyword 90% R@5 on the production decision-query set),
 * so this bands instead of fuses: keyword hits occupy the upper band [0.5, 1.0]
 * ranked by normalized BM25; semantic-only hits — sessions keyword never
 * surfaced — backfill the lower band [0, 0.5).
 *
 * keywordScore and semanticScore stay populated as min-max normalized
 * informational values so the UI can show "how strong was each leg." When
 * semantic is unavailable (Ollama down) semHits is empty and this degrades to
 * pure keyword, preserving the graceful-degradation contract.
 */
function mergeHybrid(
  kwHits: ReadonlyArray<KeywordHit>,
  semHits: ReadonlyArray<SemanticHit>,
): ReadonlyArray<RecallHit> {
  const maxKw = Math.max(1, ...kwHits.map((h) => h.score));
  const maxSem = Math.max(1, ...semHits.map((h) => h.similarity));
  const semMap = new Map<string, SemanticHit>(semHits.map((h) => [h.session.id, h]));

  const rows: RecallHit[] = [];
  const seen = new Set<string>();
  for (const kw of kwHits) {
    const sem = semMap.get(kw.session.id);
    rows.push({
      ...sessionHitFields(kw.session),
      matchScore: round4(0.5 + 0.5 * (kw.score / maxKw)),
      matchedIn: uniqueFields(kw.matchedIn, sem ? (["semantic"] as MatchField[]) : []),
      keywordScore: round4(kw.score / maxKw),
      semanticScore: sem ? round4(sem.similarity / maxSem) : 0,
    });
    seen.add(kw.session.id);
  }
  for (const sem of semHits) {
    if (seen.has(sem.session.id)) continue;
    rows.push({
      ...sessionHitFields(sem.session),
      matchScore: round4(0.5 * (sem.similarity / maxSem)),
      matchedIn: ["semantic"] as MatchField[],
      keywordScore: 0,
      semanticScore: round4(sem.similarity / maxSem),
    });
  }
  rows.sort((a, b) => b.matchScore - a.matchScore);
  return rows;
}

export { mergeHybrid as mergeHybridForTest };

/**
 * Force-include the keyword-leg rank-1 session into the merged top-`limit`
 * result. Only invoked when the query shape (temporal + named entity)
 * indicates a Mode A pattern where pure RRF is known to demote keyword
 * winners (see query-shape.ts for diagnosis). If the rank-1 keyword session
 * is already in the limited top-N, no change. Otherwise it's inserted at
 * position `limit - 1`, displacing the lowest-confidence merged hit.
 */
function forceIncludeKeywordTop(
  merged: ReadonlyArray<RecallHit>,
  kwHits: ReadonlyArray<KeywordHit>,
  limit: number,
): ReadonlyArray<RecallHit> {
  if (kwHits.length === 0 || merged.length === 0) return merged;
  const topId = kwHits[0]!.session.id;
  const top = merged.slice(0, limit);
  if (top.some((h) => h.id === topId)) return merged;
  const forcedHit = merged.find((h) => h.id === topId);
  if (!forcedHit) return merged;
  const kept = top.slice(0, Math.max(0, limit - 1));
  const tail = merged.slice(limit);
  return [...kept, forcedHit, ...tail];
}

function toKeywordHit(h: KeywordHit): RecallHit {
  return {
    ...sessionHitFields(h.session),
    matchScore: h.score,
    matchedIn: h.matchedIn,
  };
}

function toSemanticHit(h: SemanticHit): RecallHit {
  return {
    ...sessionHitFields(h.session),
    matchScore: h.similarity,
    matchedIn: ["semantic"],
  };
}

function sessionHitFields(s: Session) {
  return {
    id: s.id,
    startedAt: s.startedAt,
    label: s.label,
    summary: s.summary,
    entities: s.entities,
    decisions: s.decisions,
    open: s.open,
    status: s.status,
    supersededBy: null,
  } as const;
}

function finalize(
  query: string,
  entity: string | null,
  kind: RecallResult["kind"],
  mode: RecallMode,
  limit: number,
  hits: ReadonlyArray<RecallHit>,
  queryTokens?: ReadonlySet<string>,
): RecallResult {
  // Apply recency decay to every hit, then re-sort by adjusted score so
  // newer sessions surface ahead of equally-relevant older ones. The decay
  // is multiplicative; within a single query all hits use the same scale
  // (BM25, similarity, or RRF) so the multiplier preserves intra-mode
  // ranking when ages are similar and skews recent when ages diverge.
  // Disable per-deployment with NLM_RECALL_DECAY_HALF_LIFE_DAYS=0.
  //
  // The metadata tiebreaker (#308) is applied in the same multiplicative
  // step for keyword recall: a capped bonus for query tokens matching the
  // hit's decision markers / entity canonicals, reordering near-ties so a
  // strong decision-overlap session can pass a marginally-higher BM25
  // neighbour. queryTokens is only passed for the keyword leg.
  const now = Date.now();
  const adjusted: RecallHit[] = hits.map((h) => {
    const supersededFactor = h.status === "superseded" ? SUPERSEDED_SCORE_MULTIPLIER : 1;
    const tiebreak = queryTokens ? tiebreakFactor(queryTokens, h) : 1;
    return {
      ...h,
      matchScore: round4(
        h.matchScore * recencyMultiplier(h.startedAt, now) * supersededFactor * tiebreak,
      ),
    };
  });
  adjusted.sort((a, b) => b.matchScore - a.matchScore);
  return {
    query,
    entity,
    kind,
    mode,
    limit,
    total: adjusted.length,
    results: adjusted.slice(0, limit),
  };
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(MAX_LIMIT, Math.trunc(n));
}

function cosineFromL2(distance: number): number {
  // session_embeddings stores unit-normalized vectors. For unit vectors,
  // cos_sim = 1 - L2^2 / 2. Mirrors recall.py:_run_semantic.
  const cos = 1 - (distance * distance) / 2;
  return round4(Math.max(-1, Math.min(1, cos)));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function uniqueFields(
  a: ReadonlyArray<MatchField>,
  b: ReadonlyArray<MatchField>,
): ReadonlyArray<MatchField> {
  const seen = new Set<MatchField>();
  const out: MatchField[] = [];
  for (const f of [...a, ...b]) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}
