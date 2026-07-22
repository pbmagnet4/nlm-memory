import type Database from "better-sqlite3";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
  scope: string | null;
};

function rowToWorkstream(r: WsRow): Workstream {
  return {
    id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
    createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
    scope: r.scope,
  };
}

export class SqliteWorkstreamStore implements WorkstreamStore {
  constructor(private readonly db: Database.Database) {}

  async create(tenantId: string, input: { id: string; label: string; scope: string | null }): Promise<Workstream> {
    this.db.prepare("INSERT INTO workstreams (id, label, scope, tenant_id) VALUES (?, ?, ?, ?)")
      .run(input.id, input.label, input.scope, tenantId);
    return (await this.getById(tenantId, input.id))!;
  }

  async getById(tenantId: string, id: string): Promise<Workstream | null> {
    const tc = tenantClause(tenantId);
    const r = this.db.prepare<unknown[], WsRow>(`SELECT * FROM workstreams WHERE id = ? AND ${tc.sql}`).get(id, tc.param);
    return r ? rowToWorkstream(r) : null;
  }

  async findByNormalizedLabel(tenantId: string, normalizedLabel: string): Promise<Workstream | null> {
    // Small set; normalize in JS to match normalizeLabel semantics exactly.
    const tc = tenantClause(tenantId);
    const rows = this.db.prepare<unknown[], WsRow>(`SELECT * FROM workstreams WHERE ${tc.sql}`).all(tc.param);
    const hit = rows.find((r) => normalizeLabel(r.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }

  async listAll(tenantId: string): Promise<ReadonlyArray<Workstream>> {
    const tc = tenantClause(tenantId);
    return this.db.prepare<unknown[], WsRow>(`SELECT * FROM workstreams WHERE ${tc.sql}`).all(tc.param).map(rowToWorkstream);
  }

  async touchLastSession(tenantId: string, id: string, atIso: string): Promise<void> {
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE workstreams SET last_session_at = ?, updated_at = datetime('now') WHERE id = ? AND ${tc.sql}`)
      .run(atIso, id, tc.param);
  }

  async setLabel(tenantId: string, id: string, label: string): Promise<void> {
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE workstreams SET label = ?, updated_at = datetime('now') WHERE id = ? AND ${tc.sql}`)
      .run(label, id, tc.param);
  }

  async setStatus(tenantId: string, id: string, status: Workstream["status"]): Promise<void> {
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE workstreams SET status = ?, updated_at = datetime('now') WHERE id = ? AND ${tc.sql}`)
      .run(status, id, tc.param);
  }

  /**
   * Both fromId and intoId must resolve within tenantId — every statement is
   * tenant-filtered, so a cross-tenant id pairs with nothing (same silent
   * no-op shape as an unrecognized id, matching pre-tenancy behavior).
   */
  async merge(tenantId: string, fromId: string, intoId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const mergeTc = tenantClause(tenantId);
      this.db.prepare(
        `UPDATE workstreams SET merged_into = ?, status = 'merged', updated_at = datetime('now') WHERE id = ? AND ${mergeTc.sql}`,
      ).run(intoId, fromId, mergeTc.param);
      // Union from's entities into into (sum session_count on PK conflict).
      const unionTc = tenantClause(tenantId);
      this.db.prepare(`
        INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count, tenant_id)
        SELECT ?, entity_canonical, session_count, tenant_id FROM workstream_entities WHERE workstream_id = ? AND ${unionTc.sql}
        ON CONFLICT(workstream_id, entity_canonical)
        DO UPDATE SET session_count = session_count + excluded.session_count
      `).run(intoId, fromId, unionTc.param);
      const deleteTc = tenantClause(tenantId);
      this.db.prepare(`DELETE FROM workstream_entities WHERE workstream_id = ? AND ${deleteTc.sql}`).run(fromId, deleteTc.param);
    });
    tx();
  }

  async upsertEntities(tenantId: string, workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count, tenant_id)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(workstream_id, entity_canonical)
      DO UPDATE SET session_count = session_count + 1
    `);
    const tx = this.db.transaction((names: ReadonlyArray<string>) => {
      for (const n of names) { const e = n.trim(); if (e) stmt.run(workstreamId, e, tenantId); }
    });
    tx(entities);
  }

  async entitiesFor(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const rows = this.db.prepare<unknown[], { workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph}) AND ${tc.sql}`,
    ).all(...workstreamIds, tc.param);
    for (const r of rows) {
      const list = out.get(r.workstream_id);
      if (list) list.push(r.entity_canonical); else out.set(r.workstream_id, [r.entity_canonical]);
    }
    return out;
  }

  async candidatesByEntityOverlap(tenantId: string, entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const ids = this.db.prepare<unknown[], { workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph}) AND ${tc.sql}
       GROUP BY workstream_id ORDER BY overlap DESC LIMIT ?`,
    ).all(...names, tc.param, limit).map((r) => r.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(tenantId, ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
