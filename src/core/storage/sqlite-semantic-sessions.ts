import type Database from "better-sqlite3";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { completeSemanticTopK } from "./sqlite-semantic-top-k.js";
import type { SearchOptions, SemanticNeighbor } from "@ports/session-store.js";
type NeighborRow = { session_id: string; chunk_idx: number; distance: number };
export function readSemanticSessions(
  db: Database.Database,
  tenantId: string,
  queryVector: Float32Array,
  limit: number,
  opts?: SearchOptions,
): ReadonlyArray<SemanticNeighbor> {
  if (opts?.workstreamIds?.length === 0) return [];
  const tc = tenantClause(tenantId, "s.tenant_id");
  const where = [tc.sql, opts?.includeSuperseded === true
    ? "s.status != 'replaced'" : "s.status NOT IN ('superseded', 'replaced')"];
  const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const params: unknown[] = [blob, tc.param];
  if (opts?.workstreamIds !== undefined) {
    where.push(`s.workstream_id IN (${opts.workstreamIds.map(() => "?").join(",")})`);
    params.push(...opts.workstreamIds);
  }
  if (opts?.property !== undefined) {
    where.push("(EXISTS (SELECT 1 FROM facts pf WHERE pf.source_session_id = s.id AND pf.tenant_id = s.tenant_id AND pf.property_slug = ?) OR EXISTS (SELECT 1 FROM session_properties sp WHERE sp.session_id = s.id AND sp.tenant_id = s.tenant_id AND sp.property_slug = ?))");
    params.push(opts.property, opts.property);
  }
  const k = Math.max(1, Math.trunc(limit));
  params.push(k);
  // The embedding's own attribution survives historical gaps in session_chunk_map.
  const exact = (): readonly SemanticNeighbor[] => db.prepare<unknown[], NeighborRow>(`
    WITH eligible AS MATERIALIZED (
      SELECT sec.session_id, sec.chunk_idx, sec.chunk_id,
             vec_distance_L2(sec.embedding, ?) AS distance
      FROM session_embedding_chunks sec
      JOIN sessions s ON s.id = sec.session_id
      WHERE ${where.join(" AND ")}
    ), ranked AS (
      SELECT session_id, chunk_idx, distance,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY distance, chunk_idx, chunk_id) AS rank
      FROM eligible
    )
    SELECT session_id, chunk_idx, distance FROM ranked
    WHERE rank = 1
    ORDER BY distance, session_id
    LIMIT ?
  `).all(...params).map((r) => ({ sessionId: r.session_id, distance: r.distance, chunkIndex: Number(r.chunk_idx) }));
  if (opts?.workstreamIds !== undefined || opts?.property !== undefined) return exact();
  return db.transaction(() => completeSemanticTopK(k,
    (window) => db.prepare<[Buffer, number], NeighborRow>(`
      SELECT session_id, distance, chunk_idx FROM session_embedding_chunks
      WHERE embedding MATCH ? AND k = ? ORDER BY distance
    `).all(blob, window),
    (candidates) => {
      if (candidates.length === 0) return [];
      const ids = [...new Set(candidates.map((r) => r.session_id))];
      const owned = db.prepare<unknown[], { id: string }>(`
        SELECT s.id FROM sessions s
        WHERE ${where.join(" AND ")} AND s.id IN (${ids.map(() => "?").join(",")})
      `).all(...params.slice(1, -1), ...ids);
      const eligibleIds = new Set(owned.map((r) => r.id));
      const best = new Map<string, SemanticNeighbor>();
      for (const r of candidates) {
        if (!eligibleIds.has(r.session_id)) continue;
        const chunkIndex = Number(r.chunk_idx);
        const prior = best.get(r.session_id);
        if (!prior || r.distance < prior.distance || (r.distance === prior.distance && chunkIndex < prior.chunkIndex!)) {
          best.set(r.session_id, { sessionId: r.session_id, distance: r.distance, chunkIndex });
        }
      }
      return [...best.values()].sort((a, b) => a.distance - b.distance || Buffer.compare(Buffer.from(a.sessionId), Buffer.from(b.sessionId))).slice(0, k);
    }, exact)).deferred();
}
