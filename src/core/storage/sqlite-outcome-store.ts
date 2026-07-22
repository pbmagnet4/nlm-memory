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
 * `reDerivationPairs` (#405) is read from the cache file the 24h
 * corpus-monitor job writes (`~/.nlm/re-derivation-pairs.json` by default,
 * see `src/cli/nlm.ts`'s `persistReDerivationPairs`), not recomputed inline.
 * Measured on the real corpus copy (~4.6k sessions/42d window),
 * `computeReDerivationRate` (`@core/metrics/re-derivation.js`) costs ~7s: an
 * N+1 query per session for entities/decisions, then an O(n^2) pairwise
 * jaccard scan. That blows the ~2s digest budget and would add
 * multi-second latency to every `get_session` call - fine for a background
 * cron, not for a request path. The cache is fresh (~24h stale at worst)
 * while the 24h monitor runs; that is an assumption, not a guarantee, so a
 * cache older than 72h (monitor presumed dead) is discarded. Missing,
 * corrupt, or stale file (first boot before the monitor's first run, a
 * stopped monitor, etc.) falls back to `[]`: sessions that would have
 * landed in `re-derived-later` fall back to `unobserved`, which stays
 * honest rather than silently wrong.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { readCitationLog } from "@core/recall/citation-log.js";
import { parseReDerivationPairsFile, type ReDerivationPair } from "@core/metrics/re-derivation.js";
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

const DEFAULT_REDERIVATION_PAIRS_PATH = join(homedir(), ".nlm", "re-derivation-pairs.json");

// 3x the corpus monitor's 24h refresh interval. A healthy monitor overwrites
// the cache daily, so a file this old means the monitor has stopped and the
// pairs can no longer be trusted as fresh - discard rather than serve stale
// verdicts indefinitely.
const REDERIVATION_PAIRS_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function loadCachedReDerivationPairs(pairsPath: string): ReadonlyArray<ReDerivationPair> {
  try {
    if (Date.now() - statSync(pairsPath).mtimeMs > REDERIVATION_PAIRS_MAX_AGE_MS) return [];
    return parseReDerivationPairsFile(readFileSync(pairsPath, "utf8"));
  } catch {
    return [];
  }
}

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
  /** Override for tests; defaults to `~/.nlm/re-derivation-pairs.json`. */
  readonly reDerivationPairsPath?: string;
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
    reDerivationPairs: loadCachedReDerivationPairs(opts.reDerivationPairsPath ?? DEFAULT_REDERIVATION_PAIRS_PATH),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.heldAfterDays !== undefined ? { heldAfterDays: opts.heldAfterDays } : {}),
  };
}

export interface OutcomeCoverageInput {
  readonly sessions: ReadonlyArray<OutcomeSession>;
  readonly signalsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeSignal>>;
  readonly edgesBySession: ReadonlyMap<string, ReadonlyArray<OutcomeEdge>>;
  readonly citationsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeCitation>>;
  /** Read from the corpus-monitor's cache file - see the module doc comment. */
  readonly reDerivationPairs: ReadonlyArray<ReDerivationPair>;
}

export interface LoadOutcomeCoverageInputOptions {
  /** ISO timestamp - only sessions with `ended_at >= sinceIso` are included. */
  readonly sinceIso: string;
  readonly citationLogPath?: string;
  /** Override for tests; defaults to `~/.nlm/re-derivation-pairs.json`. */
  readonly reDerivationPairsPath?: string;
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

  const reDerivationPairs = loadCachedReDerivationPairs(opts.reDerivationPairsPath ?? DEFAULT_REDERIVATION_PAIRS_PATH);
  return { sessions, signalsBySession, edgesBySession, citationsBySession, reDerivationPairs };
}
