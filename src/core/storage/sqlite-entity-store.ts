/**
 * SqliteEntityStore -- EntityStore implementation over better-sqlite3.
 *
 * All merge operations run inside a single synchronous transaction so
 * the database is never left in a partially-merged state.
 *
 * Tenancy (program spec §4, M2 plan Wave B4): entities/entity_variants carry
 * a composite PK (tenant_id, canonical/variant); session_entities and
 * workstream_entities are stamped too. merge takes tenantId as its
 * non-optional first parameter and resolves source/target within that
 * tenant only — every SELECT/UPDATE/DELETE routes its WHERE fragment
 * through tenantClause.
 */

import type Database from "better-sqlite3";
import type { EntityStore } from "@ports/entity-store.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

type EntityStatusRow = { status: string };
type SessionDateRow = { id: string; started_at: string };
type VariantRow = { variant: string };

export class SqliteEntityStore implements EntityStore {
  constructor(private readonly db: Database.Database) {}

  async merge(tenantId: string, source: string, target: string): Promise<void> {
    const txn = this.db.transaction(() => {
      const targetTc = tenantClause(tenantId);
      const targetRow = this.db
        .prepare<unknown[], EntityStatusRow>(`SELECT status FROM entities WHERE canonical = ? AND ${targetTc.sql}`)
        .get(target, targetTc.param);
      if (!targetRow) throw new Error(`merge: target entity not found: ${target}`);
      if (targetRow.status === "retired") {
        throw new Error(`merge: target entity is retired: ${target}`);
      }

      const sourceTc = tenantClause(tenantId);
      const sourceRow = this.db
        .prepare<unknown[], EntityStatusRow>(`SELECT status FROM entities WHERE canonical = ? AND ${sourceTc.sql}`)
        .get(source, sourceTc.param);
      if (!sourceRow) throw new Error(`merge: source entity not found: ${source}`);

      // Step 1: copy source session_entities to target, dedup on composite PK.
      const copyTc = tenantClause(tenantId);
      this.db
        .prepare<unknown[]>(
          `INSERT OR IGNORE INTO session_entities (tenant_id, session_id, entity_canonical)
           SELECT ?, session_id, ? FROM session_entities WHERE entity_canonical = ? AND ${copyTc.sql}`,
        )
        .run(tenantId, target, source, copyTc.param);

      // Step 2: delete source's session_entities rows.
      const deleteEntTc = tenantClause(tenantId);
      this.db
        .prepare<unknown[]>(`DELETE FROM session_entities WHERE entity_canonical = ? AND ${deleteEntTc.sql}`)
        .run(source, deleteEntTc.param);

      // Step 3: recompute target.session_count exactly from session_entities.
      const countInnerTc = tenantClause(tenantId);
      const countOuterTc = tenantClause(tenantId);
      this.db
        .prepare<unknown[]>(
          `UPDATE entities
             SET session_count = (SELECT COUNT(*) FROM session_entities WHERE entity_canonical = ? AND ${countInnerTc.sql}),
                 updated_at    = datetime('now')
           WHERE canonical = ? AND ${countOuterTc.sql}`,
        )
        .run(target, countInnerTc.param, target, countOuterTc.param);

      // Step 4: widen first_seen_session / last_seen_session.
      // first_seen and last_seen are session IDs (text), not timestamps.
      // We use sessions.started_at to order them chronologically and pick
      // the earliest / latest. This is correct as long as session IDs are
      // stable references (they are -- FK to sessions(id)).
      const seenTc = tenantClause(tenantId, "e.tenant_id");
      const bothSeenSessions = this.db
        .prepare<unknown[], SessionDateRow>(
          `SELECT id, started_at FROM sessions
           WHERE id IN (
             SELECT first_seen_session FROM entities e WHERE canonical IN (?, ?) AND ${seenTc.sql}
             UNION
             SELECT last_seen_session  FROM entities e WHERE canonical IN (?, ?) AND ${seenTc.sql}
           )`,
        )
        .all(source, target, seenTc.param, source, target, seenTc.param);

      if (bothSeenSessions.length > 0) {
        bothSeenSessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
        const earliest = bothSeenSessions[0]!.id;
        const latest = bothSeenSessions[bothSeenSessions.length - 1]!.id;
        const widenTc = tenantClause(tenantId);
        this.db
          .prepare<unknown[]>(
            `UPDATE entities
               SET first_seen_session = ?,
                   last_seen_session  = ?,
                   updated_at         = datetime('now')
             WHERE canonical = ? AND ${widenTc.sql}`,
          )
          .run(earliest, latest, target, widenTc.param);
      }

      // Step 5: insert the variant record so future ingest resolves source -> target.
      this.db
        .prepare<unknown[]>(
          `INSERT OR IGNORE INTO entity_variants (tenant_id, variant, canonical, source_session_id)
           VALUES (?, ?, ?, NULL)`,
        )
        .run(tenantId, source, target);

      // Step 6: re-point existing variants of source to target.
      const listVariantsTc = tenantClause(tenantId);
      const sourceVariants = this.db
        .prepare<unknown[], VariantRow>(
          `SELECT variant FROM entity_variants WHERE canonical = ? AND ${listVariantsTc.sql}`,
        )
        .all(source, listVariantsTc.param);

      for (const { variant } of sourceVariants) {
        if (variant === source) continue;
        const repointTc = tenantClause(tenantId);
        this.db
          .prepare<unknown[]>(
            `UPDATE entity_variants SET canonical = ? WHERE variant = ? AND ${repointTc.sql}`,
          )
          .run(target, variant, repointTc.param);
      }

      // Step 7: retire the source entity row in place.
      const retireTc = tenantClause(tenantId);
      this.db
        .prepare<unknown[]>(
          `UPDATE entities
             SET status        = 'retired',
                 session_count = 0,
                 updated_at    = datetime('now')
           WHERE canonical = ? AND ${retireTc.sql}`,
        )
        .run(source, retireTc.param);
    });

    txn();
  }
}
