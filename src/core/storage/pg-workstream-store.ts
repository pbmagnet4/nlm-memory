import type { Pool } from "pg";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
  scope: string | null;
};

const rowToWorkstream = (r: WsRow): Workstream => ({
  id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
  createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
  scope: r.scope,
});

export class PgWorkstreamStore implements WorkstreamStore {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: { id: string; label: string; scope: string | null }): Promise<Workstream> {
    await this.pool.query("INSERT INTO workstreams (id, label, scope, tenant_id) VALUES ($1, $2, $3, $4)", [input.id, input.label, input.scope, tenantId]);
    return (await this.getById(tenantId, input.id))!;
  }

  async getById(tenantId: string, id: string): Promise<Workstream | null> {
    const tc = tenantClausePg(tenantId, 2);
    const r = await this.pool.query<WsRow>(`SELECT * FROM workstreams WHERE id = $1 AND ${tc.sql}`, [id, tc.param]);
    return r.rows[0] ? rowToWorkstream(r.rows[0]) : null;
  }

  async findByNormalizedLabel(tenantId: string, normalizedLabel: string): Promise<Workstream | null> {
    const tc = tenantClausePg(tenantId, 1);
    const r = await this.pool.query<WsRow>(`SELECT * FROM workstreams WHERE ${tc.sql}`, [tc.param]);
    const hit = r.rows.find((row) => normalizeLabel(row.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }

  async listAll(tenantId: string): Promise<ReadonlyArray<Workstream>> {
    const tc = tenantClausePg(tenantId, 1);
    const r = await this.pool.query<WsRow>(`SELECT * FROM workstreams WHERE ${tc.sql}`, [tc.param]);
    return r.rows.map(rowToWorkstream);
  }

  async touchLastSession(tenantId: string, id: string, atIso: string): Promise<void> {
    const tc = tenantClausePg(tenantId, 3);
    await this.pool.query(`UPDATE workstreams SET last_session_at = $1, updated_at = NOW() WHERE id = $2 AND ${tc.sql}`, [atIso, id, tc.param]);
  }

  async setLabel(tenantId: string, id: string, label: string): Promise<void> {
    const tc = tenantClausePg(tenantId, 3);
    await this.pool.query(`UPDATE workstreams SET label = $1, updated_at = NOW() WHERE id = $2 AND ${tc.sql}`, [label, id, tc.param]);
  }

  async setStatus(tenantId: string, id: string, status: Workstream["status"]): Promise<void> {
    const tc = tenantClausePg(tenantId, 3);
    await this.pool.query(`UPDATE workstreams SET status = $1, updated_at = NOW() WHERE id = $2 AND ${tc.sql}`, [status, id, tc.param]);
  }

  /**
   * Both fromId and intoId must resolve within tenantId — every statement is
   * tenant-filtered, so a cross-tenant id pairs with nothing (same silent
   * no-op shape as an unrecognized id, matching pre-tenancy behavior).
   */
  async merge(tenantId: string, fromId: string, intoId: string): Promise<void> {
    // Pointer first (source of truth for resolution), then derived entity union, then clear.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const mergeTc = tenantClausePg(tenantId, 3);
      await client.query(
        `UPDATE workstreams SET merged_into = $1, status = 'merged', updated_at = NOW() WHERE id = $2 AND ${mergeTc.sql}`,
        [intoId, fromId, mergeTc.param],
      );
      const unionTc = tenantClausePg(tenantId, 3);
      await client.query(
        `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count, tenant_id)
         SELECT $1, entity_canonical, session_count, tenant_id FROM workstream_entities WHERE workstream_id = $2 AND ${unionTc.sql}
         ON CONFLICT (workstream_id, entity_canonical)
         DO UPDATE SET session_count = workstream_entities.session_count + excluded.session_count`,
        [intoId, fromId, unionTc.param],
      );
      const deleteTc = tenantClausePg(tenantId, 2);
      await client.query(`DELETE FROM workstream_entities WHERE workstream_id = $1 AND ${deleteTc.sql}`, [fromId, deleteTc.param]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertEntities(tenantId: string, workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    for (const raw of entities) {
      const e = raw.trim(); if (!e) continue;
      await this.pool.query(
        `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count, tenant_id) VALUES ($1, $2, 1, $3)
         ON CONFLICT (workstream_id, entity_canonical) DO UPDATE SET session_count = workstream_entities.session_count + 1`,
        [workstreamId, e, tenantId],
      );
    }
  }

  async entitiesFor(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, workstreamIds.length + 1);
    const r = await this.pool.query<{ workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph}) AND ${tc.sql}`, [...workstreamIds, tc.param],
    );
    for (const row of r.rows) {
      const list = out.get(row.workstream_id);
      if (list) list.push(row.entity_canonical); else out.set(row.workstream_id, [row.entity_canonical]);
    }
    return out;
  }

  async candidatesByEntityOverlap(tenantId: string, entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, names.length + 1);
    const r = await this.pool.query<{ workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph}) AND ${tc.sql} GROUP BY workstream_id ORDER BY overlap DESC LIMIT $${names.length + 2}`,
      [...names, tc.param, limit],
    );
    const ids = r.rows.map((row) => row.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(tenantId, ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
