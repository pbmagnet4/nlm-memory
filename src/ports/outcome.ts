/**
 * Ports for the outcome rollup core (`src/core/outcome/rollup.ts`).
 *
 * The rollup answers "did this session's decision hold up?" using only
 * evidence a *later, independent* event produced — never the agent's or an
 * LLM's opinion of its own work. These narrow reader interfaces are the only
 * way the core module touches the corpus; adapters (SQLite/Postgres/JSONL)
 * live outside `core/` and are not part of this task.
 */

import type { SessionStatus, SignalOutcome } from "@shared/types.js";
import type { ReDerivationPair } from "@core/metrics/re-derivation.js";

/** Narrow session projection — just enough to gate the supersession/held checks. */
export interface OutcomeSession {
  readonly id: string;
  readonly endedAt: string | null;
  readonly status: SessionStatus;
}

export interface OutcomeSessionReader {
  getById(sessionId: string): Promise<OutcomeSession | null>;
}

/** Tier-A evidence: a `signals` row correlated to the session. */
export interface OutcomeSignal {
  readonly id: string;
  readonly outcome: SignalOutcome;
}

export interface OutcomeSignalReader {
  listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeSignal>>;
}

/**
 * `session_edges` rows touching this session, in the same
 * (fromSession, toSession, kind) shape as the store. Convention (per
 * sqlite-session-store/pg-session-store): `fromSession` is the newer/citing
 * session, `toSession` is the older/cited one — e.g. a `continues` edge with
 * `toSession === sessionId` means some other (newer) session continues this
 * one; a `supersedes`/`replaces` edge with `toSession === sessionId` means
 * this session was superseded/replaced by `fromSession`.
 */
export type OutcomeEdgeKind = "supersedes" | "replaces" | "continues";

export interface OutcomeEdge {
  readonly fromSession: string;
  readonly toSession: string;
  readonly kind: OutcomeEdgeKind;
}

export interface OutcomeEdgeReader {
  listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeEdge>>;
}

/**
 * Weakest evidence tier: a later conversation's `cite_session` call
 * referencing this session. Per the CITATION-DEGRADED sign-off amendment,
 * this can appear in `evidence[]` but must never be the sole basis of a
 * non-`unobserved` verdict.
 */
export interface OutcomeCitation {
  readonly conversationId: string;
}

export interface OutcomeCitationReader {
  listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeCitation>>;
}

export interface OutcomeDeps {
  readonly sessions: OutcomeSessionReader;
  readonly signals: OutcomeSignalReader;
  readonly edges: OutcomeEdgeReader;
  readonly citations: OutcomeCitationReader;
  /**
   * Precomputed re-derivation pairs (see `computeReDerivationRate` in
   * `@core/metrics/re-derivation.js`). The rollup reuses that computation's
   * output rather than re-deriving pair membership itself — re-derivation is
   * an O(n^2) corpus-wide scan, not something to repeat per session.
   */
  readonly reDerivationPairs: ReadonlyArray<ReDerivationPair>;
  /** Injected clock. Never call `Date.now()`/`new Date()` inline in the core. */
  readonly now?: () => Date;
  /** Days a session must sit un-superseded before it counts as "held". Default 14. */
  readonly heldAfterDays?: number;
}

export type OutcomeVerdictKind =
  | "held"
  | "overturned"
  | "built-upon"
  | "re-derived-later"
  | "unobserved";

export type OutcomeConfidence = "high" | "medium" | "low";

export interface OutcomeVerdict {
  readonly verdict: OutcomeVerdictKind;
  readonly tier: "A" | "B";
  readonly confidence: OutcomeConfidence;
  readonly evidence: ReadonlyArray<string>;
  /** Set only when citation was the sole evidence found (capture-degraded corpus). */
  readonly producerDegraded?: true;
}
