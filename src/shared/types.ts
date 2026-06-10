/**
 * Shared domain types crossed by core, http, mcp, and ui layers.
 * No runtime behavior here — types only.
 */

/**
 * Session status as exposed to UI / recall consumers.
 *
 * Persisted values in `sessions.status` CHECK: 'active' | 'closed' | 'superseded'.
 * `idle` is a derived state computed from transcript mtime, returned by the
 * storage layer alongside the persisted value. `superseded` always wins over
 * mtime-derived state.
 */
export type SessionStatus = "active" | "idle" | "closed" | "superseded";

export interface Session {
  readonly id: string;
  readonly runtime: string;
  readonly runtimeSessionId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMin: number | null;
  readonly label: string;
  readonly summary: string;
  readonly status: SessionStatus;
  readonly transcriptKind: string;
  readonly transcriptPath: string | null;
  readonly body: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  /** IDs of sessions this session supersedes (newer → older). Populated by getById; absent on bulk reads. */
  readonly supersedes?: ReadonlyArray<string>;
  /** ID of the session that superseded this one, if any. Populated by getById; absent on bulk reads. */
  readonly supersededBy?: string | null;
}

export type RecallMode = "keyword" | "semantic" | "hybrid";

export type RecallKindFilter = "decision" | "open";

export interface RecallQuery {
  readonly query: string;
  readonly entity?: string;
  readonly kind?: RecallKindFilter;
  readonly mode?: RecallMode;
  readonly limit?: number;
}

export interface RecallHit {
  readonly id: string;
  readonly startedAt: string;
  readonly label: string;
  readonly summary: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly status: SessionStatus;
  readonly matchScore: number;
  readonly matchedIn: ReadonlyArray<MatchField>;
  readonly keywordScore?: number;
  readonly semanticScore?: number;
}

export type MatchField = "label" | "decisions" | "open" | "summary" | "semantic";

export interface RecallResult {
  readonly query: string;
  readonly entity: string | null;
  readonly kind: RecallKindFilter | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly total: number;
  readonly results: ReadonlyArray<RecallHit>;
  readonly modeUnavailable?: "ollama_unreachable";
}

/**
 * Fact — a single normalized claim derived from a session.
 *
 * The product treats sessions as the unit of operator recall. Facts are the
 * agent-facing projection: queryable by (subject, predicate), supersedence-
 * aware, with provenance back to the session they came from. See
 * docs/plans/factstore-design.md for the full design rationale.
 *
 * `kind` mirrors the marker taxonomy plus a third category for entity
 * attributes ("mac-pro-llm-host" + "endpoint" + "http://macpro:8080/v1").
 *
 * `subject` and `predicate` are normalized (lowercased, trimmed) at extraction
 * time so the deterministic supersedence path can do exact-match collision
 * detection without per-query normalization.
 *
 * `supersededBy` is a tombstone pointer — when a newer fact replaces this one
 * the old row stays and gets pointed at the new id. Never deleted.
 */
export type FactKind = "decision" | "open" | "attribute";

export interface Fact {
  readonly id: string;
  readonly kind: FactKind;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly sourceSessionId: string;
  readonly sourceQuote: string | null;
  readonly createdAt: string;
  readonly supersededBy: string | null;
  readonly confidence: number;
}

export type FactMatchField = "value" | "subject" | "predicate" | "semantic";

export interface FactRecallQuery {
  readonly query?: string;
  readonly subject?: string;
  readonly predicate?: string;
  readonly kind?: FactKind;
  readonly includeSuperseded?: boolean;
  readonly minConfidence?: number;
  readonly mode?: RecallMode;
  readonly limit?: number;
}

export interface FactHit extends Fact {
  readonly matchScore: number;
  readonly matchedIn: ReadonlyArray<FactMatchField>;
  readonly keywordScore?: number;
  readonly semanticScore?: number;
}

export interface FactRecallResult {
  readonly query: string;
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly kind: FactKind | null;
  readonly mode: RecallMode;
  readonly limit: number;
  readonly total: number;
  readonly results: ReadonlyArray<FactHit>;
  readonly modeUnavailable?: "ollama_unreachable";
}

export interface FactHistoryChain {
  readonly subject: string;
  readonly predicate: string;
  readonly history: ReadonlyArray<Fact>;
}

// ── Signals (agent self-improvement lane) ──────────────────────────────────
//
// A distinct store kind from facts: structured quality/eval telemetry emitted
// by harnesses (the Pi quality gate is the reference producer). Append-only,
// idempotent on a deterministic id, no supersedence, no embeddings. See
// docs/superpowers/specs/2026-06-09-agent-self-improvement-signals.md.

export type SignalKind = "gate" | "eval" | "review" | "test";
export type SignalOutcome = "pass" | "fail" | "fix" | "exhausted";

/** Producer-side payload. `install_scope` and `id` are stamped server-side. */
export interface SignalInput {
  readonly v?: number;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly session: string | null;
  readonly ts: string;
}

/** Stored signal. `step` is denormalized from `detail.step` for indexing. */
export interface Signal {
  readonly id: string;
  readonly v: number;
  readonly installScope: string;
  readonly kind: SignalKind;
  readonly producer: string;
  readonly outcome: SignalOutcome;
  readonly model: string;
  readonly repo: string;
  readonly step: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly sessionId: string | null;
  readonly ts: string;
  readonly createdAt: string;
}
