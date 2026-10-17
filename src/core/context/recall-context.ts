import type { FactStore, CurrentValueSummary } from "@ports/fact-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import type { FactHit, FactRecallResult, RecallHit, RecallMode, RecallResult, Session } from "@shared/types.js";
import { DEFAULT_FACT_MIN_CONFIDENCE, type FactRecallService } from "@core/recall-facts/fact-recall-service.js";
import type { RecallService } from "@core/recall/recall-service.js";
import type { RecallExecutionOptions } from "@core/recall/execution-options.js";
import { RequestBudget, embedForRecall } from "@core/recall/request-budget.js";
import { resolveRecallScope, type ResolvedRecallScope } from "@core/recall/resolve-scope.js";
import type { ContextLookup } from "./context-bundle.js";

export interface ContextRequest {
  readonly query: string;
  readonly workstream?: string | undefined;
  readonly subject?: string | undefined;
  readonly predicate?: string | undefined;
  readonly intent?: "auto" | "lookup" | "decision" | "state" | "history";
  readonly mode?: RecallMode | undefined;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}
export interface ContextDeps {
  readonly recall: RecallService;
  readonly factRecall?: FactRecallService;
  readonly factStore?: FactStore;
  readonly store: SessionStore;
  readonly workstreams?: { readonly store: WorkstreamStore };
  readonly now?: () => number;
}
export interface ContextCoverage {
  readonly facts: "complete" | "partial" | "unavailable";
  readonly sessions: "complete" | "partial" | "unavailable";
  readonly reasons: readonly string[];
}
export interface ContextResult {
  readonly intent: string;
  readonly exact: boolean;
  readonly scope: ResolvedRecallScope;
  readonly lookup?: ContextLookup;
  readonly facts: readonly FactHit[];
  readonly sessions: readonly RecallHit[];
  readonly sources: readonly Session[];
  readonly coverage: ContextCoverage;
  readonly modeUnavailable?: string;
  readonly factsExecuted: boolean;
  readonly sessionsExecuted: boolean;
}

export async function recallContext(tenantId: string, input: ContextRequest, deps: ContextDeps): Promise<ContextResult> {
  const budget = new RequestBudget(input.timeoutMs ?? 1_500, { ...input, ...(deps.now ? { now: deps.now } : {}) });
  const intent = input.intent && input.intent !== "auto" ? input.intent
    : /\b(why|rationale|reason|decide|decided|choose|chose)\b/i.test(input.query) ? "decision"
      : /\b(left off|still open|status|blocked|next step)\b/i.test(input.query) ? "state" : "lookup";
  const exact = !!input.subject && !!input.predicate && intent === "lookup";
  let scope: ResolvedRecallScope = input.workstream === undefined ? { status: "all" } : { status: "not_found", workstreamIds: [] };
  let lookup: ContextLookup | undefined = exact ? { subject: input.subject!, predicate: input.predicate!, complete: false,
    distinctValueCount: null, sourceSessionCount: null } : undefined;
  let facts: readonly FactHit[] = [];
  let sessions: readonly RecallHit[] = [];
  const sourceMap = new Map<string, Session>();
  let factCoverage: ContextCoverage["facts"] = "unavailable";
  let sessionCoverage: ContextCoverage["sessions"] = "unavailable";
  let factsExecuted = false;
  let sessionsExecuted = false;
  let modeUnavailable: string | undefined;
  const reasons: string[] = [];
  const hydrate = async (factHits: readonly FactHit[], sessionHits: readonly RecallHit[]) => {
    const ids = [...new Set([...factHits.map((f) => f.sourceSessionId), ...sessionHits.map((s) => s.id)])];
    if (!ids.length) return [];
    return budget.run(async () => {
      const metadata = await deps.store.getByIds(tenantId, ids);
      budget.check();
      const full = await Promise.all(sessionHits.map((s) => deps.store.getById(tenantId, s.id)));
      budget.check();
      const successors = await deps.store.resolveSuccessors(tenantId, ids);
      const byId = new Map(full.filter((s) => s !== null).map((s) => [s.id, s]));
      return metadata.map((s) => ({ ...(byId.get(s.id) ?? s), supersededBy: successors.get(s.id) ?? null }));
    });
  };
  const publishFacts = async (result: Pick<FactRecallResult, "results">) => {
    const sources = await hydrate(result.results, []);
    budget.check();
    facts = result.results;
    for (const source of sources) if (!sourceMap.has(source.id)) sourceMap.set(source.id, source);
    factCoverage = "partial";
  };
  const publishSessions = async (result: RecallResult) => {
    const sources = await hydrate([], result.results);
    budget.check();
    sessions = result.results;
    for (const source of sources) sourceMap.set(source.id, source);
    sessionCoverage = "partial";
  };
  try {
    budget.check();
    if (input.workstream !== undefined && deps.workstreams) {
      scope = await budget.run(() => resolveRecallScope(deps.workstreams!.store, tenantId, input.workstream));
    }
    const options: RecallExecutionOptions = { signal: budget.signal, deadlineAt: budget.deadlineAt, now: budget.now,
      ...(scope.status === "all" ? {} : { workstreamIds: scope.workstreamIds }),
      onPartialFacts: publishFacts, onPartialSessions: publishSessions };
    let current: CurrentValueSummary | null = null;
    if (exact && deps.factStore) {
      try {
        current = await budget.run(() => deps.factStore!.summarizeCurrentValues(tenantId, {
          subject: input.subject!, predicate: input.predicate!, minConfidence: DEFAULT_FACT_MIN_CONFIDENCE,
          ...(scope.status === "all" ? {} : { workstreamIds: scope.workstreamIds }),
        }));
        lookup = { subject: input.subject!, predicate: input.predicate!, complete: true,
          distinctValueCount: current.distinctValueCount, sourceSessionCount: current.sourceSessionCount };
      } catch { reasons.push("lookup_incomplete"); }
    }
    const unique = lookup?.complete === true && lookup.distinctValueCount === 1;
    const client = deps.recall.embeddingClient;
    if (!exact && (input.mode === "hybrid" || input.mode === "semantic") && input.query === input.query.trim() && client && client === deps.factRecall?.embeddingClient) {
      let shared: ReturnType<typeof embedForRecall> | undefined;
      Object.defineProperties(options, {
        queryEmbeddingIdentity: { value: { client, text: input.query, kind: "query" }, enumerable: true },
        queryEmbedding: { get: () => shared ??= embedForRecall(client, input.query,
          { signal: budget.signal, deadlineAt: budget.deadlineAt, now: budget.now }, Math.min(deps.recall.embeddingTimeoutMs, 2_000)), enumerable: true },
      });
    }
    const factLane = async () => {
      if (!deps.factRecall) reasons.push("facts_unavailable");
      try {
        const result = await budget.run<Pick<FactRecallResult, "results" | "modeUnavailable">>(() => {
          if (!deps.factRecall) return Promise.resolve({ results: [] });
          factsExecuted = true;
          return deps.factRecall.search(tenantId, {
            query: exact ? "" : input.query, mode: exact ? "keyword" : input.mode ?? "hybrid", limit: 12,
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.predicate ? { predicate: input.predicate } : {}),
            ...(intent === "decision" ? { kind: "decision" as const } : {}),
          }, options);
        });
        let hits = result.results;
        if (current && deps.factStore) {
          const missing = current.examples.filter((e) => !hits.some((f) => f.value === e.value));
          if (missing.length) {
            const sourceFacts = await budget.run(() => deps.factStore!.listBySessions(tenantId, [...new Set(missing.map((e) => e.sourceSessionId))]));
            hits = [...missing.flatMap((e) => {
              const fact = sourceFacts.find((f) => f.subject === input.subject && f.predicate === input.predicate
                && f.value === e.value && f.sourceSessionId === e.sourceSessionId && f.confidence >= DEFAULT_FACT_MIN_CONFIDENCE);
              return fact ? [{ ...fact, matchScore: 0, matchedIn: [] }] : [];
            }), ...hits];
          }
        }
        await publishFacts({ ...result, results: hits });
        factCoverage = !deps.factRecall ? (hits.length ? "partial" : "unavailable") : result.modeUnavailable ? (input.mode === "semantic" ? "unavailable" : "partial") : "complete";
        if (result.modeUnavailable) { modeUnavailable = result.modeUnavailable; reasons.push("facts_semantic_unavailable"); }
      } catch { reasons.push(budget.signal.aborted ? "facts_deadline_or_cancelled" : "facts_failed"); }
    };
    const sessionLane = async () => {
      if (unique) { sessionCoverage = "complete"; return; }
      try {
        const result = await budget.run(() => {
          sessionsExecuted = true;
          return deps.recall.search(tenantId, { query: input.query, mode: input.mode ?? "keyword", limit: 4,
            rewrite: false, includeSuperseded: intent === "history" }, options);
        });
        await publishSessions(result);
        sessionCoverage = result.modeUnavailable ? (input.mode === "semantic" ? "unavailable" : "partial") : "complete";
        if (result.modeUnavailable) { modeUnavailable = result.modeUnavailable; reasons.push("sessions_semantic_unavailable"); }
      } catch { reasons.push(budget.signal.aborted ? "sessions_deadline_or_cancelled" : "sessions_failed"); }
    };
    await Promise.all([factLane(), sessionLane()]);
  } catch { reasons.push(budget.signal.aborted ? "request_deadline_or_cancelled" : "scope_failed"); }
  finally { budget.dispose(); }
  return { intent, exact, scope, ...(lookup ? { lookup } : {}), facts: [...facts], sessions: [...sessions],
    sources: [...sourceMap.values()], coverage: { facts: factCoverage, sessions: sessionCoverage, reasons: [...reasons] },
    ...(modeUnavailable ? { modeUnavailable } : {}), factsExecuted, sessionsExecuted };
}
