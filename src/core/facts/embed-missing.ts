/**
 * Missing-fact-embedding measurement shared by the sweep, /api/health and
 * `nlm doctor` (I8). "Missing" means a recall-eligible fact with no vector.
 * Reads the vec0 shadow rowids table, which needs no sqlite-vec extension.
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";
import { timeSyncSlice } from "@core/scheduler/loop-monitor.js";
import { yieldToEventLoop } from "@core/util/yield-loop.js";

/** Alarm above this share of active facts (E1 acceptance: under 0.5%). */
export const MISSING_SHARE_ALARM = 0.005;

export interface FactEmbedStats {
  readonly active: number;
  readonly missing: number;
  readonly pending: number;
  readonly missingShare: number;
}

const ACTIVE = "f.superseded_by IS NULL AND f.retired_at IS NULL";
const MISSING = `${ACTIVE} AND f.id NOT IN (SELECT id FROM fact_embeddings_rowids)`;

/** Facts per event-loop yield while counting (T1757). Every count below is a
 *  full scan of `facts` — measured 53-86 ms per statement against the live
 *  86,308-fact corpus, which is the `[loop] fact-embed-sweep took 2347ms (sync
 *  slice 605ms)` line, every 2 minutes. 5,000 rows of the same predicate is a
 *  slice of a few ms, and one `setImmediate` per window is nothing next to the
 *  embed round-trips the sweep already awaits. */
export const FACT_COUNT_BATCH_ROWS = 5_000;

export interface FactEmbedStatsPacing {
  /** Rows per window. Default `FACT_COUNT_BATCH_ROWS`. */
  readonly yieldEveryRows?: number;
  /** Yield injection point, so a test can count the hand-offs. */
  readonly yieldFn?: () => Promise<void>;
  /** Loop-monitor sink/threshold for the `[loop] sync fact-embed-sweep:..` line. */
  readonly loopLogger?: (msg: string) => void;
  readonly loopThresholdMs?: number;
}

/**
 * `computeFactEmbedStats`, one rowid window at a time.
 *
 * The three counts are the same predicates restricted to `f.rowid BETWEEN lo AND
 * hi`, and the windows partition the table, so the sums are the whole-table
 * numbers (`fact_embed_pending.fact_id` is the primary key, so the pending join is
 * 1:1 and cannot be double-counted at a window boundary). The only difference from
 * one statement is that a concurrent write landing in a window that has already
 * been counted shows up in neither — the same accepted trade-off as the chunked
 * corpus stats and re-derivation sweeps.
 *
 * The synchronous version stays for callers that run off the serving loop
 * (`nlm doctor`, the I8 integrity check) and as the oracle in the tests.
 */
export async function computeFactEmbedStatsChunked(
  db: Database.Database,
  pacing: FactEmbedStatsPacing = {},
): Promise<FactEmbedStats> {
  const batch = Math.max(1, pacing.yieldEveryRows ?? FACT_COUNT_BATCH_ROWS);
  const yieldFn = pacing.yieldFn ?? yieldToEventLoop;
  const timing = {
    ...(pacing.loopLogger ? { logger: pacing.loopLogger } : {}),
    ...(pacing.loopThresholdMs !== undefined ? { thresholdMs: pacing.loopThresholdMs } : {}),
  };
  const bounds = db
    .prepare<[], { lo: number | null; hi: number | null }>(
      "SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM facts",
    )
    .get();
  if (!bounds || bounds.lo === null || bounds.hi === null) {
    return { active: 0, missing: 0, pending: 0, missingShare: 0 };
  }
  const one = (sql: string): number => db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
  let active = 0;
  let missing = 0;
  let pending = 0;
  for (let lo = bounds.lo; lo <= bounds.hi; lo += batch) {
    const hi = lo + batch - 1;
    const window = `f.rowid BETWEEN ${lo} AND ${hi}`;
    const counts = timeSyncSlice(
      "fact-embed-sweep",
      "count",
      () => ({
        active: one(`SELECT COUNT(*) AS n FROM facts f WHERE ${ACTIVE} AND ${window}`),
        missing: one(`SELECT COUNT(*) AS n FROM facts f WHERE ${MISSING} AND ${window}`),
        pending: one(
          `SELECT COUNT(*) AS n FROM fact_embed_pending p JOIN facts f ON f.id = p.fact_id WHERE ${MISSING} AND ${window}`,
        ),
      }),
      timing,
    );
    active += counts.active;
    missing += counts.missing;
    pending += counts.pending;
    if (hi < bounds.hi!) await yieldFn();
  }
  return { active, missing, pending, missingShare: active === 0 ? 0 : missing / active };
}

export function computeFactEmbedStats(db: Database.Database): FactEmbedStats {
  const one = (sql: string): number => db.prepare<[], { n: number }>(sql).get()?.n ?? 0;
  const active = one(`SELECT COUNT(*) AS n FROM facts f WHERE ${ACTIVE}`);
  const missing = one(`SELECT COUNT(*) AS n FROM facts f WHERE ${MISSING}`);
  const pending = one(
    `SELECT COUNT(*) AS n FROM fact_embed_pending p JOIN facts f ON f.id = p.fact_id WHERE ${MISSING}`,
  );
  return { active, missing, pending, missingShare: active === 0 ? 0 : missing / active };
}

/** Postgres counterpart of computeFactEmbedStats: missing means no fact_embeddings row. */
export async function computeFactEmbedStatsOnPg(pool: Pool): Promise<FactEmbedStats> {
  const res = await pool.query<{ active: string; missing: string; pending: string }>(
    `SELECT COUNT(*) AS active,
            COUNT(*) FILTER (WHERE e.fact_id IS NULL) AS missing,
            COUNT(*) FILTER (WHERE e.fact_id IS NULL AND p.fact_id IS NOT NULL) AS pending
     FROM facts f
     LEFT JOIN fact_embeddings e ON e.fact_id = f.id
     LEFT JOIN fact_embed_pending p ON p.fact_id = f.id
     WHERE ${ACTIVE}`,
  );
  const row = res.rows[0]!;
  const [active, missing, pending] = [Number(row.active), Number(row.missing), Number(row.pending)];
  return { active, missing, pending, missingShare: active === 0 ? 0 : missing / active };
}

export function missingFactEmbeddingSamples(db: Database.Database, limit = 6): string[] {
  return db
    .prepare<[number], { id: string }>(`SELECT f.id FROM facts f WHERE ${MISSING} LIMIT ?`)
    .all(limit)
    .map((r) => r.id);
}
