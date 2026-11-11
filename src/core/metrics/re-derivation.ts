/**
 * re_derivation_rate: how often the same decision is re-made across sessions
 * that share a topic but were never linked. A high rate means recall is failing
 * to surface the prior decision, so the operator (or an agent) re-derives it.
 *
 * A pair counts as a re-derivation when the two sessions share at least one
 * entity, sit more than GAP_DAYS apart, have decision text overlapping at or
 * above JACCARD_FLOOR, and have no `continues`/`supersedes` edge linking them.
 */

import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { yieldToEventLoop } from "@core/util/yield-loop.js";

export interface ReDerivationSession {
  readonly id: string;
  readonly startedAt: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
}

export interface ReDerivationEdge {
  readonly from_session: string;
  readonly to_session: string;
  readonly kind: string;
}

export interface ReDerivationDeps {
  listSessionsWithin(windowDays: number): Promise<ReadonlyArray<ReDerivationSession>>;
  listEdges(): Promise<ReadonlyArray<ReDerivationEdge>>;
}

export interface ReDerivationPair {
  readonly a: string;
  readonly b: string;
  readonly sharedEntities: ReadonlyArray<string>;
  readonly jaccard: number;
}

export interface ReDerivationReport {
  readonly rate: number;
  readonly pairs: ReadonlyArray<ReDerivationPair>;
  /**
   * Denominator of the legacy pair-space rate: entity-sharing session pairs
   * where BOTH sides carry at least one decision. A pair with a decisionless
   * side cannot be a re-derivation by construction, and counting it inflated
   * this figure roughly 3x - measured 2026-08-04 on the live 90-day window,
   * 1,266,809 of 1,905,497 eligible pairs (66.5%) had a decisionless side.
   */
  readonly eligible: number;
  /** Sessions in the window carrying at least one decision. Linear in corpus size. */
  readonly decisionBearingSessions: number;
  /** Distinct later-side sessions appearing in `pairs`. Counted once each. */
  readonly reDerivingSessions: number;
  /**
   * reDerivingSessions / decisionBearingSessions. This is the trendable metric:
   * the pair-space `rate` divides by a denominator that grows quadratically with
   * the corpus, so it mechanically falls the more the product is used, which is
   * backwards for a number whose job is to show improvement.
   */
  readonly sessionRate: number;
}

const JACCARD_FLOOR = 0.5;
const GAP_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Words of the decision text, exactly as the pair score has always tokenized
 *  them. Hoisted out of the pair loop: it is a pure function of one session, so
 *  computing it per candidate pair recomputed it O(n²) times. */
function tokensOf(xs: ReadonlyArray<string>): Set<string> {
  return new Set(xs.join(" ").toLowerCase().split(/\W+/).filter(Boolean));
}

function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Sessions per event-loop yield while enriching the id list. Measured on the
 *  live corpus (17,263 sessions in the 42-day window, 2026-11-11): the whole
 *  enrichment costs 124ms, but it used to run as one synchronous slice. At 200
 *  rows a batch (~86 yields) each slice is ~1.5ms. */
export const RE_DERIVATION_ENRICH_BATCH_ROWS = 200;

/** Candidate pairs examined per event-loop yield in the scoring loop. Measured on
 *  the live corpus: 14.5M candidate pairs among the 5,393 decision-bearing
 *  sessions of the 42-day window, ~17ms per 100,000-pair chunk (145 chunks). The
 *  loop is pure CPU over materialised rows, so nothing but this bounds it. */
export const RE_DERIVATION_YIELD_EVERY_PAIRS = 100_000;

/** Injection points for the two yields, so a test can count them and a caller
 *  can retune the slice budget. Neither changes the report. */
export interface ReDerivationPacing {
  readonly yieldEveryPairs?: number;
  readonly yieldFn?: () => Promise<void>;
}

export interface SqliteReDerivationDepsOptions extends ReDerivationPacing {
  readonly enrichBatchRows?: number;
}

interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

/**
 * SQLite-backed deps for the CLI readout. Reads sessions started within the
 * window along with their entity links and decision markers, plus all edges.
 * `tenantId` scopes the sessions SELECT via tenantClause — the pairs this
 * produces get persisted to a tenant-derived cache file (see
 * `@core/storage/sqlite-outcome-store.js`), so an un-tenanted scan here would
 * leak every tenant's sessions into whichever tenant's file reads it back.
 *
 * T679: the per-session enrichment used to run for the whole window in one
 * synchronous slice — two prepared statements per session, 34,488 of them for
 * the live 42-day window, with nothing yielding in between. Rows are now
 * enriched in `enrichBatchRows` chunks with a yield between them; the returned
 * array (order and content) is unchanged, because the ordering comes from the
 * one SELECT that still reads the whole window at once.
 */
export function sqliteReDerivationDeps(
  db: SqliteLike,
  tenantId: string,
  opts: SqliteReDerivationDepsOptions = {},
): ReDerivationDeps {
  const tc = tenantClause(tenantId);
  const yieldFn = opts.yieldFn ?? yieldToEventLoop;
  const batchRows = Math.max(1, opts.enrichBatchRows ?? RE_DERIVATION_ENRICH_BATCH_ROWS);
  return {
    async listSessionsWithin(windowDays) {
      const rows = db
        .prepare(
          `SELECT id, started_at AS startedAt
             FROM sessions
            WHERE started_at >= datetime('now', ?) AND ${tc.sql}
            ORDER BY started_at ASC`,
        )
        .all(`-${windowDays} days`, tc.param) as Array<{ id: string; startedAt: string }>;
      const entStmt = db.prepare(
        "SELECT entity_canonical AS e FROM session_entities WHERE session_id = ?",
      );
      const decStmt = db.prepare(
        "SELECT text AS t FROM markers WHERE session_id = ? AND kind = 'decision' ORDER BY position ASC",
      );
      const out: ReDerivationSession[] = [];
      for (let lo = 0; lo < rows.length; lo += batchRows) {
        if (lo > 0) await yieldFn();
        for (const r of rows.slice(lo, lo + batchRows)) {
          out.push({
            id: r.id,
            startedAt: r.startedAt,
            entities: (entStmt.all(r.id) as Array<{ e: string }>).map((x) => x.e),
            decisions: (decStmt.all(r.id) as Array<{ t: string }>).map((x) => x.t),
          });
        }
      }
      return out;
    },
    async listEdges() {
      return db
        .prepare("SELECT from_session, to_session, kind FROM session_edges")
        .all() as Array<ReDerivationEdge>;
    },
  };
}

/**
 * Parses the on-disk cache the 24h corpus-monitor job writes to
 * (`~/.nlm/re-derivation-pairs.json`, see `src/cli/nlm.ts`) and the SQLite
 * outcome adapters read back (`@core/storage/sqlite-outcome-store.js`).
 * The file is a plain `ReDerivationPair[]` - anything else (corrupt JSON,
 * a non-array shape) is treated as no pairs rather than thrown.
 */
export function parseReDerivationPairsFile(raw: string): ReadonlyArray<ReDerivationPair> {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as ReDerivationPair[]) : [];
}

/**
 * T679: this loop is the single longest synchronous slice in the daemon, and it
 * runs far more often than "daily": the corpus monitor fires 60s after every boot
 * as well as on its 24h timer, and `~/.nlm/daemon.err` holds 106 boots against
 * 114 corpus-monitor runs. Measured on the live corpus (2026-11-11): 17,263
 * sessions in the 42-day window, **13.9s in one slice** — three times a hook's
 * whole timeout budget, which is why prompt-recall fails two thirds of the time.
 *
 * Two changes, neither of which can alter the report:
 *   • per-session work (entity set, timestamp parse) is hoisted out of the pair
 *     loop and tokenization is computed once per session on first use instead of
 *     once per candidate pair — pure functions of one session, so the values
 *     compared and the pair order are byte-for-byte what they were.
 *   • the surviving pairs are walked through an index list of decision-bearing
 *     sessions in ascending original order, so the sequence reaching the
 *     `eligible` counter and `pairs.push` is identical while the decisionless
 *     majority is skipped rather than tested.
 * Same work before and after on the live corpus (eligible 1,037,608, 7 pairs),
 * ~3.3s of wall time instead of 13.9s, and no slice over ~130ms — where the
 * residual is V8 collecting the materialised window rather than SQLite, which is
 * why tokenization is lazy (17k sets allocated to score 7 pairs was silly).
 */
export async function computeReDerivationRate(
  deps: ReDerivationDeps,
  windowDays: number,
  opts: ReDerivationPacing = {},
): Promise<ReDerivationReport> {
  const yieldFn = opts.yieldFn ?? yieldToEventLoop;
  const yieldEveryPairs = Math.max(1, opts.yieldEveryPairs ?? RE_DERIVATION_YIELD_EVERY_PAIRS);
  const sessions = await deps.listSessionsWithin(windowDays);
  const edges = await deps.listEdges();
  const linked = new Set(
    edges
      .filter((e) => e.kind === "continues" || e.kind === "supersedes")
      .map((e) => [e.from_session, e.to_session].sort().join("|")),
  );
  const rows = sessions.map((s) => ({
    id: s.id,
    timeMs: new Date(s.startedAt).getTime(),
    entities: s.entities,
    entitySet: new Set(s.entities),
    decisions: s.decisions,
    // Filled on first use: only pairs clearing the entity, edge and gap gates
    // need tokens, and eagerly tokenizing the whole window allocated 17k sets to
    // score 7 pairs.
    tokens: null as Set<string> | null,
    hasDecisions: s.decisions.length > 0,
  }));
  const tokensOfRow = (r: (typeof rows)[number]): Set<string> => (r.tokens ??= tokensOf(r.decisions));
  const decisionBearing: number[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    if (rows[idx]!.hasDecisions) decisionBearing.push(idx);
  }

  const pairs: ReDerivationPair[] = [];
  const reDeriving = new Set<string>();
  let eligible = 0;
  let pairsSinceYield = 0;
  for (let a = 0; a < decisionBearing.length; a++) {
    const s = rows[decisionBearing[a]!]!;
    for (let b = a + 1; b < decisionBearing.length; b++) {
      const t = rows[decisionBearing[b]!]!;
      if (++pairsSinceYield >= yieldEveryPairs) {
        pairsSinceYield = 0;
        await yieldFn();
      }
      // A decisionless side can never be a re-derivation, so such a pair does
      // not belong in the denominator at all.
      if (!s.entities.some((e) => t.entitySet.has(e))) continue;
      const shared = s.entities.filter((e) => t.entitySet.has(e));
      if (shared.length === 0) continue;
      eligible++;
      const key = s.id < t.id ? `${s.id}|${t.id}` : `${t.id}|${s.id}`;
      if (linked.has(key)) continue;
      const gap = Math.abs(t.timeMs - s.timeMs) / MS_PER_DAY;
      if (gap <= GAP_DAYS) continue;
      const jac = jaccardSets(tokensOfRow(s), tokensOfRow(t));
      if (jac >= JACCARD_FLOOR) {
        pairs.push({ a: s.id, b: t.id, sharedEntities: shared, jaccard: round2(jac) });
        const later = t.timeMs >= s.timeMs ? t.id : s.id;
        reDeriving.add(later);
      }
    }
  }
  const decisionBearingSessions = decisionBearing.length;
  return {
    rate: eligible ? pairs.length / eligible : 0,
    pairs,
    eligible,
    decisionBearingSessions,
    reDerivingSessions: reDeriving.size,
    sessionRate: decisionBearingSessions ? reDeriving.size / decisionBearingSessions : 0,
  };
}
