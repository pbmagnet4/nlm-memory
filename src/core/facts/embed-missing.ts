/**
 * Missing-fact-embedding measurement shared by the sweep, /api/health and
 * `nlm doctor` (I8). "Missing" means a recall-eligible fact with no vector.
 * Reads the vec0 shadow rowids table, which needs no sqlite-vec extension.
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";

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
