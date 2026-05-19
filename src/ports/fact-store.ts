/**
 * FactStore — the only way core/ reads or writes the fact corpus.
 *
 * Companion to SessionStore. Sessions are the operator-recall unit; facts are
 * the agent-recall projection — normalized (subject, predicate, value) triples
 * derived from sessions, supersedence-aware. See
 * docs/plans/factstore-design.md.
 *
 * Phase B.1 ships the storage port + adapter only. No extraction wired yet
 * (B.2), no recall service (B.3), no MCP surface (B.3), no supersedence
 * autodetect (B.4). The surface here is the minimum needed by future phases:
 * insert one or many, look up by id, look up current (non-superseded) facts
 * by subject and optional predicate, mark a fact superseded.
 */

import type { Fact } from "@shared/types.js";

export interface FactQuery {
  readonly subject: string;
  readonly predicate?: string;
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

export interface FactStore {
  /** Atomically insert a single fact. Throws on duplicate id. */
  insert(fact: Fact): Promise<void>;

  /** Atomically insert many facts as one transaction. Throws on any duplicate id. */
  insertMany(facts: ReadonlyArray<Fact>): Promise<void>;

  getById(id: string): Promise<Fact | null>;

  /**
   * Exact-match lookup of the current (non-superseded) fact for a
   * subject+predicate pair. Returns null if none exists. This is the hot
   * path for deterministic supersedence on ingest (Phase B.4).
   */
  findCurrent(subject: string, predicate: string): Promise<Fact | null>;

  /**
   * List facts matching the query. Defaults: current (non-superseded) only,
   * limit 50. Ordered by created_at descending.
   */
  list(query: FactQuery): Promise<ReadonlyArray<Fact>>;

  /**
   * List all facts attributable to a single session. Used by the UI to show
   * a fact-count badge on a session digest, and by tests.
   */
  listBySession(sessionId: string): Promise<ReadonlyArray<Fact>>;

  /**
   * Mark `oldId` as superseded by `newId`. Both facts must exist. Reversible
   * by passing null as newId (Phase C operator-undo affordance).
   */
  markSuperseded(oldId: string, newId: string | null): Promise<void>;
}
