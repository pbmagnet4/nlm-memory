import type Database from "better-sqlite3";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { completeSemanticTopK } from "./sqlite-semantic-top-k.js";
import type { FactEligibility, FactSemanticNeighbor } from "@ports/fact-store.js";
type NeighborRow = { fact_id: string; distance: number };
export function readSemanticFacts(
  db: Database.Database,
  tenantId: string,
  queryVector: Float32Array,
  limit: number,
  eligibility?: FactEligibility,
): ReadonlyArray<FactSemanticNeighbor> {
  if (eligibility?.workstreamIds?.length === 0) return [];
  const factTenant = tenantClause(tenantId, "f.tenant_id");
  const sourceTenant = tenantClause(tenantId, "s.tenant_id");
  const where = [factTenant.sql, sourceTenant.sql];
  const blob = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const params: unknown[] = [blob, factTenant.param, sourceTenant.param];
  for (const field of ["subject", "predicate", "kind"] as const) {
    if (eligibility?.[field] !== undefined) {
      where.push(`f.${field} = ?`);
      params.push(eligibility[field]);
    }
  }
  if (eligibility?.minConfidence !== undefined) {
    where.push("f.confidence >= ?");
    params.push(eligibility.minConfidence);
  }
  if (eligibility?.includeSuperseded !== true) {
    where.push("f.superseded_by IS NULL", "f.retired_at IS NULL");
  }
  if (eligibility?.workstreamIds !== undefined) {
    where.push(`s.workstream_id IN (${eligibility.workstreamIds.map(() => "?").join(",")})`);
    params.push(...eligibility.workstreamIds);
  }
  const k = Math.max(1, Math.trunc(limit));
  params.push(k);
  // Source-first avoids the corroboration index pulling every tenant vector before scope filtering.
  const exact = (): readonly FactSemanticNeighbor[] => db.prepare<unknown[], NeighborRow>(`
    SELECT fe.fact_id, vec_distance_L2(fe.embedding, ?) AS distance
    FROM sessions s
    CROSS JOIN facts f ON f.source_session_id = s.id
    CROSS JOIN fact_embeddings fe ON fe.fact_id = f.id
    WHERE ${where.join(" AND ")}
    ORDER BY distance, fe.fact_id
    LIMIT ?
  `).all(...params).map((r) => ({ factId: r.fact_id, distance: r.distance }));
  if (eligibility?.workstreamIds !== undefined) return exact();
  return db.transaction(() => completeSemanticTopK(k,
    (window) => db.prepare<[Buffer, number], NeighborRow>(`
      SELECT fact_id, distance FROM fact_embeddings
      WHERE embedding MATCH ? AND k = ? ORDER BY distance
    `).all(blob, window),
    (candidates) => {
      if (candidates.length === 0) return [];
      const ids = candidates.map((r) => r.fact_id);
      const owned = db.prepare<unknown[], { id: string }>(`
        SELECT f.id FROM facts f JOIN sessions s ON s.id = f.source_session_id
        WHERE ${where.join(" AND ")} AND f.id IN (${ids.map(() => "?").join(",")})
      `).all(...params.slice(1, -1), ...ids);
      const eligibleIds = new Set(owned.map((r) => r.id));
      return candidates.filter((r) => eligibleIds.has(r.fact_id))
        .map((r) => ({ factId: r.fact_id, distance: r.distance }))
        .sort((a, b) => a.distance - b.distance || Buffer.compare(Buffer.from(a.factId), Buffer.from(b.factId)))
        .slice(0, k);
    }, exact)).deferred();
}
