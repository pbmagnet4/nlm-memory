/**
 * SessionStore — the only way core/ reads or writes the session corpus.
 *
 * Implementations live in core/storage. Adapters and use cases depend on this
 * interface, never on better-sqlite3 directly. Swapping SQLite for Postgres
 * tomorrow means writing a new implementation; core/ does not change.
 *
 * Every method takes `tenantId` as its non-optional FIRST parameter (program
 * spec §4.1, M2 plan Wave B). There is no default — the composition root
 * supplies `DEFAULT_TEAM_ID` (src/core/tenancy/default-team.ts) until M3
 * resolves the real tenant from the request's auth token.
 */

import type { BindingSource } from "@core/workstream/model.js";
import type { Session, SessionStatus } from "@shared/types.js";

export interface SemanticNeighbor {
  readonly sessionId: string;
  readonly distance: number;
}

export interface KeywordNeighbor {
  readonly sessionId: string;
  readonly score: number;
}

/**
 * Search-time supersedence handling. Replaced sessions (mechanical re-ingest
 * noise) are always excluded. When `includeSuperseded` is true, operator-
 * asserted superseded sessions are kept in the candidate set so investigative
 * recall can surface them down-ranked; when false (default), they are excluded.
 */
export interface SearchOptions {
  readonly includeSuperseded?: boolean;
  readonly workstreamIds?: ReadonlyArray<string>;
}

export interface SessionStore {
  getById(tenantId: string, sessionId: string): Promise<Session | null>;

  getByIds(tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>>;

  /**
   * Sessions whose lifespan [started_at, ended_at or open] overlaps the
   * half-open window [fromIso, toIso). Body is omitted (callers that need it
   * fetch by id). Ordered by started_at ascending. Used by the work-digest.
   */
  listByDateRange(tenantId: string, fromIso: string, toIso: string): Promise<ReadonlyArray<Session>>;

  semanticSearch(
    tenantId: string,
    queryVector: Float32Array,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<SemanticNeighbor>>;

  keywordSearch(
    tenantId: string,
    query: string,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<KeywordNeighbor>>;

  /**
   * For each id that is a superseded session, return its successor session id
   * (the `from_session` of the `supersedes` edge pointing at it). Ids with no
   * supersedes edge are absent from the map. Cheap edge-only lookup — does not
   * load session bodies. Used at recall result-assembly to badge superseded
   * hits with their successor.
   */
  resolveSuccessors(tenantId: string, ids: ReadonlyArray<string>): Promise<Map<string, string>>;

  updateStatus(tenantId: string, sessionId: string, status: SessionStatus): Promise<void>;

  /**
   * Mark `predecessorId` as superseded by `successorId`. Atomic:
   *   1. inserts a `session_edges (successorId, predecessorId, 'supersedes')` row
   *   2. flips predecessor's `sessions.status` to `'superseded'`
   *
   * Idempotent — re-marking is a no-op. Throws if either session id is
   * unknown (or belongs to a different tenant — same not-found shape). Used
   * by the `mark_superseded` MCP tool and any future UI action that lets an
   * operator retroactively retire a stale session.
   */
  markSuperseded(tenantId: string, predecessorId: string, successorId: string): Promise<void>;

  setWorkstreamBinding(tenantId: string, sessionId: string, workstreamId: string | null, source: BindingSource | null, confidence: number | null): Promise<void>;
  listSessionIdsByWorkstreams(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>>;
  getEntities(tenantId: string, sessionId: string): Promise<ReadonlyArray<string>>;
  getWorkstreamIds(tenantId: string, sessionIds: ReadonlyArray<string>): Promise<Map<string, string | null>>;
}
