import type Database from "better-sqlite3";
import type { WorkstreamStore } from "@ports/workstream-store.js";
import { type Workstream, normalizeLabel } from "@core/workstream/model.js";

type WsRow = {
  id: string; label: string; status: Workstream["status"];
  merged_into: string | null; created_at: string; updated_at: string; last_session_at: string | null;
};

function rowToWorkstream(r: WsRow): Workstream {
  return {
    id: r.id, label: r.label, status: r.status, mergedInto: r.merged_into,
    createdAt: r.created_at, updatedAt: r.updated_at, lastSessionAt: r.last_session_at,
  };
}

export class SqliteWorkstreamStore implements WorkstreamStore {
  constructor(private readonly db: Database.Database) {}

  async create(input: { id: string; label: string }): Promise<Workstream> {
    this.db.prepare("INSERT INTO workstreams (id, label) VALUES (?, ?)").run(input.id, input.label);
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<Workstream | null> {
    const r = this.db.prepare<[string], WsRow>("SELECT * FROM workstreams WHERE id = ?").get(id);
    return r ? rowToWorkstream(r) : null;
  }

  async findByNormalizedLabel(normalizedLabel: string): Promise<Workstream | null> {
    // Small set; normalize in JS to match normalizeLabel semantics exactly.
    const rows = this.db.prepare<[], WsRow>("SELECT * FROM workstreams").all();
    const hit = rows.find((r) => normalizeLabel(r.label) === normalizedLabel);
    return hit ? rowToWorkstream(hit) : null;
  }

  async listAll(): Promise<ReadonlyArray<Workstream>> {
    return this.db.prepare<[], WsRow>("SELECT * FROM workstreams").all().map(rowToWorkstream);
  }

  async touchLastSession(id: string, atIso: string): Promise<void> {
    this.db.prepare("UPDATE workstreams SET last_session_at = ?, updated_at = datetime('now') WHERE id = ?").run(atIso, id);
  }

  async setLabel(id: string, label: string): Promise<void> {
    this.db.prepare("UPDATE workstreams SET label = ?, updated_at = datetime('now') WHERE id = ?").run(label, id);
  }

  async setStatus(id: string, status: Workstream["status"]): Promise<void> {
    this.db.prepare("UPDATE workstreams SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }

  async merge(fromId: string, intoId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        "UPDATE workstreams SET merged_into = ?, status = 'merged', updated_at = datetime('now') WHERE id = ?",
      ).run(intoId, fromId);
      // Union from's entities into into (sum session_count on PK conflict).
      this.db.prepare(`
        INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
        SELECT ?, entity_canonical, session_count FROM workstream_entities WHERE workstream_id = ?
        ON CONFLICT(workstream_id, entity_canonical)
        DO UPDATE SET session_count = session_count + excluded.session_count
      `).run(intoId, fromId);
      this.db.prepare("DELETE FROM workstream_entities WHERE workstream_id = ?").run(fromId);
    });
    tx();
  }

  async upsertEntities(workstreamId: string, entities: ReadonlyArray<string>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO workstream_entities (workstream_id, entity_canonical, session_count)
      VALUES (?, ?, 1)
      ON CONFLICT(workstream_id, entity_canonical)
      DO UPDATE SET session_count = session_count + 1
    `);
    const tx = this.db.transaction((names: ReadonlyArray<string>) => {
      for (const n of names) { const e = n.trim(); if (e) stmt.run(workstreamId, e); }
    });
    tx(entities);
  }

  async entitiesFor(workstreamIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (workstreamIds.length === 0) return out;
    const ph = workstreamIds.map(() => "?").join(",");
    const rows = this.db.prepare<string[], { workstream_id: string; entity_canonical: string }>(
      `SELECT workstream_id, entity_canonical FROM workstream_entities WHERE workstream_id IN (${ph})`,
    ).all(...workstreamIds);
    for (const r of rows) {
      const list = out.get(r.workstream_id);
      if (list) list.push(r.entity_canonical); else out.set(r.workstream_id, [r.entity_canonical]);
    }
    return out;
  }

  async candidatesByEntityOverlap(entities: ReadonlyArray<string>, limit: number): Promise<ReadonlyArray<{ workstreamId: string; entities: string[] }>> {
    const names = entities.map((e) => e.trim()).filter(Boolean);
    if (names.length === 0) return [];
    const ph = names.map(() => "?").join(",");
    const ids = this.db.prepare<(string | number)[], { workstream_id: string }>(
      `SELECT workstream_id, COUNT(*) AS overlap FROM workstream_entities
       WHERE entity_canonical IN (${ph})
       GROUP BY workstream_id ORDER BY overlap DESC LIMIT ?`,
    ).all(...names, limit).map((r) => r.workstream_id);
    if (ids.length === 0) return [];
    const map = await this.entitiesFor(ids);
    return ids.map((id) => ({ workstreamId: id, entities: map.get(id) ?? [] }));
  }
}
