/**
 * PgEntityStore -- EntityStore implementation over pg.Pool.
 *
 * All merge operations run inside a single pg transaction.
 *
 * Tenancy: mirrors SqliteEntityStore — merge takes tenantId as its
 * non-optional first parameter and routes every STAMP-table WHERE fragment
 * through tenantClausePg. entities/entity_variants carry a composite PK
 * (tenant_id, canonical/variant).
 */

import type { Pool } from "pg";
import type { EntityStore } from "@ports/entity-store.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

export class PgEntityStore implements EntityStore {
  constructor(private readonly pool: Pool) {}

  async merge(tenantId: string, source: string, target: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const targetTc = tenantClausePg(tenantId, 2);
      const targetRes = await client.query<{ status: string }>(
        `SELECT status FROM entities WHERE canonical = $1 AND ${targetTc.sql}`,
        [target, targetTc.param],
      );
      if (targetRes.rowCount === 0) {
        throw new Error(`merge: target entity not found: ${target}`);
      }
      if (targetRes.rows[0]!.status === "retired") {
        throw new Error(`merge: target entity is retired: ${target}`);
      }

      const sourceTc = tenantClausePg(tenantId, 2);
      const sourceRes = await client.query<{ status: string }>(
        `SELECT status FROM entities WHERE canonical = $1 AND ${sourceTc.sql}`,
        [source, sourceTc.param],
      );
      if (sourceRes.rowCount === 0) {
        throw new Error(`merge: source entity not found: ${source}`);
      }

      // Step 1: copy source session_entities to target, dedup on composite PK.
      const copyTc = tenantClausePg(tenantId, 3);
      await client.query(
        `INSERT INTO session_entities (tenant_id, session_id, entity_canonical)
         SELECT $3, session_id, $1 FROM session_entities WHERE entity_canonical = $2 AND ${copyTc.sql}
         ON CONFLICT DO NOTHING`,
        [target, source, copyTc.param],
      );

      // Step 2: delete source's session_entities rows.
      const deleteEntTc = tenantClausePg(tenantId, 2);
      await client.query(
        `DELETE FROM session_entities WHERE entity_canonical = $1 AND ${deleteEntTc.sql}`,
        [source, deleteEntTc.param],
      );

      // Step 3: recompute target.session_count exactly from session_entities.
      const countTc = tenantClausePg(tenantId, 2);
      await client.query(
        `UPDATE entities
           SET session_count = (SELECT COUNT(*) FROM session_entities WHERE entity_canonical = $1 AND ${countTc.sql}),
               updated_at    = NOW()
         WHERE canonical = $1 AND ${countTc.sql}`,
        [target, countTc.param],
      );

      // Step 4: widen first_seen_session / last_seen_session.
      // first_seen and last_seen are session IDs (text FK to sessions.id).
      // Join to sessions to order by started_at and pick earliest / latest.
      const seenTc = tenantClausePg(tenantId, 2);
      const seenRes = await client.query<{ id: string; started_at: string }>(
        `SELECT id, started_at FROM sessions
         WHERE id IN (
           SELECT first_seen_session FROM entities WHERE canonical = ANY($1) AND ${seenTc.sql}
           UNION
           SELECT last_seen_session  FROM entities WHERE canonical = ANY($1) AND ${seenTc.sql}
         )`,
        [[source, target], seenTc.param],
      );

      if (seenRes.rows.length > 0) {
        const sorted = seenRes.rows.slice().sort((a, b) => a.started_at.localeCompare(b.started_at));
        const earliest = sorted[0]!.id;
        const latest = sorted[sorted.length - 1]!.id;
        const widenTc = tenantClausePg(tenantId, 4);
        await client.query(
          `UPDATE entities
             SET first_seen_session = $1,
                 last_seen_session  = $2,
                 updated_at         = NOW()
           WHERE canonical = $3 AND ${widenTc.sql}`,
          [earliest, latest, target, widenTc.param],
        );
      }

      // Step 5: insert the variant record so future ingest resolves source -> target.
      await client.query(
        `INSERT INTO entity_variants (tenant_id, variant, canonical, source_session_id)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT DO NOTHING`,
        [tenantId, source, target],
      );

      // Step 6: re-point existing variants of source to target.
      const repointTc = tenantClausePg(tenantId, 3);
      await client.query(
        `UPDATE entity_variants SET canonical = $1 WHERE canonical = $2 AND variant != $2 AND ${repointTc.sql}`,
        [target, source, repointTc.param],
      );

      // Step 7: retire the source entity row in place.
      const retireTc = tenantClausePg(tenantId, 2);
      await client.query(
        `UPDATE entities
           SET status        = 'retired',
               session_count = 0,
               updated_at    = NOW()
         WHERE canonical = $1 AND ${retireTc.sql}`,
        [source, retireTc.param],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
