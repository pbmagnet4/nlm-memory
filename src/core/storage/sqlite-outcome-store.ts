/**
 * SQLite adapters for the outcome rollup ports (`@ports/outcome.js`,
 * `@core/outcome/rollup.js`) — #352 phase 2 Task 8. No Postgres adapters yet;
 * `get_session` and `nlm digest` both run against the operator's SQLite
 * deployment, so parity is deferred until a Postgres-backed caller exists.
 *
 * Never selects `sessions.body` — see the incident class noted on
 * `SqliteSessionStore.getByIds` (48KB/row of session markdown the recall
 * daemon does not need for this read shape).
 *
 * Two entry points:
 *  - `buildSqliteOutcomeDeps` — per-session `OutcomeDeps` for `get_session`.
 *    Fine to re-query per call; a single session's evidence is a handful of
 *    indexed lookups.
 *  - `loadOutcomeCoverageInput` — one query per evidence type across an
 *    entire id set, for the digest's Tier-B coverage block. Feeds
 *    `@core/outcome/coverage.js`'s `computeOutcomeCoverage`, not `deriveOutcome`
 *    directly.
 *
 * `reDerivationPairs` is always `[]` here — measured on the real corpus copy
 * (~4.6k sessions/42d window), `computeReDerivationRate`
 * (`@core/metrics/re-derivation.js`) costs ~7s: an N+1 query per session for
 * entities/decisions, then an O(n^2) pairwise jaccard scan. That blows the
 * ~2s digest budget and would add multi-second latency to every `get_session`
 * call. Re-derivation is also the rollup's lowest-precedence, rarest bucket
 * (9 pairs across the whole corpus at the 42-day window in the same
 * measurement) — sessions that would have landed there fall back to
 * `unobserved`, which stays honest rather than silently wrong. Follow-up:
 * either make `computeReDerivationRate` scale (batch its per-session reads,
 * bucket by shared entity instead of an O(n^2) scan) or have the existing
 * 24h corpus-monitor cron persist its pairs (not just the summary rate it
 * writes today) for these adapters to read instead of recomputing inline.
 */

import type Database from "better-sqlite3";
import { readCitationLog } from "@core/recall/citation-log.js";
import type { ReDerivationPair } from "@core/metrics/re-derivation.js";
import type {
  OutcomeCitation,
  OutcomeCitationReader,
  OutcomeDeps,
  OutcomeEdge,
  OutcomeEdgeKind,
  OutcomeEdgeReader,
  OutcomeSession,
  OutcomeSessionReader,
  OutcomeSignal,
  OutcomeSignalReader,
} from "@ports/outcome.js";
import type { SessionStatus, SignalOutcome } from "@shared/types.js";

const RELEVANT_EDGE_KINDS = "('supersedes','replaces','continues')";

export class SqliteOutcomeSessionReader implements OutcomeSessionReader {
  constructor(private readonly db: Database.Database) {}

  async getById(sessionId: string): Promise<OutcomeSession | null> {
    const row = this.db
      .prepare<[string], { id: string; ended_at: string | null; status: SessionStatus }>(
        "SELECT id, ended_at, status FROM sessions WHERE id = ?",
      )
      .get(sessionId);
    if (!row) return null;
    return { id: row.id, endedAt: row.ended_at, status: row.status };
  }
}

export class SqliteOutcomeSignalReader implements OutcomeSignalReader {
  constructor(private readonly db: Database.Database) {}

  async listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeSignal>> {
    return this.db
      .prepare<[string], { id: string; outcome: SignalOutcome }>(
        "SELECT id, outcome FROM signals WHERE session_id = ?",
      )
      .all(sessionId);
  }
}

export class SqliteOutcomeEdgeReader implements OutcomeEdgeReader {
  constructor(private readonly db: Database.Database) {}

  async listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeEdge>> {
    const rows = this.db
      .prepare<[string], { from_session: string; to_session: string; kind: OutcomeEdgeKind }>(
        `SELECT from_session, to_session, kind FROM session_edges
         WHERE to_session = ? AND kind IN ${RELEVANT_EDGE_KINDS}`,
      )
      .all(sessionId);
    return rows.map((r) => ({ fromSession: r.from_session, toSession: r.to_session, kind: r.kind }));
  }
}

/**
 * Citations live in the append-only JSONL log (`@core/recall/citation-log.js`),
 * not SQLite — `cite_session` calls are telemetry, not a table. `readCitationLog`
 * takes a required day-window; passing `Infinity` reads the whole log since
 * rollup evidence has no expiry.
 */
export class SqliteOutcomeCitationReader implements OutcomeCitationReader {
  constructor(private readonly logPath?: string) {}

  async listForSession(sessionId: string): Promise<ReadonlyArray<OutcomeCitation>> {
    const entries =
      this.logPath !== undefined
        ? await readCitationLog(Number.POSITIVE_INFINITY, this.logPath)
        : await readCitationLog(Number.POSITIVE_INFINITY);
    return entries.filter((e) => e.citedId === sessionId).map((e) => ({ conversationId: e.conversationId }));
  }
}

export interface BuildSqliteOutcomeDepsOptions {
  readonly citationLogPath?: string;
  readonly now?: () => Date;
  readonly heldAfterDays?: number;
}

/** Per-session OutcomeDeps for `get_session`. Safe to build fresh per call. */
export async function buildSqliteOutcomeDeps(
  db: Database.Database,
  opts: BuildSqliteOutcomeDepsOptions = {},
): Promise<OutcomeDeps> {
  return {
    sessions: new SqliteOutcomeSessionReader(db),
    signals: new SqliteOutcomeSignalReader(db),
    edges: new SqliteOutcomeEdgeReader(db),
    citations: new SqliteOutcomeCitationReader(opts.citationLogPath),
    reDerivationPairs: [],
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.heldAfterDays !== undefined ? { heldAfterDays: opts.heldAfterDays } : {}),
  };
}

export interface OutcomeCoverageInput {
  readonly sessions: ReadonlyArray<OutcomeSession>;
  readonly signalsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeSignal>>;
  readonly edgesBySession: ReadonlyMap<string, ReadonlyArray<OutcomeEdge>>;
  readonly citationsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeCitation>>;
  /** Always `[]` from `loadOutcomeCoverageInput` — see the module doc comment. */
  readonly reDerivationPairs: ReadonlyArray<ReDerivationPair>;
}

export interface LoadOutcomeCoverageInputOptions {
  /** ISO timestamp — only sessions with `ended_at >= sinceIso` are included. */
  readonly sinceIso: string;
  readonly citationLogPath?: string;
}

/**
 * Batched loader for the digest's Tier-B coverage block: one query per
 * evidence type across the whole ended-in-window id set, not one query per
 * session. `computeOutcomeCoverage` (`@core/outcome/coverage.js`) turns this
 * into per-session verdicts via `deriveOutcome`.
 */
export async function loadOutcomeCoverageInput(
  db: Database.Database,
  opts: LoadOutcomeCoverageInputOptions,
): Promise<OutcomeCoverageInput> {
  const sessionRows = db
    .prepare<[string], { id: string; ended_at: string | null; status: SessionStatus }>(
      `SELECT id, ended_at, status FROM sessions
       WHERE ended_at IS NOT NULL AND ended_at >= ?
       ORDER BY ended_at DESC`,
    )
    .all(opts.sinceIso);
  const sessions: OutcomeSession[] = sessionRows.map((r) => ({
    id: r.id,
    endedAt: r.ended_at,
    status: r.status,
  }));

  const signalsBySession = new Map<string, OutcomeSignal[]>();
  const edgesBySession = new Map<string, OutcomeEdge[]>();
  const citationsBySession = new Map<string, OutcomeCitation[]>();

  if (sessions.length > 0) {
    const ids = sessions.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");

    const signalRows = db
      .prepare<string[], { session_id: string; id: string; outcome: SignalOutcome }>(
        `SELECT session_id, id, outcome FROM signals WHERE session_id IN (${placeholders})`,
      )
      .all(...ids);
    for (const r of signalRows) {
      const list = signalsBySession.get(r.session_id) ?? [];
      list.push({ id: r.id, outcome: r.outcome });
      signalsBySession.set(r.session_id, list);
    }

    const edgeRows = db
      .prepare<string[], { from_session: string; to_session: string; kind: OutcomeEdgeKind }>(
        `SELECT from_session, to_session, kind FROM session_edges
         WHERE to_session IN (${placeholders}) AND kind IN ${RELEVANT_EDGE_KINDS}`,
      )
      .all(...ids);
    for (const r of edgeRows) {
      const list = edgesBySession.get(r.to_session) ?? [];
      list.push({ fromSession: r.from_session, toSession: r.to_session, kind: r.kind });
      edgesBySession.set(r.to_session, list);
    }

    const idSet = new Set(ids);
    const citationEntries =
      opts.citationLogPath !== undefined
        ? await readCitationLog(Number.POSITIVE_INFINITY, opts.citationLogPath)
        : await readCitationLog(Number.POSITIVE_INFINITY);
    for (const entry of citationEntries) {
      if (!idSet.has(entry.citedId)) continue;
      const list = citationsBySession.get(entry.citedId) ?? [];
      list.push({ conversationId: entry.conversationId });
      citationsBySession.set(entry.citedId, list);
    }
  }

  return { sessions, signalsBySession, edgesBySession, citationsBySession, reDerivationPairs: [] };
}
