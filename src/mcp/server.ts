import type { PropertyStore } from "@ports/property-store.js";
import { requireProperty, propertySlug } from "@core/properties/model.js";
import { validateSourceAnchor } from "@core/facts/source-anchor.js";
import { bodyVersion } from "@core/context/source-version.js";
import { resolveRecallScope, type ResolvedRecallScope } from "@core/recall/resolve-scope.js";
/**
 * MCP adapter. Binds the `recall_sessions` and `get_session` tools directly
 * to RecallService and SessionStore — no HTTP hop, no localhost loopback.
 *
 * The Python daemon's MCP server proxied through HTTP. This server runs in
 * the same process as the rest of nlm-memory, so a tool call is a function
 * call. Lower latency, simpler stack traces, one fewer thing to keep alive.
 *
 * Layering: this module knows about the inner ring (RecallService,
 * SessionStore); core/ does not know this module exists.
 */

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encode as toonEncode, decode as toonDecode } from "@toon-format/toon";
import { z } from "zod";
import { logQuery } from "@core/recall/query-log.js";
import { logFactQuery } from "@core/recall-facts/fact-query-log.js";
import { appendCitation } from "@core/recall/citation-log.js";
import { resolveConversationForSession } from "@core/hook/memo.js";
import { recallContext } from "@core/context/recall-context.js";
import { appendFactSupersedence, appendSupersedence, readSupersedenceLog } from "@core/storage/supersedence-log.js";
import { DEFAULT_FACT_MIN_CONFIDENCE, type FactRecallService } from "@core/recall-facts/fact-recall-service.js";
import type { RecallService } from "@core/recall/recall-service.js";
import type { FactStore } from "@ports/fact-store.js";
import type { SessionStore } from "@ports/session-store.js";
import { recallCode } from "@core/exemplars/recall-code.js";
import { buildWorkDigest, type BuildWorkDigestDeps } from "@core/work-digest/build-work-digest.js";
import { composeWorkDigest } from "@core/work-digest/compose-work-digest.js";
import { rollupWorkstream } from "@core/workstream/rollup.js";
import { composeWorkstreamRecall } from "@core/workstream/compose-recall.js";
import { normalizeLabel } from "@core/workstream/model.js";
import type { Workstream } from "@core/workstream/model.js";
import { resolveWorkstreamId } from "@core/workstream/resolve.js";
import { suggestMerges } from "@core/workstream/merge-suggest.js";
import { normalizeSignal } from "@core/signals/ingest-signal.js";
import { stampSignalScope, type SessionScopeReader } from "@core/signals/stamp-scope.js";
import type { SignalStore } from "@ports/signal-store.js";
import { deriveOutcome } from "@core/outcome/rollup.js";
import { buildSqliteOutcomeDeps } from "@core/storage/sqlite-outcome-store.js";
import {
  completeLearnerCourse,
  enrollCourse,
  getCourseSummary,
  recordLearningEvent,
} from "@core/learner/service.js";
import { truncateSummary } from "@core/hook/pointer-block.js";
import type {
  FactKind,
  FactRecallQuery,
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";
import { SIGNAL_OUTCOMES } from "@shared/types.js";
import type Database from "better-sqlite3";

import { buildContextBundle } from "@core/context/context-bundle.js";
import { boundedFormat } from "./response-budget.js";
import { sessionRecallInput, readRecallCursor, sessionRecallPage } from "./session-recall-page.js";
import { matchedPassages, relevantStrings, transcriptPage } from "@core/context/session-evidence.js";

function trustedConversationId(deps: McpDeps, tenantId: string): string | undefined {
  return deps.requestContext?.tenantId === tenantId ? deps.requestContext.conversationId : undefined;
}

const CHARACTER_LIMIT = 25_000;
const DEFAULT_LIMIT = 10;
const SERVER_NAME = "nlm-memory-mcp-server";
const SERVER_VERSION = "0.5.9";

/** TOON encoding cuts token usage on large recall payloads. Opt in via
 *  NLM_FORMAT=toon. Defaults to JSON.
 *
 *  Read at call time, not module scope: on the HTTP transport this module is
 *  imported by the daemon long before buildStack() calls autoloadEnv(), so an
 *  eager read would capture the environment before ~/.nlm/.env was loaded and
 *  silently ignore the setting. Only the stdio path, where the runtime passes
 *  env directly to the child, would have worked. */
const useToon = (): boolean => process.env.NLM_FORMAT === "toon";

export interface McpDeps {
  readonly properties?: Pick<PropertyStore, "list">;
  readonly recall: RecallService;
  readonly requestContext?: { readonly tenantId: string; readonly conversationId?: string; readonly signal?: AbortSignal };
  readonly store: SessionStore;
  /** Optional — when absent, fact tools are not registered. */
  readonly factRecall?: FactRecallService;
  readonly factStore?: FactStore;
  /** Optional — when present, recall_code tool is registered. */
  readonly exemplarStore?: import("@ports/code-exemplar-store.js").CodeExemplarStore;
  /** Optional code embedder for recall_code semantic search. */
  readonly codeEmbedder?: import("@ports/code-embedder.js").CodeEmbedder;
  readonly installScope?: string;
  /** Wire to enable report_outcome (writes to the same signals store /api/signal uses). */
  readonly signalStore?: SignalStore;
  /** Scope inheritance for report_outcome, mirroring /api/signal: a
   *  session-correlated signal inherits that session's stamped scope. */
  readonly sessionScopeReader?: SessionScopeReader;
  /** Wire to enable the work_summary tool (operator daily work digest). */
  readonly workDigest?: BuildWorkDigestDeps;
  /** Wire to enable recall_workstream. Mirrors RollupDeps + the store for idOrLabel resolution. */
  readonly workstreams?: {
    readonly store: import("@ports/workstream-store.js").WorkstreamStore;
    readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
    readonly facts: Pick<FactStore, "listBySessions">;
    readonly exemplars: Pick<import("@ports/code-exemplar-store.js").CodeExemplarStore, "listBySessions">;
  };
  /** Wire to enable the learner_* tools (Gnos-style concept tracking; spec 2026-10-06). */
  readonly learners?: {
    readonly store: import("@ports/learner-store.js").LearnerStore;
    readonly workstreams: Pick<import("@ports/workstream-store.js").WorkstreamStore, "getById" | "findByNormalizedLabel">;
    readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams" | "getByIds">;
  };
  /**
   * Raw SQLite handle for the Tier-B outcome rollup (#352 phase 2). Wire to
   * attach `outcome` to get_session's response; omit to skip it (e.g. under
   * PgStorage, which has no adapter yet).
   */
  readonly outcomeDb?: Database.Database;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function format(data: unknown): string {
  if (useToon()) {
    try {
      const text = toonEncode(data);
      // Some bracketed transcript strings encode successfully but cannot be decoded.
      toonDecode(text);
      return text;
    } catch {
      return JSON.stringify(data);
    }
  }
  return JSON.stringify(data);
}

function truncate(data: unknown): string {
  return boundedFormat(data, format, CHARACTER_LIMIT);
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: truncate(data) }] };
}

function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

// Pure handler functions — exported so tests can exercise them without an
// MCP transport. The McpServer wrapper below just registers these.

export type RecallToolInput = z.input<typeof sessionRecallInput>;

function mcpRewriteDefault(): boolean {
  // MCP callers default to rewrite=true since they're already in explicit
  // memory-search context and latency-tolerant. Env var overrides per
  // deployment if the rewrite step regresses quality on a given corpus.
  const raw = process.env["NLM_RECALL_REWRITE_DEFAULT"];
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Normalize an MCP client's self-reported identity (from the initialize
 * handshake's clientInfo) into a runtime attribution string for the recall
 * query-log. Returns null when no usable name is present, so the log stays
 * honest about unknown callers. Trim + lowercase keeps aggregation clean
 * (claude-code, cursor, hermes) and matches the hook-side runtime convention.
 */
export function mcpRuntimeFromClient(
  client: { name?: string } | undefined,
): string | null {
  const name = client?.name?.trim().toLowerCase();
  return name ? name : null;
}

export async function recallSessionsHandler(
  deps: McpDeps,
  tenantId: string,
  input: Partial<RecallToolInput>,
  runtime: string | null = null,
): Promise<ToolResult> {
  try {
    const args = sessionRecallInput.parse(input);
    args.rewrite ??= mcpRewriteDefault();
    const cursor = readRecallCursor(args, tenantId);
    const rewrite = args.rewrite;
    const query: RecallQuery = {
      query: args.query,
      mode: args.mode,
      limit: args.candidateLimit,
      rewrite,
      // Investigative surface: include superseded sessions, down-ranked and
      // badged with their successor in `supersededBy`, so an agent chasing a
      // decision sees the overturned reasoning rather than a silent gap. Task #303.
      includeSuperseded: true,
      ...(args.entity !== undefined ? { entity: args.entity } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.workstream !== undefined ? { workstream: args.workstream } : {}),
      ...(args.property !== undefined ? { property: args.property } : {}),
    };
    const result = await deps.recall.search(tenantId, query);
    const page = sessionRecallPage(result, args, cursor, format);
    const conversationId = trustedConversationId(deps, tenantId);
    // Telemetry — the MCP path is the real agent-usage path; without this it
    // is invisible to query_log.jsonl and the Recall page. Fire-and-forget,
    // mirrors the HTTP /api/recall handler.
    void logQuery(tenantId, {
      source: "mcp",
      runtime,
      query: args.query ?? null,
      entity: args.entity ?? null,
      kind: args.kind ?? null,
      mode: args.mode ?? "keyword",
      limit: args.limit,
      nResults: result.total,
      returnedIds: page.returnedIds,
      ...(args.workstream !== undefined ? { workstream: args.workstream } : {}),
      ...(args.property !== undefined ? { property: args.property } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return { content: [{ type: "text", text: page.text }] };
  } catch (e) {
    return err(e);
  }
}

export async function workSummaryHandler(
  deps: McpDeps,
  tenantId: string,
  input: { date?: string | undefined },
): Promise<ToolResult> {
  if (!deps.workDigest) {
    return okText("work_summary is not available in this deployment.");
  }
  try {
    const date = input.date ?? localToday();
    const digest = await buildWorkDigest(deps.workDigest, tenantId, date);
    return okText(composeWorkDigest(digest));
  } catch (e) {
    return err(e);
  }
}

export async function recallWorkstreamHandler(
  deps: McpDeps,
  tenantId: string,
  input: { idOrLabel?: string },
  runtime: string | null = null,
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("recall_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const conversationId = trustedConversationId(deps, tenantId);
    const ws = deps.workstreams.store;
    const found =
      (await ws.getById(tenantId, idOrLabel)) ?? (await ws.findByNormalizedLabel(tenantId, normalizeLabel(idOrLabel)));
    if (!found) return okText(`No workstream matches "${idOrLabel}".`);
    const view = await rollupWorkstream(
      { workstreams: deps.workstreams.store, sessions: deps.workstreams.sessions, facts: deps.workstreams.facts, exemplars: deps.workstreams.exemplars },
      tenantId,
      found.id,
    );
    if (!view) return okText(`No workstream matches "${idOrLabel}".`);
    void logQuery(tenantId, {
      source: "mcp",
      runtime,
      query: idOrLabel,
      entity: null,
      kind: null,
      mode: "keyword",
      limit: 1,
      nResults: 1,
      returnedIds: [found.id],
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return okText(composeWorkstreamRecall(view));
  } catch (e) {
    return err(e);
  }
}

/** idOrLabel -> live survivor workstream (merged_into resolved) | null, within tenantId. One source of truth for lifecycle handlers. */
async function resolveWorkstream(
  store: import("@ports/workstream-store.js").WorkstreamStore,
  tenantId: string,
  idOrLabel: string,
): Promise<Workstream | null> {
  const found =
    (await store.getById(tenantId, idOrLabel)) ?? (await store.findByNormalizedLabel(tenantId, normalizeLabel(idOrLabel)));
  if (!found) return null;
  const all = await store.listAll(tenantId);
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const survivorId = resolveWorkstreamId(found.id, byId);
  return survivorId === found.id ? found : ((await store.getById(tenantId, survivorId)) ?? found);
}

export async function renameWorkstreamHandler(
  deps: McpDeps,
  tenantId: string,
  input: { idOrLabel?: string; label?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rename_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    const label = (input.label ?? "").trim();
    if (!idOrLabel || !label) return okText("Provide the workstream (id or label) and the new label.");
    const ws = deps.workstreams.store;
    const target = await resolveWorkstream(ws, tenantId, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    const collision = await ws.findByNormalizedLabel(tenantId, normalizeLabel(label));
    if (collision && collision.id !== target.id) {
      return okText(`Label "${label}" is already used by workstream "${collision.label}" (${collision.id}).`);
    }
    await ws.setLabel(tenantId, target.id, label);
    return okText(`Renamed workstream ${target.id}: "${target.label}" -> "${label}".`);
  } catch (e) {
    return err(e);
  }
}

export async function retireWorkstreamHandler(
  deps: McpDeps,
  tenantId: string,
  input: { idOrLabel?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("retire_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const target = await resolveWorkstream(deps.workstreams.store, tenantId, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    await deps.workstreams.store.setStatus(tenantId, target.id, "retired");
    return okText(`Retired workstream "${target.label}" (${target.id}).`);
  } catch (e) {
    return err(e);
  }
}

export async function mergeWorkstreamsHandler(
  deps: McpDeps,
  tenantId: string,
  input: { from?: string; into?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("merge_workstreams is not available in this deployment.");
  try {
    const fromArg = (input.from ?? "").trim();
    const intoArg = (input.into ?? "").trim();
    if (!fromArg || !intoArg) return okText("Provide both `from` and `into` (workstream id or label).");
    const ws = deps.workstreams.store;
    const from = await resolveWorkstream(ws, tenantId, fromArg);
    const into = await resolveWorkstream(ws, tenantId, intoArg);
    if (!from) return okText(`No workstream matches "${fromArg}".`);
    if (!into) return okText(`No workstream matches "${intoArg}".`);
    if (from.id === into.id) return okText(`"${fromArg}" and "${intoArg}" resolve to the same workstream — nothing to merge.`);
    await ws.merge(tenantId, from.id, into.id);
    return okText(`Merged "${from.label}" (${from.id}) into "${into.label}" (${into.id}).`);
  } catch (e) {
    return err(e);
  }
}

export async function rebindSessionHandler(
  deps: McpDeps,
  tenantId: string,
  input: { sessionId?: string; workstream?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rebind_session is not available in this deployment.");
  try {
    const sessionId = (input.sessionId ?? "").trim();
    const wsArg = (input.workstream ?? "").trim();
    if (!sessionId || !wsArg) return okText("Provide both a sessionId and a workstream (id or label).");
    const ws = await resolveWorkstream(deps.workstreams.store, tenantId, wsArg);
    if (!ws) return okText(`No workstream matches "${wsArg}".`);
    await deps.store.setWorkstreamBinding(tenantId, sessionId, ws.id, "operator", null);
    return okText(`Rebound session ${sessionId} -> workstream "${ws.label}" (${ws.id}).`);
  } catch (e) {
    return err(e);
  }
}

/** YYYY-MM-DD for "today" in the process timezone. */
function localToday(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

async function requestedScope(deps: McpDeps, tenantId: string, workstream?: string): Promise<ResolvedRecallScope> {
  if (workstream === undefined) return { status: "all" };
  if (!deps.workstreams) return { status: "not_found", workstreamIds: [] };
  return resolveRecallScope(deps.workstreams.store, tenantId, workstream);
}

async function scopedSessionIds(deps: McpDeps, tenantId: string, ids: readonly string[], scope: ResolvedRecallScope): Promise<Set<string>> {
  if (scope.status === "all") return new Set(ids);
  const bindings = await deps.store.getWorkstreamIds(tenantId, ids);
  return new Set(ids.filter((id) => {
    const binding = bindings.get(id);
    return binding != null && scope.workstreamIds.some((ws) => ws === binding);
  }));
}

const contextInput = z.object({
  property: propertySlug.optional(),
  timeoutMs: z.number().int().min(100).max(5_000).default(1_500),
  workstream: z.string().min(1).max(500).optional(),
  query: z.string().min(1).max(2_000),
  subject: z.string().min(1).max(200).optional(),
  predicate: z.string().min(1).max(100).optional(),
  intent: z.enum(["auto", "lookup", "decision", "state", "history"]).default("auto"),
  mode: z.enum(["keyword", "semantic", "hybrid"]).optional(),
  maxChars: z.number().int().min(2_000).max(20_000).default(8_000),
});

export async function recallContextHandler(
  deps: McpDeps, tenantId: string, input: z.input<typeof contextInput>, runtime: string | null = null,
): Promise<ToolResult> {
  try {
    const args = contextInput.parse(input);
    const context = await recallContext(tenantId, { ...args,
      ...(deps.requestContext?.tenantId === tenantId && deps.requestContext.signal ? { signal: deps.requestContext.signal } : {}),
    }, deps);
    const { intent, exact } = context;
    const responseMetadata = { intent, scope: { ...context.scope, ...(args.property !== undefined ? { property: args.property } : {}), ...(args.workstream !== undefined ? { workstream: args.workstream } : {}) },
      coverage: context.coverage,
      ...(context.modeUnavailable ? { modeUnavailable: context.modeUnavailable } : {}),
      ...(!deps.factRecall ? { factsUnavailable: true } : {}),
    };
    const bundle = buildContextBundle(args.query, context.facts, context.sessions, context.sources,
      args.maxChars, args.workstream, context.lookup, responseMetadata, format);
    const conversationId = trustedConversationId(deps, tenantId);
    if (context.sessionsExecuted) void logQuery(tenantId, { source: "mcp", runtime, query: args.query, entity: null,
      kind: null, mode: args.mode ?? "keyword", limit: 4, nResults: bundle.sessions.length,
      returnedIds: bundle.sessions.map((s) => s.id),
      ...(args.workstream !== undefined ? { workstream: args.workstream } : {}),
      ...(args.property !== undefined ? { property: args.property } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    if (context.factsExecuted) void logFactQuery(tenantId, { source: "mcp", runtime, query: args.query,
      subject: args.subject ?? null, predicate: args.predicate ?? null,
      kind: intent === "decision" ? "decision" : null, mode: exact ? "keyword" : args.mode ?? "hybrid", limit: 12,
      nResults: bundle.facts.length, returnedIds: bundle.facts.map((f) => f.id),
      ...(args.workstream !== undefined ? { workstream: args.workstream } : {}),
      ...(args.property !== undefined ? { property: args.property } : {}),
      ...(conversationId ? { conversationId } : {}),
    });
    return { content: [{ type: "text", text: format(bundle) }] };
  } catch (e) {
    return err(e);
  }
}

const sessionInput = z.object({
  workstream: z.string().min(1).max(500).optional(),
  id: z.string().min(1).max(500),
  version: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  query: z.string().max(2_000).optional(),
  view: z.enum(["context", "transcript"]).default("context"),
  offset: z.number().int().min(0).default(0),
  maxChars: z.number().int().min(2_000).max(20_000).default(8_000),
});

export async function getSessionHandler(
  deps: McpDeps,
  tenantId: string,
  input: z.input<typeof sessionInput>,
): Promise<ToolResult> {
  try {
    const args = sessionInput.parse(input);
    const scope = await requestedScope(deps, tenantId, args.workstream);
    const allowed = await scopedSessionIds(deps, tenantId, [input.id], scope);
    if (!allowed.has(input.id)) return err(new Error(`session ${input.id} not found`));
    const scopeArgs = args.workstream !== undefined ? { workstream: args.workstream } : {};
    const session = await deps.store.getById(tenantId, input.id);
    if (!session) {
      return err(new Error(`session ${input.id} not found`));
    }

    if (scope.status !== "all" && !scope.workstreamIds.some((id) => id === session.workstreamId)) {
      return err(new Error(`session ${input.id} not found`));
    }

    // Enrich supersedence links with labels so AI callers get context, not just opaque IDs
    const linkedIds: string[] = [
      ...(session.supersedes ?? []),
      ...(session.supersededBy ? [session.supersededBy] : []),
    ];
    const linked =
      linkedIds.length > 0 ? await deps.store.getByIds(tenantId, linkedIds) : [];
    const linkedAllowed = await scopedSessionIds(deps, tenantId, linked.map((s) => s.id), scope);
    const byId = new Map(linked.filter((s) => linkedAllowed.has(s.id)).map((s) => [s.id, s]));

    // Load supersedence log once so we can join reason + recordedBy onto supersededBy
    const supersedenceLog = session.supersededBy
      ? await readSupersedenceLog(tenantId)
      : [];
    const supersedenceMap = new Map(supersedenceLog.map((e) => [e.predecessorId, e]));

    const supersedes = (session.supersedes ?? []).map((id) => {
      const s = byId.get(id);
      return s ? { id, label: s.label, summary: s.summary } : { id, label: "", summary: "" };
    });
    // Supersedence-enrichment fencing (program spec §4.6 hardening 2): even
    // though readSupersedenceLog now reads the caller's own tenant file, a
    // log entry's `reason`/`recordedBy` may only surface for a successor id
    // that resolved through the tenant-filtered getByIds above (`byId`) —
    // defense in depth against any pre-M6 legacy entry that predates
    // per-tenant log files. An unresolved id contributes nothing — not even
    // its reason — same as the by-id not-found shape (case 4).
    const supersededBy = session.supersededBy
      ? (() => {
          const s = byId.get(session.supersededBy);
          if (!s) return { id: session.supersededBy, label: "", summary: "" };
          const logEntry = supersedenceMap.get(session.id);
          return {
            id: session.supersededBy,
            label: s.label,
            summary: s.summary,
            reason: logEntry?.reason,
            recordedBy: logEntry?.source,
          };
        })()
      : null;

    // Isolated: the outcome rollup is enrichment, not the payload. A throw
    // here (SQLITE_BUSY, stale handle, unmigrated db) must degrade to
    // no-outcome, never fail the whole get_session call.
    let outcome;
    if (deps.outcomeDb) {
      try {
        outcome = await deriveOutcome(tenantId, session.id, await buildSqliteOutcomeDeps(deps.outcomeDb, tenantId));
      } catch {
        outcome = undefined;
      }
    }

    if (args.view === "transcript") {
      if (args.offset > session.body.length) return err(new Error("offset exceeds transcript length"));
      const version = bodyVersion(session.body);
      if (args.version && args.version !== version) return err(new Error("Transcript changed; restart at offset 0."));
      let size = args.maxChars - 1_000;
      for (;;) {
        const { text: body, ...page } = transcriptPage(session.body, args.offset, size);
        const text = format({ id: session.id, status: session.status,
          supersededBy: supersededBy?.id ?? null, version, body, ...page,
          next: page.nextOffset === null ? null : {
            id: session.id, ...scopeArgs, view: "transcript", offset: page.nextOffset, maxChars: args.maxChars, version,
          } });
        if (text.length <= args.maxChars) return { content: [{ type: "text", text }] };
        size -= Math.max(100, text.length - args.maxChars);
        if (size < 1) return err(new Error("Response metadata exceeds maxChars; increase the budget."));
      }
    }
    const facts = deps.factStore ? await deps.factStore.listBySession(tenantId, session.id) : [];
    const currentFacts = facts.filter((f) => !f.supersededBy && !f.retiredAt);
    const decisions = relevantStrings(session.decisions, args.query ?? "");
    const open = relevantStrings(session.open, args.query ?? "");
    return { content: [{ type: "text", text: boundedFormat({
      id: session.id, label: session.label, startedAt: session.startedAt, status: session.status,
      summary: session.summary, decisions, open, entities: session.entities,
      facts: currentFacts.slice(0, 8).map((f) => ({ id: f.id, kind: f.kind, subject: f.subject,
        predicate: f.predicate, value: f.value, sourceQuote: f.sourceQuote,
        sourceAnchor: validateSourceAnchor(f.sourceAnchor, session.bodyVersion) })),
      passages: args.query ? matchedPassages(session, args.query) : [],
      omitted: { decisions: session.decisions.length - decisions.length,
        open: session.open.length - open.length, facts: Math.max(0, currentFacts.length - 8) },
      supersedes, supersededBy, ...(outcome ? { outcome } : {}),
      expand: { id: session.id, ...scopeArgs, view: "transcript", offset: 0, maxChars: args.maxChars },
    }, format, args.maxChars) }] };

  } catch (e) {
    return err(e);
  }
}

export interface RecallFactsInput {
  property: string | undefined;
  workstream: string | undefined;
  query: string | undefined;
  subject: string | undefined;
  predicate: string | undefined;
  kind: FactKind | undefined;
  mode: RecallMode | undefined;
  includeSuperseded: boolean | undefined;
  minConfidence: number | undefined;
  limit: number | undefined;
}

export async function recallFactsHandler(
  deps: McpDeps,
  tenantId: string,
  input: Partial<RecallFactsInput>,
  runtime: string | null = null,
): Promise<ToolResult> {
  if (!deps.factRecall) {
    return err(new Error("fact recall not wired in this deployment"));
  }
  try {
    const query: FactRecallQuery = {
      query: input.query ?? "",
      ...(input.property !== undefined ? { property: input.property } : {}),
      ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
      mode: input.mode ?? "hybrid",
      limit: input.limit ?? DEFAULT_LIMIT,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.includeSuperseded !== undefined
        ? { includeSuperseded: input.includeSuperseded }
        : {}),
      ...(input.minConfidence !== undefined
        ? { minConfidence: input.minConfidence }
        : {}),
    };
    const result = await deps.factRecall.search(tenantId, query);
    const conversationId = trustedConversationId(deps, tenantId);
    // Telemetry — see recallSessionsHandler. Fire-and-forget.
    void logFactQuery(tenantId, {
      source: "mcp",
      runtime,
      query: input.query ?? null,
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      kind: input.kind ?? null,
      mode: input.mode ?? "hybrid",
      limit: input.limit ?? DEFAULT_LIMIT,
      nResults: result.total,
      returnedIds: result.results.map((r) => r.id),
      ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
      ...(input.property !== undefined ? { property: input.property } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return ok(result);
  } catch (e) {
    return err(e);
  }
}

export interface RecallCodeInput {
  readonly query: string;
  readonly repo?: string | undefined;
  readonly lang?: string | undefined;
  readonly k?: number | undefined;
  readonly include_negatives?: boolean | undefined;
}

export async function recallCodeHandler(
  deps: McpDeps,
  tenantId: string,
  input: RecallCodeInput,
  runtime: string | null = null,
): Promise<ToolResult> {
  if (!deps.exemplarStore || !deps.installScope) {
    return err(new Error("code exemplars not wired in this deployment"));
  }
  try {
    const result = await recallCode(
      tenantId,
      {
        query: input.query,
        installScope: deps.installScope,
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.lang ? { lang: input.lang } : {}),
        k: input.k ?? 5,
        includeNegatives: input.include_negatives ?? true,
      },
      deps.exemplarStore,
      deps.codeEmbedder ?? null,
      null,
    );
    const conversationId = trustedConversationId(deps, tenantId);
    const allIds = [
      ...result.positives.map((e) => e.id),
      ...result.negatives.map((e) => e.id),
    ];
    // Telemetry — marks the pull as a code pull so usefulness evals can
    // attribute it without overloading the kind filter enum.
    void logQuery(tenantId, {
      source: "mcp",
      runtime,
      query: input.query,
      entity: null,
      kind: null,
      mode: "semantic",
      limit: input.k ?? 5,
      nResults: allIds.length,
      returnedIds: allIds,
      tool: "recall_code",
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return { content: [{ type: "text", text: format(result) }] };
  } catch (e) {
    return err(e);
  }
}

export async function getFactHistoryHandler(
  deps: McpDeps,
  tenantId: string,
  input: { subject: string; predicate?: string | undefined; workstream?: string | undefined; property?: string | undefined },
): Promise<ToolResult> {
  if (!deps.factStore) {
    return err(new Error("fact store not wired in this deployment"));
  }
  try {
    const scope = await requestedScope(deps, tenantId, input.workstream);
    await requireProperty(tenantId, input.property, deps.properties);
    const raw = scope.status === "not_found" ? [] : await deps.factStore.getHistory(tenantId, input.subject, input.predicate, input.property);
    const allowed = await scopedSessionIds(deps, tenantId, raw.flatMap((c) => c.history.map((f) => f.sourceSessionId)), scope);
    const chains = raw.map((c) => ({ ...c, history: c.history.filter((f) => allowed.has(f.sourceSessionId)) }))
      .filter((c) => c.history.length > 0);
    return ok({ subject: input.subject, predicate: input.predicate ?? null, chains });
  } catch (e) {
    return err(e);
  }
}

const CITE_SESSION_DESCRIPTION = `Log that you used a previously-surfaced session in your response. Pass the session ID. This feeds the recall precision metric, which measures what fraction of surfaced sessions were actually useful. Call after writing your response, with one cite per surfaced session you actually drew from.`;

const RECALL_DESCRIPTION = `Search prior AI sessions across every runtime the user has connected (Claude Code,
Hermes, pi, Codex, Gemini, Aider). Local-first, fast (~200-400ms warm), idempotent,
safe to call eagerly. No rate limit; no cost per call.

CALL THIS FIRST — before answering — whenever the user prompt contains any of:

  Decision / position questions
    "what did we decide about X" · "did we figure out X" · "what's our take on X"
    "have we tried X" · "where did we land on X" · "what was the conclusion"

  Status / open-thread questions
    "what's still open on X" · "where did we leave X" · "what's blocked on X"
    "what's the state of X" · "is X done"

  History / continuity questions
    "have I worked on X" · "when did we last X" · "did we already do X"
    "have I talked to <person>" · "what's the history with X"

  Implicit references to prior context (the dangerous case — easy to miss)
    "that pgvector thing" · "the X discussion" · "our auth approach"
    "the one we built for <client>" · "the issue we hit last week"

Not calling when the user references past work is the failure mode this tool exists
to prevent: re-derivation of already-solved problems, contradicting prior decisions,
re-litigating resolved open questions, ignoring the user's accumulated context.

Returns compact ranked session digests: ID, title, date, short summary, relevant
decisions/open questions, status and supersededBy. Omitted fields and shortened text
are marked. Pass a hit's expand arguments to get_session for source evidence.
Responses fit maxChars (default 8000 characters, not tokens). When has_more is true,
repeat the same search arguments with cursor=nextCursor. Keep query, filters, mode
and rewrite/candidateLimit unchanged; limit and maxChars may change. Cursors detect ranking changes
and require a restart rather than silently skipping results. candidateLimit defaults
to 10, preserving the existing retrieval window; raise it explicitly (up to 100)
for a wider search. It can change ranking, not just page count. total, availableResults
and outsideWindow describe candidate coverage, not an exhaustive corpus match count. Prefer recall_context for answers combining facts and sources.

Superseded sessions ARE included here, down-ranked below active matches and
flagged with status="superseded" and a superseded_by pointer to the session
that corrected them. A superseded hit is overturned reasoning: read it for
history, but prefer the successor in superseded_by for the current state — do
NOT repeat a superseded decision as if it still holds.

Skip ONLY when the request is purely forward-looking with no plausible prior
context — drafting wholly new content, naming something new, brainstorming
greenfield ideas. When in doubt, call.

When you reference a returned session in your response, call \`cite_session(id)\` to log it so NLM can measure which surfaced sessions are useful.

Args:
  - query: keyword(s) to search. Token-weighted match against label, decisions,
           open questions, and summary. Optional if entity or kind is provided.
  - entity: filter to sessions tagged with this entity. Optional.
  - kind: "decision" or "open" — restrict to sessions containing that marker
          kind. Omit for any. Optional.
  - mode: Defaults to keyword (FTS5 BM25); hybrid and semantic are available.
          Optional.
  - limit: max results per page (1-100, default 5).
  - candidateLimit: retrieved candidate window (1-100, default 10).
  - maxChars: response character budget (2000-20000, default 8000).
  - cursor: nextCursor from a prior page of this same search.`;

const GET_SESSION_DESCRIPTION = `Read a session's compact structured context: summary, decisions, open questions,
current facts, supersedence and outcome. Pass query to include matching original
passages with exact character offsets. Prefer recall_context for a question across
memory. Do not fetch full transcripts by default.

For exact wording or more evidence, use view="transcript" and offset (default 0).
Follow next until null to read all pages; next includes a version to detect a
changed transcript. maxChars (2000-20000, default 8000)
bounds the response in characters, not model tokens. Offsets are UTF-16 string
positions into the stored transcript. An ID-only call returns context, not a body.`;

const RECALL_FACTS_DESCRIPTION = `Look up specific (subject, predicate, value) facts the user has established in
prior sessions — model aliases, framework choices, endpoints, ports, hosts,
deadlines, pricing, owners, dependencies, etc.

CALL THIS when the user asks for a concrete value rather than a prose summary:

  "what port is X on" · "what model does Y use" · "what's the endpoint for Z"
  "what framework did we pick for X" · "who owns the X project"
  "when's the X deadline" · "what did we set X to" · "where does X live"
  "what version of X are we on" · "what's our X account"

Prefer this over recall_sessions when the user wants the *answer*, not the
*conversation* — facts return the exact value with provenance (source session
+ source quote), no scanning required. recall_sessions is the right tool when
the user wants context, reasoning, or the full discussion.

Returns matching Fact records ordered by relevance. Each hit carries a
\`corroborationCount\` — the number of distinct sessions across the full
history that asserted the same (subject, predicate, value). Highly
corroborated facts are boosted in scoring (log-scale, capped) so an
"uses DuckDB" asserted across 10 sessions outranks a one-off mention.
Superseded facts are excluded by default; call get_fact_history to walk
the chain of how a value evolved ("when did X flip from Fastify to Hono?").

Examples:
  recall_facts(subject="local-llm-host", predicate="model")
    → the model alias currently exposed on the local LLM endpoint
  recall_facts(subject="nlm-memory-ts", predicate="framework")
    → the web framework picked for nlm-memory-ts
  recall_facts(subject="acme-client")
    → all known facts about the Acme engagement
  recall_facts(query="routing", kind="decision")
    → recent decision-kind facts mentioning routing

Args:
  - query: free-text search against fact values. Optional if subject /
           predicate / kind is set.
  - subject: exact-match normalized (lowercase-kebab) entity or topic name.
  - predicate: exact-match predicate from the closed vocabulary (framework,
               endpoint, model, port, host, owner, pricing, cost, deadline,
               status, stack, runtime, library, version, dependency, schema,
               integration, deployment, repo, branch, commit, description,
               decided-on, assumption, blocker).
  - kind: "decision" | "open" | "attribute". Optional.
  - mode: "hybrid" (default — keyword BM25 + semantic embeddings), "keyword",
          or "semantic".
  - includeSuperseded: true to include outdated facts. Default false.
  - minConfidence: lower bound on classifier confidence. Default 0.6.
  - limit: max results (1-100, default 10).`;

const GET_FACT_HISTORY_DESCRIPTION = `Walk the supersedence chain for a (subject, predicate) pair to see how a value
changed over time. Call this when the user asks about evolution, history of a
choice, or wants to understand a prior decision that's since changed:

  "when did we switch from X to Y" · "what did we use before X"
  "wasn't X different a month ago" · "history of <X choice>"
  "why did we change from X to Y"

This is the editable-timeline feature: NLM preserves rejected/replaced decisions
as superseded entries rather than deleting them, so the reasoning trail survives.

Returns chains ordered newest → oldest. The head is the current value; subsequent
entries are predecessors, each linked forward via supersededBy.

Args:
  - subject: normalized (lowercase-kebab) entity or topic name.
  - predicate: optional — narrow to a single (subject, predicate) chain. When
               omitted, returns one chain per predicate for this subject.`;

// Minimum length for a session ID to be treated as valid.
const MIN_CITE_ID_LEN = 6;

const MARK_SUPERSEDED_DESCRIPTION = `Retroactively mark a prior session as superseded by a newer one. Use this when
the user signals that an earlier decision, plan, or finding has been replaced —
"that's outdated now," "we changed our mind," "the new plan replaces the old one,"
"that session is wrong, the one from <date> is the current answer."

NLM preserves superseded sessions (they still surface in recall with the
'superseded' status) so the reasoning trail survives. This tool only flips the
status and records the supersedence edge — it never deletes content.

Args:
  - predecessor_id: session being retired (the now-stale one).
  - successor_id:   session that replaces it (the current truth).
  - reason:         optional human-readable rationale. Logged to the
                    supersedence audit log for provenance.

Idempotent. Re-marking the same pair is a no-op. Returns the linked pair on
success; errors if either id is unknown or the two ids are equal.`;

export interface CiteSessionInput {
  readonly id: string;
  readonly conversation_id?: string | undefined;
  readonly reason?: string | undefined;
}

export interface MarkSupersededInput {
  readonly predecessor_id: string;
  readonly successor_id: string;
  readonly reason?: string | undefined;
}

export async function markSupersededHandler(
  deps: McpDeps,
  tenantId: string,
  input: MarkSupersededInput,
): Promise<ToolResult> {
  if (!input.predecessor_id || !input.successor_id) {
    return err(new Error("predecessor_id and successor_id are required"));
  }
  try {
    await deps.store.markSuperseded(tenantId, input.predecessor_id, input.successor_id);
    void appendSupersedence(tenantId, {
      predecessorId: input.predecessor_id,
      successorId: input.successor_id,
      source: "mcp",
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return ok({
      marked: true,
      predecessor_id: input.predecessor_id,
      successor_id: input.successor_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  } catch (e) {
    return err(e);
  }
}

const SUPERSEDE_FACT_DESCRIPTION = `Retroactively mark a specific NLM fact as superseded when the operator states
that a previously-stored decision or attribute no longer holds.

Use this when the user says things like "that's wrong now," "we changed the
framework to X," "that decision is stale," or corrects a specific fact that
recall_facts returned. Pass the fact id returned by recall_facts.

Unlike mark_superseded (session-level), this targets a single (subject,
predicate, value) row. The fact remains in the store for history but is
excluded from future recall_facts results (superseded_by is set to null,
meaning retired without a known successor — the replacement will be ingested
from the current conversation when it closes).

Deterministic: no LLM in the loop, immediate state change.

Args:
  - fact_id: the id field returned by recall_facts for the stale fact.
  - reason:  optional human-readable rationale. Logged for provenance.

Idempotent: calling it twice on the same id is a no-op. Errors if fact_id
is unknown.`;

export interface SupersedeFactInput {
  readonly fact_id: string;
  readonly reason?: string | undefined;
}

export async function supersedeFactHandler(
  deps: McpDeps,
  tenantId: string,
  input: SupersedeFactInput,
): Promise<ToolResult> {
  if (!input.fact_id || input.fact_id.length < 4) {
    return err(new Error("fact_id is required"));
  }
  if (!deps.factStore) {
    return err(new Error("fact store not available"));
  }
  try {
    await deps.factStore.retire(tenantId, input.fact_id);
    void appendFactSupersedence(tenantId, {
      factId: input.fact_id,
      source: "mcp",
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return ok({
      marked: true,
      fact_id: input.fact_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  } catch (e) {
    return err(e);
  }
}

export async function citeSessionHandler(
  tenantId: string,
  input: CiteSessionInput,
  requestContext?: McpDeps["requestContext"],
): Promise<ToolResult> {
  if (!input.id || input.id.length < MIN_CITE_ID_LEN) {
    return err(new Error(`id must be at least ${MIN_CITE_ID_LEN} characters`));
  }
  try {
    const conversationId =
      input.conversation_id ??
      (requestContext?.tenantId === tenantId ? requestContext.conversationId : undefined) ??
      resolveConversationForSession(tenantId, input.id) ??
      "mcp_tool";
    const logged = await appendCitation(tenantId, {
      conversationId,
      citedId: input.id,
      kind: "tool_use",
      ...(input.reason !== undefined ? { responsePreview: input.reason } : {}),
    });
    // An unattributable citation is dropped by the write path; reporting it as
    // logged would make a dead telemetry path look healthy.
    return ok({ logged, id: input.id, ...(logged ? {} : { reason: "unattributable_conversation" }) });
  } catch (e) {
    return err(e);
  }
}

const REPORT_OUTCOME_DESCRIPTION = `Record whether a session's decision held up or was overturned. THIS IS THE CONTRACT SURFACE for outcome signals: it writes the same append-only \`signals\` row that POST /api/signal writes (producer "mcp"), just over MCP instead of HTTP.

Expected callers are deterministic producers: hooks, CI pipelines, and automation platforms confirming a build/deploy/test result against a prior session. Agents rarely self-report their own outcome; outcome should come from independent evidence, not the agent's opinion of its own work.

Args:
  - session_id or correlation_key: at least one required. session_id is the NLM session this outcome applies to. correlation_key is an external identifier (e.g. a CI run id) to use when no NLM session_id is known; it is recorded on the row for traceability but is not (yet) joined into the Tier-B outcome rollup.
  - outcome: one of pass | fail | fix | exhausted, the same vocabulary POST /api/signal accepts.
  - source_of_record: required. Identifies the deterministic system asserting this outcome (e.g. "ci:github-actions", "hook:post-tool-use", "n8n:deploy-workflow").
  - detail: optional passthrough object for additional context.`;

/** The kind stamped on rows this tool writes. Loosely, this row represents an
 *  outcome *review* of a prior session's decision, and "review" is the closest
 *  fit among the existing SignalKind vocabulary (gate|eval|review|test); no
 *  literal "outcome" kind exists (see rollup.ts's own note on this same
 *  ambiguity). Tier-A correlation in rollup.ts keys on session_id only, so
 *  this choice does not affect verdict derivation. */
const REPORT_OUTCOME_KIND = "review" as const;

export interface ReportOutcomeInput {
  readonly session_id?: string | undefined;
  readonly correlation_key?: string | undefined;
  readonly outcome: string;
  readonly source_of_record: string;
  readonly detail?: Record<string, unknown> | undefined;
}

export async function reportOutcomeHandler(
  deps: McpDeps,
  tenantId: string,
  input: ReportOutcomeInput,
): Promise<ToolResult> {
  if (!input.session_id && !input.correlation_key) {
    return err(new Error("session_id or correlation_key is required"));
  }
  if (!input.source_of_record || input.source_of_record.length === 0) {
    return err(new Error("source_of_record is required"));
  }
  if (!deps.signalStore || deps.installScope === undefined) {
    return err(new Error("signal store not available"));
  }
  try {
    let signal = normalizeSignal(
      {
        kind: REPORT_OUTCOME_KIND,
        producer: "mcp",
        outcome: input.outcome,
        session: input.session_id ?? null,
        detail: {
          ...(input.detail ?? {}),
          source_of_record: input.source_of_record,
          ...(input.correlation_key ? { correlation_key: input.correlation_key } : {}),
        },
      },
      deps.installScope,
    );
    signal = await stampSignalScope(signal, tenantId, { sessionScopeReader: deps.sessionScopeReader });
    await deps.signalStore.insert(tenantId, signal);
    return ok({ recorded: true, id: signal.id, outcome: signal.outcome });
  } catch (e) {
    return err(e);
  }
}

export async function listMergeSuggestionsHandler(
  deps: McpDeps,
  tenantId: string,
  input: { minScore: number | undefined },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("list_merge_suggestions is not available in this deployment.");
  try {
    const minScore = typeof input.minScore === "number" ? input.minScore : 0.5;
    const all = (await deps.workstreams.store.listAll(tenantId)).filter((w) => w.status === "active");
    if (all.length < 2) return okText("Not enough active workstreams to suggest merges.");
    const ids = all.map((w) => w.id);
    const entMap = await deps.workstreams.store.entitiesFor(tenantId, ids);
    const items = await Promise.all(
      all.map(async (w) => ({
        id: w.id, label: w.label,
        entities: entMap.get(w.id) ?? [],
        sessionIds: await deps.workstreams!.sessions.listSessionIdsByWorkstreams(tenantId, [w.id]),
      })),
    );
    const suggestions = suggestMerges(items, minScore);
    if (suggestions.length === 0) return okText(`No merge suggestions at or above score ${minScore}.`);
    const lines = ["MERGE SUGGESTIONS:"];
    for (const s of suggestions) {
      lines.push(`  - ${(s.score).toFixed(2)}  "${s.aLabel}" (${s.aId}) ~ "${s.bLabel}" (${s.bId})  [entities ${s.sharedEntities}, sessions ${s.sharedSessions}, label ${(s.labelSimilarity).toFixed(2)}]`);
    }
    lines.push("", "Merge a pair with: merge_workstreams(from, into).");
    return okText(lines.join("\n"));
  } catch (e) {
    return err(e);
  }
}

const LEARNER_ENROLL_DESCRIPTION = `\
Enroll a learner in a course, binding the enrollment to a workstream so later
sessions resolve their learning state at recall time. The course plan itself
stays with the caller — NLM stores only its reference, revision, and
fingerprint, and refuses writes when a re-enrolled plan differs.`;

const LEARNER_RECORD_DESCRIPTION = `\
Record a learning event: concepts covered plus per-concept attempts (task,
response, result/help/kind), an interpretation, and the next step. Identical
event ids are safe no-ops; conflicting ids fail rather than rewriting
history. A submitted exercise is not evidence until recorded here.`;

const LEARNER_SUMMARY_DESCRIPTION = `\
Summarize what a learner has demonstrably learned in a course: per-concept
status (exposed/practicing/demonstrated/retained), the latest next step, and
sessions bound to the enrollment's workstream since the last recorded event
(unrecorded candidates — record them with learner_record, don't assume).`;

const LEARNER_COMPLETE_DESCRIPTION = `\
Mark a learner's course completed. Preserves completion history and actual
evidence; untaught or untested topics stay explicitly marked.`;

export interface LearnerEnrollToolInput {
  learner: string;
  label?: string;
  course: string;
  workstream: string;
  plan_ref: string;
  plan_revision: number;
  plan_fingerprint: string;
}

export interface LearnerRecordAttemptInput {
  concept: string;
  task: string;
  response: string;
  result: "correct" | "partial" | "incorrect";
  help: "none" | "hint" | "worked-example";
  kind: "application" | "retrieval" | "transfer";
}

export interface LearnerRecordEventInput {
  id: string;
  date: string;
  covered: string[];
  attempts: LearnerRecordAttemptInput[];
  interpretation: string;
  next_step: string;
}

export interface LearnerRecordToolInput {
  learner: string;
  course: string;
  event: LearnerRecordEventInput;
}

export interface LearnerSummaryToolInput {
  learner: string;
  course?: string;
  limit?: number;
}

export interface LearnerCompleteToolInput {
  learner: string;
  course: string;
}

const LEARNER_SUMMARY_DEFAULT_LIMIT = 50;
const LEARNER_UNRECORDED_CAP = 10;

export async function learnerEnrollHandler(
  deps: McpDeps,
  tenantId: string,
  input: LearnerEnrollToolInput,
): Promise<ToolResult> {
  if (!deps.learners) return okText("learner tools are not available in this deployment.");
  try {
    const enrollment = await enrollCourse(
      { learners: deps.learners.store, workstreams: deps.learners.workstreams },
      tenantId,
      {
        learnerId: input.learner,
        ...(input.label !== undefined ? { learnerLabel: input.label } : {}),
        courseId: input.course,
        workstream: input.workstream,
        planRef: input.plan_ref,
        planRevision: input.plan_revision,
        planFingerprint: input.plan_fingerprint,
      },
    );
    return okText(
      `Enrolled ${input.learner} in ${input.course} (${enrollment.status}, plan rev ${enrollment.planRevision}).`,
    );
  } catch (e) {
    return err(e);
  }
}

export async function learnerRecordHandler(
  deps: McpDeps,
  tenantId: string,
  input: LearnerRecordToolInput,
): Promise<ToolResult> {
  if (!deps.learners) return okText("learner tools are not available in this deployment.");
  try {
    const result = await recordLearningEvent(
      { learners: deps.learners.store, workstreams: deps.learners.workstreams },
      tenantId, input.learner, input.course, {
      id: input.event.id,
      date: input.event.date,
      covered: input.event.covered,
      attempts: input.event.attempts,
      interpretation: input.event.interpretation,
      nextStep: input.event.next_step,
    });
    return result === "inserted"
      ? okText(`Recorded event ${input.event.id} for ${input.learner}/${input.course}.`)
      : okText(`Event ${input.event.id} already recorded (identical) — no change.`);
  } catch (e) {
    return err(e);
  }
}

export async function learnerSummaryHandler(
  deps: McpDeps,
  tenantId: string,
  input: LearnerSummaryToolInput,
): Promise<ToolResult> {
  if (!deps.learners) return okText("learner tools are not available in this deployment.");
  try {
    let course = input.course?.trim() ? input.course.trim() : undefined;
    if (!course) {
      const enrollments = await deps.learners.store.listEnrollments(tenantId, input.learner);
      const active = enrollments.filter((e) => e.status === "active");
      if (active.length === 0) return okText(`No active enrollments for learner ${input.learner}.`);
      if (active.length > 1) {
        return okText(
          `Multiple active courses for ${input.learner}; specify course: ${active.map((e) => e.courseId).join(", ")}.`,
        );
      }
      course = active[0]!.courseId;
    }
    const summary = await getCourseSummary(
      { learners: deps.learners.store, workstreams: deps.learners.workstreams },
      tenantId,
      input.learner,
      course,
    );
    if (!summary) return okText(`No enrollment for learner ${input.learner} in course ${course}.`);

    const lines: string[] = [];
    lines.push(
      `LEARNER ${summary.learnerId} · ${summary.courseId} (${summary.status}, rev ${summary.planRevision}, ${summary.eventCount} events)`,
    );
    const limit = input.limit ?? LEARNER_SUMMARY_DEFAULT_LIMIT;
    const concepts = summary.concepts.slice(0, Math.max(0, limit));
    if (concepts.length === 0) {
      lines.push("(no concepts recorded yet)");
    } else {
      lines.push("CONCEPTS:");
      for (const c of concepts) {
        const n = c.attemptCount === 1 ? "1 attempt" : `${c.attemptCount} attempts`;
        lines.push(`  - [${c.status}] ${c.concept} (${n})`);
      }
      if (summary.concepts.length > concepts.length) {
        lines.push(`  (+${summary.concepts.length - concepts.length} more — raise limit)`);
      }
    }
    lines.push(`Next: ${summary.nextStep ? truncateSummary(summary.nextStep) : "(none recorded)"}`);

    if (summary.workstreamId) {
      const ids = await deps.learners.sessions.listSessionIdsByWorkstreams(tenantId, [summary.workstreamId]);
      if (ids.length > 0) {
        const sessions = await deps.learners.sessions.getByIds(tenantId, ids);
        const cutoff = summary.lastEventDate ?? "";
        const unrecorded = sessions
          .filter((s) => s.startedAt.slice(0, 10) > cutoff)
          .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
          .slice(0, LEARNER_UNRECORDED_CAP);
        if (unrecorded.length > 0) {
          lines.push(`Unrecorded sessions (${unrecorded.length}):`);
          for (const s of unrecorded) {
            lines.push(`  - ${s.id} · ${truncateSummary(s.label, 80)} (${s.startedAt.slice(0, 10)})`);
          }
        }
      }
    }
    return okText(lines.join("\n"));
  } catch (e) {
    return err(e);
  }
}

export async function learnerCompleteHandler(
  deps: McpDeps,
  tenantId: string,
  input: LearnerCompleteToolInput,
): Promise<ToolResult> {
  if (!deps.learners) return okText("learner tools are not available in this deployment.");
  try {
    await completeLearnerCourse(
      { learners: deps.learners.store, workstreams: deps.learners.workstreams },
      tenantId,
      input.learner,
      input.course,
    );
    return okText(`Marked ${input.course} completed for ${input.learner}.`);
  } catch (e) {
    return err(e);
  }
}

/**
 * The composition root for the MCP surface (program spec §4.6 "M2 threading
 * semantics until M3"): `tenantId` is required here, not defaulted, and
 * every tool handler below receives it explicitly rather than reading a
 * module-level constant. The stdio caller (src/cli/nlm.ts) is local-mode
 * only and always passes DEFAULT_TEAM_ID; the HTTP /mcp mount
 * (src/http/app.ts) passes the token-resolved team (M3).
 */
export function createMcpServer(deps: McpDeps, tenantId: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "recall_sessions",
    {
      title: "Recall Sessions from NLM",
      description: RECALL_DESCRIPTION,
      inputSchema: sessionRecallInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      recallSessionsHandler(
        deps,
        tenantId,
        args,
        mcpRuntimeFromClient(server.server.getClientVersion()),
      ) as never,
  );

  server.registerTool(
    "recall_context",
    {
      title: "Recall Structured NLM Context",
      description: `Preferred first call for memory questions. Returns current structured facts,
source quotes, relevant decisions/open questions and original transcript passages
within maxChars (default 8000 characters, not tokens). timeoutMs defaults to 1500
(range 100–5000); coverage labels incomplete lanes and preserves completed evidence.
Evidence has source IDs
and get_session expansion arguments. Use subject+predicate for exact structured
lookups, intent=decision for rationale, state for continuity, history to include
superseded sessions. Conflicting values are preserved, never silently resolved.
Defaults to hybrid facts and keyword sessions, preserving each lane's measured
ranking policy. Set mode to override both. No query-time generative model calls;
hybrid uses the embedder. Keyword works
offline. General search multipleValues describes retrieved candidates. Exact lookup
reports lookup.complete and the full eligible distinctValueCount; incomplete probes
never establish uniqueness. lookup.omittedAlternatives counts values absent from
returned facts; lookup.expand carries scoped get_fact_history arguments.
Use recall_facts/get_fact_history for deeper fact history; get_session with query
for more source context, or view=transcript with offset for original text.`,
      inputSchema: contextInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => recallContextHandler({ ...deps, requestContext: {
      tenantId, signal: extra.signal,
      ...(trustedConversationId(deps, tenantId) ? { conversationId: trustedConversationId(deps, tenantId)! } : {}),
    } }, tenantId, args, mcpRuntimeFromClient(server.server.getClientVersion())) as never,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get NLM Session Evidence",
      description: GET_SESSION_DESCRIPTION,
      inputSchema: sessionInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => getSessionHandler(deps, tenantId, args) as never,
  );

  if (deps.factRecall && deps.factStore) {
    server.registerTool(
      "recall_facts",
      {
        title: "Recall Facts from NLM",
        description: RECALL_FACTS_DESCRIPTION,
        inputSchema: {
          query: z
            .string()
            .default("")
            .describe("Free-text search against fact values. Optional if subject/predicate/kind set."),
          workstream: z.string().min(1).max(500).optional(),
          property: propertySlug.optional(),
          subject: z
            .string()
            .optional()
            .describe("Exact-match normalized entity/topic (lowercase-kebab)."),
          predicate: z
            .string()
            .optional()
            .describe("Exact-match predicate from the closed vocabulary."),
          kind: z
            .enum(["decision", "open", "attribute"])
            .optional()
            .describe("Filter to a single fact kind."),
          mode: z
            .enum(["keyword", "semantic", "hybrid"])
            .optional()
            .describe("Search mode. Defaults to hybrid (keyword BM25 + semantic embeddings)."),
          includeSuperseded: z
            .boolean()
            .optional()
            .describe("Include outdated facts. Default false."),
          minConfidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe("Lower bound on classifier confidence. Default 0.6."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(DEFAULT_LIMIT)
            .describe("Max results to return."),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) =>
        recallFactsHandler(
          deps,
          tenantId,
          args,
          mcpRuntimeFromClient(server.server.getClientVersion()),
        ) as never,
    );

    server.registerTool(
      "get_fact_history",
      {
        title: "Get Fact Supersedence History",
        description: GET_FACT_HISTORY_DESCRIPTION,
        inputSchema: {
          subject: z.string().min(1).describe("Normalized entity/topic name."),
          workstream: z.string().min(1).max(500).optional(),
          property: propertySlug.optional(),
          predicate: z
            .string()
            .optional()
            .describe("Narrow to one (subject, predicate) chain."),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => getFactHistoryHandler(deps, tenantId, args) as never,
    );

    server.registerTool(
      "supersede_fact",
      {
        title: "Supersede a Stale NLM Fact",
        description: SUPERSEDE_FACT_DESCRIPTION,
        inputSchema: {
          fact_id: z
            .string()
            .min(4)
            .describe("Fact ID returned by recall_facts for the stale fact."),
          reason: z
            .string()
            .optional()
            .describe("Why this fact is being retired. Optional but encouraged for audit trail."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => supersedeFactHandler(deps, tenantId, args) as never,
    );
  }

  server.registerTool(
    "cite_session",
    {
      title: "Cite NLM Session",
      description: CITE_SESSION_DESCRIPTION,
      inputSchema: {
        id: z.string().min(MIN_CITE_ID_LEN).describe("Session ID returned by recall_sessions that you referenced in your response."),
        conversation_id: z
          .string()
          .optional()
          .describe("Current conversation ID. Optional — NLM infers from context when absent."),
        reason: z
          .string()
          .optional()
          .describe("Why this session was useful. Optional but encouraged; the reason is recorded with the citation for later review."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => citeSessionHandler(tenantId, args, deps.requestContext) as never,
  );

  if (deps.signalStore && deps.installScope !== undefined) {
    server.registerTool(
      "report_outcome",
      {
        title: "Report Session Outcome",
        description: REPORT_OUTCOME_DESCRIPTION,
        inputSchema: {
          session_id: z
            .string()
            .optional()
            .describe("NLM session ID this outcome applies to. Required if correlation_key is omitted."),
          correlation_key: z
            .string()
            .optional()
            .describe("External correlation identifier (e.g. a CI run id) when no NLM session_id is known. Required if session_id is omitted."),
          outcome: z
            .enum(SIGNAL_OUTCOMES)
            .describe("pass = held. fail | fix | exhausted = overturned."),
          source_of_record: z
            .string()
            .min(1)
            .describe("The deterministic system asserting this outcome (e.g. \"ci:github-actions\", \"hook:post-tool-use\")."),
          detail: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional passthrough context, stored on the signal row."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => reportOutcomeHandler(deps, tenantId, args) as never,
    );
  }

  server.registerTool(
    "mark_superseded",
    {
      title: "Mark NLM Session Superseded",
      description: MARK_SUPERSEDED_DESCRIPTION,
      inputSchema: {
        predecessor_id: z
          .string()
          .min(MIN_CITE_ID_LEN)
          .describe("Session ID of the prior session being retired."),
        successor_id: z
          .string()
          .min(MIN_CITE_ID_LEN)
          .describe("Session ID of the newer session that replaces it."),
        reason: z
          .string()
          .optional()
          .describe("Why this supersedence is being recorded. Optional but encouraged for audit trail."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => markSupersededHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "work_summary",
    {
      title: "Daily work summary",
      description:
        "The operator's agent-assisted work recap for a day: where attention went (active time by topic), focus quality (context switches, longest block), and progress (decisions, open loops). Optional `date` (YYYY-MM-DD); defaults to today.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Day to summarize, YYYY-MM-DD. Defaults to today."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => workSummaryHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "recall_workstream",
    {
      title: "Recall a workstream's accumulated context",
      description:
        "Return the coherent project view for a workstream: its member sessions, current decisions and open loops, accumulated facts, and code exemplars. Accepts a workstream id or label; merge chains resolve to the live workstream.",
      inputSchema: {
        idOrLabel: z.string().describe("Workstream id (ws_...) or label (e.g. 'NLM')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => recallWorkstreamHandler(deps, tenantId, args, mcpRuntimeFromClient(server.server.getClientVersion())) as never,
  );

  server.registerTool(
    "rebind_session",
    {
      title: "Rebind a session to a different workstream",
      description:
        "Move a session's primary workstream binding (operator correction). Sets binding_source=operator. The session's facts and exemplars roll up under the new workstream automatically (rollup is by session binding).",
      inputSchema: {
        sessionId: z.string().describe("Session id to rebind."),
        workstream: z.string().describe("Target workstream id (ws_...) or label."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => rebindSessionHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "merge_workstreams",
    {
      title: "Merge one workstream into another",
      description:
        "Supersede a duplicate workstream into the one to keep: sets merged_into, marks it merged, and unions its entity index. Sessions, facts, and exemplars resolve to the survivor automatically (no session rewrite). Accepts ids or labels; merge chains resolve.",
      inputSchema: {
        from: z.string().describe("Workstream to retire (the duplicate); id or label."),
        into: z.string().describe("Workstream to keep (the survivor); id or label."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => mergeWorkstreamsHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "rename_workstream",
    {
      title: "Rename a workstream",
      description:
        "Relabel a workstream. Refuses a label that collides with a different existing workstream's normalized label (prevents accidental duplicates). Accepts id or label.",
      inputSchema: {
        idOrLabel: z.string().describe("Workstream id or current label."),
        label: z.string().describe("New label."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => renameWorkstreamHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "retire_workstream",
    {
      title: "Retire a workstream",
      description:
        "Mark a workstream retired (status=retired). Operator cleanup for dead one-off workstreams. Reversible by re-setting status. Accepts id or label.",
      inputSchema: { idOrLabel: z.string().describe("Workstream id or label.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => retireWorkstreamHandler(deps, tenantId, args) as never,
  );

  server.registerTool(
    "list_merge_suggestions",
    {
      title: "Suggest duplicate workstreams to merge",
      description:
        "Score active workstream pairs by shared entities, co-occurring sessions, and label similarity; list likely duplicates for one-click merge_workstreams. Computed on demand; read-only.",
      inputSchema: { minScore: z.number().optional().describe("Minimum similarity score 0..1 (default 0.5).") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => listMergeSuggestionsHandler(deps, tenantId, args) as never,
  );

  if (
    deps.exemplarStore &&
    deps.installScope &&
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1"
  ) {
    const exemplarStore = deps.exemplarStore;
    const runtime = mcpRuntimeFromClient(server.server.getClientVersion());
    server.registerTool(
      "recall_code",
      {
        title: "Recall Code Exemplars",
        description: RECALL_CODE_DESCRIPTION,
        inputSchema: {
          query: z
            .string()
            .min(1)
            .describe("Natural-language description of the task you are about to implement."),
          repo: z
            .string()
            .optional()
            .describe("Narrow to one repository path."),
          lang: z
            .string()
            .optional()
            .describe("Filter by language (ts, py, go, etc.)."),
          k: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results to return (default 5)."),
          include_negatives: z
            .boolean()
            .optional()
            .describe("Include fail/exhausted exemplars as labeled cautionary examples (default true)."),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => recallCodeHandler(deps, tenantId, args, runtime) as never,
    );

    server.registerTool(
      "supersede_exemplar",
      {
        title: "Supersede a Code Exemplar",
        description: "Retire (exclude from recall) or relabel the outcome of a code exemplar returned by recall_code. Records the change as a human verdict, which an automated pass will not override.",
        inputSchema: {
          exemplar_id: z.string().min(4).describe("Exemplar id from recall_code."),
          retire: z.boolean().optional().describe("true to exclude from recall, false to restore."),
          outcome: z.enum(["pass", "fail", "fix", "exhausted"]).optional().describe("Relabel the exemplar's outcome."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const a = args as { exemplar_id: string; retire?: boolean; outcome?: "pass" | "fail" | "fix" | "exhausted" };
        const patch: { retired?: boolean; outcome?: "pass" | "fail" | "fix" | "exhausted" } = {};
        if (a.retire !== undefined) patch.retired = a.retire;
        if (a.outcome !== undefined) patch.outcome = a.outcome;
        if (patch.retired === undefined && patch.outcome === undefined) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "provide retire and/or outcome" }) }] } as never;
        }
        const res = await exemplarStore.setVerdict(tenantId, a.exemplar_id, patch, "human");
        return { content: [{ type: "text", text: JSON.stringify({ exemplar_id: a.exemplar_id, status: res.status }) }] } as never;
      },
    );
  }

  if (deps.learners) {
    server.registerTool(
      "learner_enroll",
      {
        title: "Enroll Learner in Course",
        description: LEARNER_ENROLL_DESCRIPTION,
        inputSchema: {
          learner: z.string().min(1).describe("Learner id (lowercase slug). Auto-created on first enroll."),
          label: z.string().optional().describe("Display label for a new learner; defaults to the id."),
          course: z.string().min(1).describe("Course id (lowercase slug)."),
          workstream: z.string().min(1).describe("Workstream id or label to bind the enrollment to."),
          plan_ref: z.string().min(1).describe("Caller-side course plan reference (NLM stores the ref, not the plan)."),
          plan_revision: z.number().int().min(1).describe("Plan revision; a changed plan must bump, never silently upsert."),
          plan_fingerprint: z.string().min(1).describe("Plan content fingerprint; mismatch blocks writes until reconciled."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => learnerEnrollHandler(deps, tenantId, args as never) as never,
    );

    server.registerTool(
      "learner_record",
      {
        title: "Record Learning Event",
        description: LEARNER_RECORD_DESCRIPTION,
        inputSchema: {
          learner: z.string().min(1).describe("Learner id."),
          course: z.string().min(1).describe("Course id."),
          event: z.object({
            id: z.string().min(1).describe("Event id (lowercase slug, unique per enrollment)."),
            date: z.string().describe("ISO date YYYY-MM-DD, never in the future."),
            covered: z.array(z.string()).describe("Concept ids covered (subject.concept)."),
            attempts: z.array(z.object({
              concept: z.string().describe("Concept id attempted."),
              task: z.string().min(1).describe("The task given."),
              response: z.string().min(1).describe("Short excerpt of the learner's response."),
              result: z.enum(["correct", "partial", "incorrect"]),
              help: z.enum(["none", "hint", "worked-example"]),
              kind: z.enum(["application", "retrieval", "transfer"]),
            })).describe("Per-concept attempts (may be empty for an untested lesson)."),
            interpretation: z.string().describe("Tentative explanation of the evidence (may be empty)."),
            next_step: z.string().min(1).describe("What the next teacher should try or ask."),
          }).describe("The learning event to record."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => learnerRecordHandler(deps, tenantId, args as never) as never,
    );

    server.registerTool(
      "learner_summary",
      {
        title: "Summarize Learner Progress",
        description: LEARNER_SUMMARY_DESCRIPTION,
        inputSchema: {
          learner: z.string().min(1).describe("Learner id."),
          course: z.string().optional().describe("Course id. Omit only when exactly one active enrollment exists."),
          limit: z.number().int().min(1).max(200).optional().describe("Max concepts to list (default 50)."),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => learnerSummaryHandler(deps, tenantId, args as never) as never,
    );

    server.registerTool(
      "learner_complete_course",
      {
        title: "Complete Learner Course",
        description: LEARNER_COMPLETE_DESCRIPTION,
        inputSchema: {
          learner: z.string().min(1).describe("Learner id."),
          course: z.string().min(1).describe("Course id."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => learnerCompleteHandler(deps, tenantId, args as never) as never,
    );
  }

  return server;
}

const RECALL_CODE_DESCRIPTION = `\
Retrieve code exemplars — concrete chunks of code from past sessions with \
deterministic outcome labels (pass/fail/fix/exhausted). Use when you are \
about to implement something and want to see what code passed or failed the \
gate for a similar task in this repository.

Returns two lists:
- **positives**: code that passed or was fixed to a passing state
- **negatives**: code that failed or was exhausted (labeled "avoid")

Outcome labels come from git-survival and test exit codes, not LLM judgment. \
Model-agnostic: exemplars from any agent or model vendor are included. \
Scoped to your install by default; narrow by repo or lang as needed.`;

