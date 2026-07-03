/**
 * SqliteEntityStore -- EntityStore implementation over better-sqlite3.
 *
 * All merge operations run inside a single synchronous transaction so
 * the database is never left in a partially-merged state.
 */

import type Database from "better-sqlite3";
import type { EntityStore } from "@ports/entity-store.js";

type EntityStatusRow = { status: string };
type SessionDateRow = { id: string; started_at: string };
type VariantRow = { variant: string };

export class SqliteEntityStore implements EntityStore {
  constructor(private readonly db: Database.Database) {}

  async merge(source: string, target: string): Promise<void> {
    const txn = this.db.transaction(() => {
      const targetRow = this.db
        .prepare<[string], EntityStatusRow>("SELECT status FROM entities WHERE canonical = ?")
        .get(target);
      if (!targetRow) throw new Error(`merge: target entity not found: ${target}`);
      if (targetRow.status === "retired") {
        throw new Error(`merge: target entity is retired: ${target}`);
      }

      const sourceRow = this.db
        .prepare<[string], EntityStatusRow>("SELECT status FROM entities WHERE canonical = ?")
        .get(source);
      if (!sourceRow) throw new Error(`merge: source entity not found: ${source}`);

      // Step 1: copy source session_entities to target, dedup on composite PK.
      this.db
        .prepare<[string, string]>(
          `INSERT OR IGNORE INTO session_entities (session_id, entity_canonical)
           SELECT session_id, ? FROM session_entities WHERE entity_canonical = ?`,
        )
        .run(target, source);

      // Step 2: delete source's session_entities rows.
      this.db
        .prepare<[string]>("DELETE FROM session_entities WHERE entity_canonical = ?")
        .run(source);

      // Step 3: recompute target.session_count exactly from session_entities.
      this.db
        .prepare<[string, string]>(
          `UPDATE entities
             SET session_count = (SELECT COUNT(*) FROM session_entities WHERE entity_canonical = ?),
                 updated_at    = datetime('now')
           WHERE canonical = ?`,
        )
        .run(target, target);

      // Step 4: widen first_seen_session / last_seen_session.
      // first_seen and last_seen are session IDs (text), not timestamps.
      // We use sessions.started_at to order them chronologically and pick
      // the earliest / latest. This is correct as long as session IDs are
      // stable references (they are -- FK to sessions(id)).
      const bothSeenSessions = this.db
        .prepare<[string, string, string, string], SessionDateRow>(
          `SELECT id, started_at FROM sessions
           WHERE id IN (
             SELECT first_seen_session FROM entities WHERE canonical IN (?, ?)
             UNION
             SELECT last_seen_session  FROM entities WHERE canonical IN (?, ?)
           )`,
        )
        .all(source, target, source, target);

      if (bothSeenSessions.length > 0) {
        bothSeenSessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
        const earliest = bothSeenSessions[0]!.id;
        const latest = bothSeenSessions[bothSeenSessions.length - 1]!.id;
        this.db
          .prepare<[string, string, string]>(
            `UPDATE entities
               SET first_seen_session = ?,
                   last_seen_session  = ?,
                   updated_at         = datetime('now')
             WHERE canonical = ?`,
          )
          .run(earliest, latest, target);
      }

      // Step 5: insert the variant record so future ingest resolves source -> target.
      this.db
        .prepare<[string, string]>(
          `INSERT OR IGNORE INTO entity_variants (variant, canonical, source_session_id)
           VALUES (?, ?, NULL)`,
        )
        .run(source, target);

      // Step 6: re-point existing variants of source to target.
      const sourceVariants = this.db
        .prepare<[string], VariantRow>(
          "SELECT variant FROM entity_variants WHERE canonical = ?",
        )
        .all(source);

      for (const { variant } of sourceVariants) {
        if (variant === source) continue;
        this.db
          .prepare<[string, string]>(
            "UPDATE entity_variants SET canonical = ? WHERE variant = ?",
          )
          .run(target, variant);
      }

      // Step 7: retire the source entity row in place.
      this.db
        .prepare<[string]>(
          `UPDATE entities
             SET status        = 'retired',
                 session_count = 0,
                 updated_at    = datetime('now')
           WHERE canonical = ?`,
        )
        .run(source);
    });

    txn();
  }
}
