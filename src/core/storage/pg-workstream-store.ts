import type { Pool } from "pg";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
};

const rowToWorkstream = (r: WsRow): Workstream => ({
  id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
  createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
});

export class PgWorkstreamStore implements WorkstreamStore {
  constructor(private readonly pool: Pool) {}

  async create(input: { id: string; label: string }): Promise<Workstream> {
    await this.pool.query("INSERT INTO workstreams (id, label) VALUES ($1, $2)", [input.id, input.label]);
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<Workstream | null> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams WHERE id = $1", [id]);
    return r.rows[0] ? rowToWorkstream(r.rows[0]) : null;
  }

  async findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams");
    const hit = r.rows.find((row) => normalizeLabel(row.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }

  async listAll(): Promise<ReadonlyArray<Workstream>> {
    const r = await this.pool.query<WsRow>("SELECT * FROM workstreams");
    return r.rows.map(rowToWorkstream);
  }

  async touchLastSession(id: string, atIso: string): Promise<void> {
    await this.pool.query("UPDATE workstreams SET last_session_at = $1, updated_at = NOW() WHERE id = $2", [atIso, id]);
  }

  async setLabel(id: string, label: string): Promise<void> {
    await this.pool.query("UPDATE workstreams SET label = $1, updated_at = NOW() WHERE id = $2", [label, id]);
  }

  async setStatus(id: string, status: Workstream["status"]): Promise<void> {
    await this.pool.query("UPDATE workstreams SET status = $1, updated_at = NOW() WHERE id = $2", [status, id]);
  }

  async merge(fromId: string, intoId: string): Promise<void> {
    // Pointer first (source of truth for resolution), then derived entity union, then clear.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE workstreams SET merged_into = $1, status = 'merged', updated_at = NOW() WHERE id = $2",
        [intoId, fromId],
      );
      await client.query(
        `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
         SELECT $1, entity_canonical, session_count FROM workstream_entities WHERE workstream_id = $2
         ON CONFLICT (workstream_id, entity_canonical)
         DO UPDATE SET session_count = workstream_entities.session_count + excluded.session_count`,
        [intoId, fromId],
      );
      await client.query("DELETE FROM workstream_entities WHERE workstream_id = $1", [fromId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    for (const raw of entities) {
      const e = raw.trim(); if (!e) continue;
      await this.pool.query(
        `INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count) VALUES ($1, $2, 1)
         ON CONFLICT (workstream_id, entity_canonical) DO UPDATE SET session_count = workstream_entities.session_count + 1`,
        [workstreamId, e],
      );
    }
  }

  async entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pool.query<{ workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph})`, [...workstreamIds],
    );
    for (const row of r.rows) {
      const list = out.get(row.workstream_id);
      if (list) list.push(row.entity_canonical); else out.set(row.workstream_id, [row.entity_canonical]);
    }
    return out;
  }

  async candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map((_, i) => `$${i + 1}`).join(",");
    const r = await this.pool.query<{ workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph}) GROUP BY workstream_id ORDER BY overlap DESC LIMIT $${names.length + 1}`,
      [...names, limit],
    );
    const ids = r.rows.map((row) => row.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
