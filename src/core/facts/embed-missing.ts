/**
 * Missing-fact-embedding measurement shared by the sweep, /api/health and
 * `nlm doctor` (I8). "Missing" means a recall-eligible fact with no vector.
 * Reads the vec0 shadow rowids table, which needs no sqlite-vec extension.
 */

import type Database from "better-sqlite3";

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

export function missingFactEmbeddingSamples(db: Database.Database, limit = 6): string[] {
  return db
    .prepare<[number], { id: string }>(`SELECT f.id FROM facts f WHERE ${MISSING} LIMIT ?`)
    .all(limit)
    .map((r) => r.id);
}
