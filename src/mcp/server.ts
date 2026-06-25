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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encode as toonEncode } from "@toon-format/toon";
import { z } from "zod";
import { logQuery } from "@core/recall/query-log.js";
import { logFactQuery } from "@core/recall-facts/fact-query-log.js";
import { appendCitation } from "@core/recall/citation-log.js";
import { resolveConversationForSession } from "@core/hook/memo.js";
import { appendFactSupersedence, appendSupersedence, readSupersedenceLog } from "@core/storage/supersedence-log.js";
import type { FactRecallService } from "@core/recall-facts/fact-recall-service.js";
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
import type {
  FactKind,
  FactRecallQuery,
  RecallKindFilter,
  RecallMode,
  RecallQuery,
} from "@shared/types.js";

const CHARACTER_LIMIT = 25_000;
const DEFAULT_LIMIT = 10;
const SERVER_NAME = "nlm-memory-mcp-server";
const SERVER_VERSION = "0.5.9";

/** TOON encoding cuts token usage on large recall payloads. Opt in via
 *  NLM_FORMAT=toon in the MCP server's env (see .mcp.json). Defaults to JSON. */
const USE_TOON = process.env.NLM_FORMAT === "toon";

export interface McpDeps {
  readonly recall: RecallService;
  readonly store: SessionStore;
  /** Optional — when absent, fact tools are not registered. */
  readonly factRecall?: FactRecallService;
  readonly factStore?: FactStore;
  /** Optional — when present, recall_code tool is registered. */
  readonly exemplarStore?: import("@ports/code-exemplar-store.js").CodeExemplarStore;
  /** Optional code embedder for recall_code semantic search. */
  readonly codeEmbedder?: import("@ports/code-embedder.js").CodeEmbedder;
  readonly installScope?: string;
  /** Wire to enable the work_summary tool (operator daily work digest). */
  readonly workDigest?: BuildWorkDigestDeps;
  /** Wire to enable recall_workstream. Mirrors RollupDeps + the store for idOrLabel resolution. */
  readonly workstreams?: {
    readonly store: import("@ports/workstream-store.js").WorkstreamStore;
    readonly sessions: Pick<SessionStore, "listSessionIdsByWorkstreams">;
    readonly facts: Pick<FactStore, "listBySessions">;
    readonly exemplars: Pick<import("@ports/code-exemplar-store.js").CodeExemplarStore, "listBySessions">;
  };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function format(data: unknown): string {
  if (USE_TOON) {
    try {
      return toonEncode(data);
    } catch {
      return JSON.stringify(data, null, 2);
    }
  }
  return JSON.stringify(data, null, 2);
}

function truncate(data: unknown): string {
  const str = format(data);
  if (str.length <= CHARACTER_LIMIT) return str;
  return format({
    truncated: true,
    truncation_message:
      "Response too large. Lower limit or fetch fewer fields via get_session.",
  });
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

export interface RecallToolInput {
  query: string | undefined;
  entity: string | undefined;
  kind: RecallKindFilter | undefined;
  mode: RecallMode | undefined;
  limit: number | undefined;
  rewrite: boolean | undefined;
  workstream: string | undefined;
}

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
  input: Partial<RecallToolInput>,
  runtime: string | null = null,
): Promise<ToolResult> {
  try {
    const rewrite = input.rewrite ?? mcpRewriteDefault();
    const query: RecallQuery = {
      query: input.query ?? "",
      mode: input.mode ?? "keyword",
      limit: input.limit ?? DEFAULT_LIMIT,
      rewrite,
      // Investigative surface: include superseded sessions, down-ranked and
      // badged with their successor in `supersededBy`, so an agent chasing a
      // decision sees the overturned reasoning rather than a silent gap. Task #303.
      includeSuperseded: true,
      ...(input.entity !== undefined ? { entity: input.entity } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
    };
    const result = await deps.recall.search(query);
    // Telemetry — the MCP path is the real agent-usage path; without this it
    // is invisible to query_log.jsonl and the Recall page. Fire-and-forget,
    // mirrors the HTTP /api/recall handler.
    void logQuery({
      source: "mcp",
      runtime,
      query: input.query ?? null,
      entity: input.entity ?? null,
      kind: input.kind ?? null,
      mode: input.mode ?? "keyword",
      limit: input.limit ?? DEFAULT_LIMIT,
      nResults: result.total,
      returnedIds: result.results.map((r) => r.id),
    });
    return ok(result);
  } catch (e) {
    return err(e);
  }
}

export async function workSummaryHandler(
  deps: McpDeps,
  input: { date?: string | undefined },
): Promise<ToolResult> {
  if (!deps.workDigest) {
    return okText("work_summary is not available in this deployment.");
  }
  try {
    const date = input.date ?? localToday();
    const digest = await buildWorkDigest(deps.workDigest, date);
    return okText(composeWorkDigest(digest));
  } catch (e) {
    return err(e);
  }
}

export async function recallWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("recall_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const ws = deps.workstreams.store;
    const found =
      (await ws.getById(idOrLabel)) ?? (await ws.findByNormalizedLabel(normalizeLabel(idOrLabel)));
    if (!found) return okText(`No workstream matches "${idOrLabel}".`);
    const view = await rollupWorkstream(
      { workstreams: deps.workstreams.store, sessions: deps.workstreams.sessions, facts: deps.workstreams.facts, exemplars: deps.workstreams.exemplars },
      found.id,
    );
    if (!view) return okText(`No workstream matches "${idOrLabel}".`);
    return okText(composeWorkstreamRecall(view));
  } catch (e) {
    return err(e);
  }
}

/** idOrLabel -> live survivor workstream (merged_into resolved) | null. One source of truth for lifecycle handlers. */
async function resolveWorkstream(
  store: import("@ports/workstream-store.js").WorkstreamStore,
  idOrLabel: string,
): Promise<Workstream | null> {
  const found =
    (await store.getById(idOrLabel)) ?? (await store.findByNormalizedLabel(normalizeLabel(idOrLabel)));
  if (!found) return null;
  const all = await store.listAll();
  const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
  const survivorId = resolveWorkstreamId(found.id, byId);
  return survivorId === found.id ? found : ((await store.getById(survivorId)) ?? found);
}

export async function renameWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string; label?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rename_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    const label = (input.label ?? "").trim();
    if (!idOrLabel || !label) return okText("Provide the workstream (id or label) and the new label.");
    const ws = deps.workstreams.store;
    const target = await resolveWorkstream(ws, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    const collision = await ws.findByNormalizedLabel(normalizeLabel(label));
    if (collision && collision.id !== target.id) {
      return okText(`Label "${label}" is already used by workstream "${collision.label}" (${collision.id}).`);
    }
    await ws.setLabel(target.id, label);
    return okText(`Renamed workstream ${target.id}: "${target.label}" -> "${label}".`);
  } catch (e) {
    return err(e);
  }
}

export async function retireWorkstreamHandler(
  deps: McpDeps,
  input: { idOrLabel?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("retire_workstream is not available in this deployment.");
  try {
    const idOrLabel = (input.idOrLabel ?? "").trim();
    if (!idOrLabel) return okText("Provide a workstream id or label.");
    const target = await resolveWorkstream(deps.workstreams.store, idOrLabel);
    if (!target) return okText(`No workstream matches "${idOrLabel}".`);
    await deps.workstreams.store.setStatus(target.id, "retired");
    return okText(`Retired workstream "${target.label}" (${target.id}).`);
  } catch (e) {
    return err(e);
  }
}

export async function mergeWorkstreamsHandler(
  deps: McpDeps,
  input: { from?: string; into?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("merge_workstreams is not available in this deployment.");
  try {
    const fromArg = (input.from ?? "").trim();
    const intoArg = (input.into ?? "").trim();
    if (!fromArg || !intoArg) return okText("Provide both `from` and `into` (workstream id or label).");
    const ws = deps.workstreams.store;
    const from = await resolveWorkstream(ws, fromArg);
    const into = await resolveWorkstream(ws, intoArg);
    if (!from) return okText(`No workstream matches "${fromArg}".`);
    if (!into) return okText(`No workstream matches "${intoArg}".`);
    if (from.id === into.id) return okText(`"${fromArg}" and "${intoArg}" resolve to the same workstream — nothing to merge.`);
    await ws.merge(from.id, into.id);
    return okText(`Merged "${from.label}" (${from.id}) into "${into.label}" (${into.id}).`);
  } catch (e) {
    return err(e);
  }
}

export async function rebindSessionHandler(
  deps: McpDeps,
  input: { sessionId?: string; workstream?: string },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("rebind_session is not available in this deployment.");
  try {
    const sessionId = (input.sessionId ?? "").trim();
    const wsArg = (input.workstream ?? "").trim();
    if (!sessionId || !wsArg) return okText("Provide both a sessionId and a workstream (id or label).");
    const ws = await resolveWorkstream(deps.workstreams.store, wsArg);
    if (!ws) return okText(`No workstream matches "${wsArg}".`);
    await deps.store.setWorkstreamBinding(sessionId, ws.id, "operator", null);
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

export async function getSessionHandler(
  deps: McpDeps,
  input: { id: string },
): Promise<ToolResult> {
  try {
    const session = await deps.store.getById(input.id);
    if (!session) {
      return err(new Error(`session ${input.id} not found`));
    }

    // Enrich supersedence links with labels so AI callers get context, not just opaque IDs
    const linkedIds: string[] = [
      ...(session.supersedes ?? []),
      ...(session.supersededBy ? [session.supersededBy] : []),
    ];
    const linked =
      linkedIds.length > 0 ? await deps.store.getByIds(linkedIds) : [];
    const byId = new Map(linked.map((s) => [s.id, s]));

    // Load supersedence log once so we can join reason + recordedBy onto supersededBy
    const supersedenceLog = session.supersededBy
      ? await readSupersedenceLog()
      : [];
    const supersedenceMap = new Map(supersedenceLog.map((e) => [e.predecessorId, e]));

    const supersedes = (session.supersedes ?? []).map((id) => {
      const s = byId.get(id);
      return s ? { id, label: s.label, summary: s.summary } : { id, label: "", summary: "" };
    });
    const supersededBy = session.supersededBy
      ? (() => {
          const s = byId.get(session.supersededBy);
          const logEntry = supersedenceMap.get(session.id);
          const base = s
            ? { id: session.supersededBy, label: s.label, summary: s.summary }
            : { id: session.supersededBy, label: "", summary: "" };
          return {
            ...base,
            reason: logEntry?.reason,
            recordedBy: logEntry?.source,
          };
        })()
      : null;

    return ok({ ...session, supersedes, supersededBy });
  } catch (e) {
    return err(e);
  }
}

export interface RecallFactsInput {
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
  input: Partial<RecallFactsInput>,
  runtime: string | null = null,
): Promise<ToolResult> {
  if (!deps.factRecall) {
    return err(new Error("fact recall not wired in this deployment"));
  }
  try {
    const query: FactRecallQuery = {
      query: input.query ?? "",
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
    const result = await deps.factRecall.search(query);
    // Telemetry — see recallSessionsHandler. Fire-and-forget.
    void logFactQuery({
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
    });
    return ok(result);
  } catch (e) {
    return err(e);
  }
}

export async function getFactHistoryHandler(
  deps: McpDeps,
  input: { subject: string; predicate: string | undefined },
): Promise<ToolResult> {
  if (!deps.factStore) {
    return err(new Error("fact store not wired in this deployment"));
  }
  try {
    const chains = await deps.factStore.getHistory(input.subject, input.predicate);
    return ok({ subject: input.subject, predicate: input.predicate ?? null, chains });
  } catch (e) {
    return err(e);
  }
}

const CITE_SESSION_DESCRIPTION = `Log that you used a previously-surfaced session in your response. Pass the session ID. This lets NLM learn which surfaced sessions are actually useful, training a per-operator reranker over time. Call after writing your response, with one cite per surfaced session you actually drew from.`;

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

Returns ranked session digests (id, label, summary, entities, decisions, open
questions, status, superseded_by). Call get_session for the full body when a
digest looks relevant.

Superseded sessions ARE included here, down-ranked below active matches and
flagged with status="superseded" and a superseded_by pointer to the session
that corrected them. A superseded hit is overturned reasoning: read it for
history, but prefer the successor in superseded_by for the current state — do
NOT repeat a superseded decision as if it still holds.

Skip ONLY when the request is purely forward-looking with no plausible prior
context — drafting wholly new content, naming something new, brainstorming
greenfield ideas. When in doubt, call.

When you reference a returned session in your response, call \`cite_session(id)\` to log it so the recall layer can learn what is useful.

Args:
  - query: keyword(s) to search. Token-weighted match against label, decisions,
           open questions, and summary. Optional if entity or kind is provided.
  - entity: filter to sessions tagged with this entity. Optional.
  - kind: "decision" or "open" — restrict to sessions containing that marker
          kind. Omit for any. Optional.
  - mode: Defaults to keyword (FTS5 BM25); hybrid and semantic are available.
          Optional.
  - limit: max results (1-100, default 10).`;

const GET_SESSION_DESCRIPTION = `Fetch one full session by its canonical ID, including the conversational body.

Call this AFTER recall_sessions when a returned digest looks relevant and the
summary alone isn't enough to answer — e.g. you need the exact wording of a
decision, the full reasoning behind a pivot, the specific commands that were
run, or any quote you intend to reference verbatim.

The recall_sessions digest is optimized for ranking and scanning; the full body
contains the actual conversation transcript that produced the decision.

Args:
  - id: Canonical session ID returned by recall_sessions (e.g. "cc_abc123",
        "sess_pgvector"). Pass the id field from the recall_sessions result.`;

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
  recall_facts(subject="mac-pro-llm-host", predicate="model")
    → the model alias currently exposed on the Mac Pro LLM endpoint
  recall_facts(subject="nlm-memory-ts", predicate="framework")
    → the web framework picked for nlm-memory-ts
  recall_facts(subject="goat-home-services")
    → all known facts about the GOAT engagement
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
  input: MarkSupersededInput,
): Promise<ToolResult> {
  if (!input.predecessor_id || !input.successor_id) {
    return err(new Error("predecessor_id and successor_id are required"));
  }
  try {
    await deps.store.markSuperseded(input.predecessor_id, input.successor_id);
    void appendSupersedence({
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
  input: SupersedeFactInput,
): Promise<ToolResult> {
  if (!input.fact_id || input.fact_id.length < 4) {
    return err(new Error("fact_id is required"));
  }
  if (!deps.factStore) {
    return err(new Error("fact store not available"));
  }
  try {
    await deps.factStore.retire(input.fact_id);
    void appendFactSupersedence({
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
  input: CiteSessionInput,
): Promise<ToolResult> {
  if (!input.id || input.id.length < MIN_CITE_ID_LEN) {
    return err(new Error(`id must be at least ${MIN_CITE_ID_LEN} characters`));
  }
  try {
    await appendCitation({
      // Agents rarely pass conversation_id; resolve it server-side from the
      // surfaced-memo so the citation joins to its hook fire (NLM #345).
      conversationId: input.conversation_id ?? resolveConversationForSession(input.id) ?? "mcp_tool",
      citedId: input.id,
      kind: "tool_use",
      ...(input.reason !== undefined ? { responsePreview: input.reason } : {}),
    });
    return ok({ logged: true, id: input.id });
  } catch (e) {
    return err(e);
  }
}

export async function listMergeSuggestionsHandler(
  deps: McpDeps,
  input: { minScore: number | undefined },
): Promise<ToolResult> {
  if (!deps.workstreams) return okText("list_merge_suggestions is not available in this deployment.");
  try {
    const minScore = typeof input.minScore === "number" ? input.minScore : 0.5;
    const all = (await deps.workstreams.store.listAll()).filter((w) => w.status === "active");
    if (all.length < 2) return okText("Not enough active workstreams to suggest merges.");
    const ids = all.map((w) => w.id);
    const entMap = await deps.workstreams.store.entitiesFor(ids);
    const items = await Promise.all(
      all.map(async (w) => ({
        id: w.id, label: w.label,
        entities: entMap.get(w.id) ?? [],
        sessionIds: await deps.workstreams!.sessions.listSessionIdsByWorkstreams([w.id]),
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

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "recall_sessions",
    {
      title: "Recall Sessions from NLM",
      description: RECALL_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .default("")
          .describe("Keyword(s) to search. Optional if entity or kind is set."),
        entity: z
          .string()
          .optional()
          .describe("Filter to sessions tagged with this entity name."),
        kind: z
          .enum(["decision", "open"])
          .optional()
          .describe("Filter to sessions with a decision or open marker."),
        mode: z
          .enum(["keyword", "semantic", "hybrid"])
          .optional()
          .describe("Search mode. Defaults to keyword (FTS5 BM25); hybrid and semantic are available."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(DEFAULT_LIMIT)
          .describe("Max results to return."),
        rewrite: z
          .boolean()
          .optional()
          .describe(
            "If true, run a small LLM rewrite on the query before search — extracts entities and strips conversational filler. Set true for vague natural-language queries ('that pgvector thing'); set false for exact-token queries. Defaults to true server-side for MCP callers; the hot-path HTTP hook caller forces it off regardless.",
          ),
        workstream: z
          .string()
          .optional()
          .describe("Filter to sessions bound to this workstream (id or label; merge chains resolve)."),
      },
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
        args,
        mcpRuntimeFromClient(server.server.getClientVersion()),
      ) as never,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get Full NLM Session",
      description: GET_SESSION_DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe("Canonical session ID."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => getSessionHandler(deps, args) as never,
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
      async (args) => getFactHistoryHandler(deps, args) as never,
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
      async (args) => supersedeFactHandler(deps, args) as never,
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
          .describe("Why this session was useful. Optional but encouraged — articulating the reason is a weak training signal."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => citeSessionHandler(args) as never,
  );

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
    async (args) => markSupersededHandler(deps, args) as never,
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
    async (args) => workSummaryHandler(deps, args) as never,
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
    async (args) => recallWorkstreamHandler(deps, args) as never,
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
    async (args) => rebindSessionHandler(deps, args) as never,
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
    async (args) => mergeWorkstreamsHandler(deps, args) as never,
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
    async (args) => renameWorkstreamHandler(deps, args) as never,
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
    async (args) => retireWorkstreamHandler(deps, args) as never,
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
    async (args) => listMergeSuggestionsHandler(deps, args) as never,
  );

  if (
    deps.exemplarStore &&
    deps.installScope &&
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] === "1"
  ) {
    const exemplarStore = deps.exemplarStore;
    const codeEmbedder = deps.codeEmbedder ?? null;
    const installScope = deps.installScope;

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
      async (args) => {
        const result = await recallCode(
          {
            query: args.query,
            installScope,
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.lang ? { lang: args.lang } : {}),
            k: args.k ?? 5,
            includeNegatives: args.include_negatives ?? true,
          },
          exemplarStore,
          codeEmbedder,
          null,
        );
        return { content: [{ type: "text" as const, text: format(result) }] };
      },
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
        const res = await exemplarStore.setVerdict(a.exemplar_id, patch, "human");
        return { content: [{ type: "text", text: JSON.stringify({ exemplar_id: a.exemplar_id, status: res.status }) }] } as never;
      },
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

