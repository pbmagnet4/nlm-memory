/**
 * SqliteFactStore — the canonical FactStore implementation, sharing the same
 * better-sqlite3 connection as SqliteSessionStore so session+facts ingest can
 * commit in one transaction (Section 5 of factstore-design.md).
 *
 * Constructor takes an already-opened, already-migrated Database handle from
 * SqliteSessionStore.rawDb(). It does not open its own connection. This is
 * the only way to get a single-writer SQLite to behave atomically across
 * both stores without WAL ordering surprises.
 *
 * Phase B.1 surface: insert, getById, findCurrent, list, listBySession,
 * markSuperseded. No semantic search (Phase B.3), no extraction wiring
 * (Phase B.2), no auto-supersedence (Phase B.4).
 */

import type Database from "better-sqlite3";
import type { FactQuery, FactStore } from "@ports/fact-store.js";
import type { Fact, FactKind } from "@shared/types.js";

type FactRow = {
  id: string;
  kind: FactKind;
  subject: string;
  predicate: string;
  value: string;
  source_session_id: string;
  source_quote: string | null;
  created_at: string;
  superseded_by: string | null;
  confidence: number;
};

export class SqliteFactStore implements FactStore {
  constructor(private readonly db: Database.Database) {}

  async insert(fact: Fact): Promise<void> {
    this.insertStmt().run(this.toRow(fact));
  }

  async insertMany(facts: ReadonlyArray<Fact>): Promise<void> {
    if (facts.length === 0) return;
    const stmt = this.insertStmt();
    const txn = this.db.transaction((rows: ReadonlyArray<FactRow>) => {
      for (const row of rows) stmt.run(row);
    });
    txn(facts.map((f) => this.toRow(f)));
  }

  /**
   * Insert facts inside an already-open transaction (no own txn opened).
   * Callable only from code that has already begun a transaction on the same
   * connection — currently SqliteSessionStore.insertSession. Phase B.2: this
   * is how session+facts ingest commits atomically (Section 5 of the plan).
   */
  insertManyInTxn(facts: ReadonlyArray<Fact>): void {
    if (facts.length === 0) return;
    const stmt = this.insertStmt();
    for (const f of facts) stmt.run(this.toRow(f));
  }

  async getById(id: string): Promise<Fact | null> {
    const row = this.db
      .prepare<[string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts WHERE id = ?`,
      )
      .get(id);
    return row ? this.rowToFact(row) : null;
  }

  async findCurrent(subject: string, predicate: string): Promise<Fact | null> {
    const row = this.db
      .prepare<[string, string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ? AND predicate = ? AND superseded_by IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(subject, predicate);
    return row ? this.rowToFact(row) : null;
  }

  async list(query: FactQuery): Promise<ReadonlyArray<Fact>> {
    const limit = Math.max(1, Math.trunc(query.limit ?? 50));
    const includeSuperseded = query.includeSuperseded === true;

    const where: string[] = ["subject = ?"];
    const params: Array<string | number> = [query.subject];
    if (query.predicate !== undefined) {
      where.push("predicate = ?");
      params.push(query.predicate);
    }
    if (!includeSuperseded) where.push("superseded_by IS NULL");
    params.push(limit);

    const rows = this.db
      .prepare<Array<string | number>, FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => this.rowToFact(r));
  }

  async listBySession(sessionId: string): Promise<ReadonlyArray<Fact>> {
    const rows = this.db
      .prepare<[string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE source_session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId);
    return rows.map((r) => this.rowToFact(r));
  }

  async markSuperseded(oldId: string, newId: string | null): Promise<void> {
    if (newId !== null && oldId === newId) {
      throw new Error("A fact cannot supersede itself");
    }
    const txn = this.db.transaction(() => {
      const old = this.db
        .prepare<[string], { id: string }>("SELECT id FROM facts WHERE id = ?")
        .get(oldId);
      if (!old) throw new Error(`Fact ${oldId} not found`);
      if (newId !== null) {
        const next = this.db
          .prepare<[string], { id: string }>("SELECT id FROM facts WHERE id = ?")
          .get(newId);
        if (!next) throw new Error(`Fact ${newId} not found`);
      }
      this.db
        .prepare("UPDATE facts SET superseded_by = ? WHERE id = ?")
        .run(newId, oldId);
    });
    txn();
  }

  private insertStmt() {
    return this.db.prepare<FactRow>(`
      INSERT INTO facts (
        id, kind, subject, predicate, value, source_session_id,
        source_quote, created_at, superseded_by, confidence
      ) VALUES (
        @id, @kind, @subject, @predicate, @value, @source_session_id,
        @source_quote, @created_at, @superseded_by, @confidence
      )
    `);
  }

  private toRow(fact: Fact): FactRow {
    return {
      id: fact.id,
      kind: fact.kind,
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      source_session_id: fact.sourceSessionId,
      source_quote: fact.sourceQuote,
      created_at: fact.createdAt,
      superseded_by: fact.supersededBy,
      confidence: fact.confidence,
    };
  }

  private rowToFact(row: FactRow): Fact {
    return {
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      predicate: row.predicate,
      value: row.value,
      sourceSessionId: row.source_session_id,
      sourceQuote: row.source_quote,
      createdAt: row.created_at,
      supersededBy: row.superseded_by,
      confidence: row.confidence,
    };
  }
}
