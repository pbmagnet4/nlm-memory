/**
 * The writing-sample vector read, shared by the semantic read worker and the
 * inline path in SqliteWritingSampleStore (T1770's shape: the scan runs on a
 * worker thread so a voice recall cannot stall the daemon's main loop).
 *
 * `writing_samples_vec` carries no tenant_id (DERIVE-VIA-FK — it is keyed by
 * sample_id), so like code_exemplars the KNN candidates come back from the
 * whole corpus and the tenant filter is applied inside the id-resolution SQL
 * against `writing_samples`. That filter is mandatory, not a down-rank: a
 * candidate that does not resolve within the caller's tenant is dropped.
 * `install_scope` is resolved by the store (never by a caller) and arrives on
 * the same filter.
 */

import type Database from "better-sqlite3";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { completeSemanticTopK } from "./sqlite-semantic-top-k.js";
import type { WritingSampleHit, WritingSampleOutcome, WritingSampleSource } from "@ports/writing-sample-store.js";

/** The store-resolved filter that travels with a semantic read request. */
export interface WritingSampleReadFilter {
  readonly installScope: string;
  readonly voice: string;
  readonly channel?: string;
  readonly outcomes: readonly WritingSampleOutcome[];
}

type HitRow = {
  id: string;
  voice: string;
  channel: string;
  source: WritingSampleSource;
  outcome: WritingSampleOutcome;
  text: string;
  source_ref: string | null;
  ts: string;
  distance: number;
};

/** Correlated-filter fragments, shared by the exact scan and id resolution. */
function eligibility(tenantId: string, filter: WritingSampleReadFilter): { sql: string; params: unknown[] } {
  const tc = tenantClause(tenantId, "ws.tenant_id");
  const where = [tc.sql, "ws.install_scope = ?", "ws.voice = ?"];
  const params: unknown[] = [tc.param, filter.installScope, filter.voice];
  if (filter.channel !== undefined) {
    where.push("ws.channel = ?");
    params.push(filter.channel);
  }
  where.push(`ws.outcome IN (${filter.outcomes.map(() => "?").join(",")})`);
  params.push(...filter.outcomes);
  return { sql: where.join(" AND "), params };
}

const HIT_COLUMNS = "ws.id, ws.voice, ws.channel, ws.source, ws.outcome, ws.text, ws.source_ref, ws.ts";

function toHit(row: HitRow, distance: number): WritingSampleHit {
  return {
    id: row.id,
    voice: row.voice,
    channel: row.channel,
    source: row.source,
    outcome: row.outcome,
    text: row.text,
    sourceRef: row.source_ref,
    ts: row.ts,
    distance,
  };
}

/** Distance order, then id, so ties resolve the same way on every run. */
function byDistanceThenId(a: WritingSampleHit, b: WritingSampleHit): number {
  return a.distance - b.distance || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

export function readSemanticWritingSamples(
  db: Database.Database,
  tenantId: string,
  queryVector: Float32Array,
  limit: number,
  filter: WritingSampleReadFilter,
): ReadonlyArray<WritingSampleHit> {
  if (filter.outcomes.length === 0) return [];
  const { sql: where, params: filters } = eligibility(tenantId, filter);
  const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const k = Math.max(1, Math.trunc(limit));

  // Exact: the eligible rows' own vectors, distance computed for each.
  const exact = (): ReadonlyArray<WritingSampleHit> =>
    db
      .prepare<unknown[], HitRow>(
        `SELECT ${HIT_COLUMNS}, vec_distance_L2(v.embedding, ?) AS distance
         FROM writing_samples ws
         CROSS JOIN writing_samples_vec v ON v.sample_id = ws.id
         WHERE ${where}
         ORDER BY distance, ws.id
         LIMIT ?`,
      )
      .all(blob, ...filters, k)
      .map((r) => toHit(r, r.distance));

  const resolve = (candidates: ReadonlyArray<{ sample_id: string; distance: number }>): ReadonlyArray<WritingSampleHit> => {
    if (candidates.length === 0) return [];
    const distanceById = new Map(candidates.map((r) => [r.sample_id, r.distance]));
    const ids = candidates.map((r) => r.sample_id);
    const rows = db
      .prepare<unknown[], HitRow>(
        `SELECT ${HIT_COLUMNS}
         FROM writing_samples ws
         WHERE ws.id IN (${ids.map(() => "?").join(",")}) AND ${where}`,
      )
      // The first placeholder group is the id list, so the filter params
      // follow them rather than reusing `params` (which leads with the blob).
      .all(...ids, ...filters)
      .map((r) => toHit(r, distanceById.get(r.id) ?? Number.MAX_VALUE));
    return rows.sort(byDistanceThenId).slice(0, k);
  };

  return db
    .transaction(() =>
      completeSemanticTopK(
        k,
        (window) =>
          db
            .prepare<[Buffer, number], { sample_id: string; distance: number }>(
              `SELECT sample_id, distance FROM writing_samples_vec
               WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
            )
            .all(blob, window),
        resolve,
        exact,
      ),
    )
    .deferred();
}
