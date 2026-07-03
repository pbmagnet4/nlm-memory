/**
 * PgEntityStore -- EntityStore implementation over pg.Pool.
 *
 * All merge operations run inside a single pg transaction.
 */

import type { Pool } from "pg";
import type { EntityStore } from "@ports/entity-store.js";

export class PgEntityStore implements EntityStore {
  constructor(private readonly pool: Pool) {}

  async merge(source: string, target: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const targetRes = await client.query<{ status: string }>(
        "SELECT status FROM entities WHERE canonical = $1",
        [target],
      );
      if (targetRes.rowCount === 0) {
        throw new Error(`merge: target entity not found: ${target}`);
      }
      if (targetRes.rows[0]!.status === "retired") {
        throw new Error(`merge: target entity is retired: ${target}`);
      }

      const sourceRes = await client.query<{ status: string }>(
        "SELECT status FROM entities WHERE canonical = $1",
        [source],
      );
      if (sourceRes.rowCount === 0) {
        throw new Error(`merge: source entity not found: ${source}`);
      }

      // Step 1: copy source session_entities to target, dedup on composite PK.
      await client.query(
        `INSERT INTO session_entities (session_id, entity_canonical)
         SELECT session_id, $1 FROM session_entities WHERE entity_canonical = $2
         ON CONFLICT DO NOTHING`,
        [target, source],
      );

      // Step 2: delete source's session_entities rows.
      await client.query(
        "DELETE FROM session_entities WHERE entity_canonical = $1",
        [source],
      );

      // Step 3: recompute target.session_count exactly from session_entities.
      await client.query(
        `UPDATE entities
           SET session_count = (SELECT COUNT(*) FROM session_entities WHERE entity_canonical = $1),
               updated_at    = NOW()
         WHERE canonical = $1`,
        [target],
      );

      // Step 4: widen first_seen_session / last_seen_session.
      // first_seen and last_seen are session IDs (text FK to sessions.id).
      // Join to sessions to order by started_at and pick earliest / latest.
      const seenRes = await client.query<{ id: string; started_at: string }>(
        `SELECT id, started_at FROM sessions
         WHERE id IN (
           SELECT first_seen_session FROM entities WHERE canonical = ANY($1)
           UNION
           SELECT last_seen_session  FROM entities WHERE canonical = ANY($1)
         ) AND id IS NOT NULL`,
        [[source, target]],
      );

      if (seenRes.rows.length > 0) {
        const sorted = seenRes.rows.slice().sort((a, b) => a.started_at.localeCompare(b.started_at));
        const earliest = sorted[0]!.id;
        const latest = sorted[sorted.length - 1]!.id;
        await client.query(
          `UPDATE entities
             SET first_seen_session = $1,
                 last_seen_session  = $2,
                 updated_at         = NOW()
           WHERE canonical = $3`,
          [earliest, latest, target],
        );
      }

      // Step 5: insert the variant record so future ingest resolves source -> target.
      await client.query(
        `INSERT INTO entity_variants (variant, canonical, source_session_id)
         VALUES ($1, $2, NULL)
         ON CONFLICT DO NOTHING`,
        [source, target],
      );

      // Step 6: re-point existing variants of source to target.
      await client.query(
        `UPDATE entity_variants SET canonical = $1 WHERE canonical = $2 AND variant != $2`,
        [target, source],
      );

      // Step 7: retire the source entity row in place.
      await client.query(
        `UPDATE entities
           SET status        = 'retired',
               session_count = 0,
               updated_at    = NOW()
         WHERE canonical = $1`,
        [source],
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
