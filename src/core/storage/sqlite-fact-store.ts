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
 * Surface evolution:
 *   B.1 — insert, getById, findCurrent, list, listBySession, markSuperseded
 *   B.2: ingestSessionFacts (atomic session+facts ingest), embedding write helper
 *   B.3 — listForRecall (pre-filter for FactRecallService), semanticSearch,
 *         getHistory (supersedence chain inspection)
 *   B.4 — auto-supersedence on (subject, predicate) collision (deferred)
 *
 * Tenancy (program spec §4, M2 plan Wave B): every method takes `tenantId`
 * as its non-optional first parameter. `facts` is a STAMP table; every
 * SELECT/UPDATE/DELETE routes its WHERE fragment through `tenantClause`,
 * and INSERTs stamp `tenant_id` explicitly. `fact_embeddings` carries no
 * tenant_id (DERIVE-VIA-FK, keyed by fact_id) — `semanticSearch`'s KNN scan
 * has no tenant awareness of its own, so callers (FactRecallService) resolve
 * neighbor ids back through the tenant-filtered `getByIds`/`getById` before
 * trusting them (program spec §4.3, vector-path rule).
 */

type NeighborRow = { fact_id: string; distance: number };

import type Database from "better-sqlite3";
import type {
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
} from "@ports/fact-store.js";
import type { Fact, FactHistoryChain, FactKind } from "@shared/types.js";
import { batchWinners } from "./fact-batch.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

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
  retired_at?: string | null;
  scope: string | null;
  tenant_id?: string;
};

export class SqliteFactStore implements FactStore {
  /**
   * @internal. Construct via SqliteStorage.create(...) instead. Direct
   * construction is preserved for the SqliteStorage adapter only; all
   * other callers should reach FactStore via storage.facts.
   */
  constructor(private readonly db: Database.Database) {}

  private cachedInsertStmt: Database.Statement<FactRow> | undefined;

  async insert(tenantId: string, fact: Fact): Promise<void> {
    this.insertStmt().run(this.toRow(fact, null, tenantId));
  }

  async insertMany(tenantId: string, facts: ReadonlyArray<Fact>): Promise<void> {
    if (facts.length === 0) return;
    const stmt = this.insertStmt();
    const txn = this.db.transaction((rows: ReadonlyArray<FactRow>) => {
      for (const row of rows) stmt.run(row);
    });
    txn(facts.map((f) => this.toRow(f, null, tenantId)));
  }

  async getById(tenantId: string, id: string): Promise<Fact | null> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare<[string, string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts WHERE id = ? AND ${tc.sql}`,
      )
      .get(id, tc.param);
    return row ? this.rowToFact(row) : null;
  }

  async getByIds(tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare<unknown[], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts WHERE id IN (${placeholders}) AND ${tc.sql}`,
      )
      .all(...ids, tc.param);
    return rows.map((r) => this.rowToFact(r));
  }

  async findCurrent(tenantId: string, subject: string, predicate: string): Promise<Fact | null> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare<[string, string, string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts
         WHERE subject = ? AND predicate = ? AND superseded_by IS NULL AND retired_at IS NULL AND ${tc.sql}
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(subject, predicate, tc.param);
    return row ? this.rowToFact(row) : null;
  }

  async list(tenantId: string, query: FactQuery): Promise<ReadonlyArray<Fact>> {
    const limit = Math.max(1, Math.trunc(query.limit ?? 50));
    const includeSuperseded = query.includeSuperseded === true;

    const tc = tenantClause(tenantId);
    const where: string[] = ["subject = ?", tc.sql];
    const params: Array<string | number> = [query.subject, tc.param];
    if (query.predicate !== undefined) {
      where.push("predicate = ?");
      params.push(query.predicate);
    }
    if (!includeSuperseded) {
      where.push("superseded_by IS NULL");
      where.push("retired_at IS NULL");
    }
    params.push(limit);

    const rows = this.db
      .prepare<Array<string | number>, FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => this.rowToFact(r));
  }

  async listBySession(tenantId: string, sessionId: string): Promise<ReadonlyArray<Fact>> {
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare<[string, string], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts
         WHERE source_session_id = ? AND ${tc.sql}
         ORDER BY created_at ASC`,
      )
      .all(sessionId, tc.param);
    return rows.map((r) => this.rowToFact(r));
  }

  async listBySessions(tenantId: string, sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>> {
    if (sessionIds.length === 0) return [];
    const ph = sessionIds.map(() => "?").join(",");
    const filter = opts?.includeSuperseded === true ? "" : " AND superseded_by IS NULL AND retired_at IS NULL";
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare<unknown[], FactRow>(
        `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence, retired_at
         FROM facts WHERE source_session_id IN (${ph}) AND ${tc.sql}${filter} ORDER BY created_at ASC`,
      )
      .all(...sessionIds, tc.param);
    return rows.map((r) => this.rowToFact(r));
  }

  async listForRecall(tenantId: string, filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    const tc = tenantClause(tenantId);
    const where: string[] = [tc.sql];
    const params: Array<string | number> = [tc.param];
    if (filter.subject !== undefined) {
      where.push("subject = ?");
      params.push(filter.subject);
    }
    if (filter.predicate !== undefined) {
      where.push("predicate = ?");
      params.push(filter.predicate);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.minConfidence !== undefined) {
      where.push("confidence >= ?");
      params.push(filter.minConfidence);
    }
    if (filter.includeSuperseded !== true) {
      where.push("superseded_by IS NULL");
      where.push("retired_at IS NULL");
    }
    const limit = Math.max(1, Math.trunc(filter.limit ?? 500));
    params.push(limit);
    const sql = `
      SELECT id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence, retired_at
      FROM facts
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    const rows = this.db
      .prepare<Array<string | number>, FactRow>(sql)
      .all(...params);
    return rows.map((r) => this.rowToFact(r));
  }

  async semanticSearch(
    tenantId: string,
    queryVector: Float32Array,
    limit: number,
  ): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    const k = Math.max(1, Math.trunc(limit));
    const blob = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );
    // fact_embeddings carries no tenant_id (DERIVE-VIA-FK) — the KNN scan
    // returns neighbors from the whole corpus. Re-resolve candidate ids
    // against the tenant-filtered `facts` table before returning, per the
    // vector-path rule (program spec §4.3): a neighbor whose fact doesn't
    // resolve within the caller's tenant is dropped, not down-ranked.
    const overfetchK = k * 4;
    const rows = this.db
      .prepare<[Buffer, number], NeighborRow>(`
        SELECT fact_id, distance
        FROM fact_embeddings
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `)
      .all(blob, overfetchK);
    if (rows.length === 0) return [];
    const candidateIds = [...new Set(rows.map((r) => r.fact_id))];
    const placeholders = candidateIds.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const resolvedRows = this.db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM facts WHERE id IN (${placeholders}) AND ${tc.sql}`,
      )
      .all(...candidateIds, tc.param);
    const resolved = new Set(resolvedRows.map((r) => r.id));
    return rows
      .filter((r) => resolved.has(r.fact_id))
      .slice(0, k)
      .map((r) => ({ factId: r.fact_id, distance: r.distance }));
  }

  async getHistory(
    tenantId: string,
    subject: string,
    predicate?: string,
  ): Promise<ReadonlyArray<FactHistoryChain>> {
    const tc = tenantClause(tenantId);
    const sql = predicate
      ? `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ? AND predicate = ? AND ${tc.sql}
         ORDER BY predicate ASC, created_at DESC`
      : `SELECT id, kind, subject, predicate, value, source_session_id,
                source_quote, created_at, superseded_by, confidence
         FROM facts
         WHERE subject = ? AND ${tc.sql}
         ORDER BY predicate ASC, created_at DESC`;
    const rows = predicate
      ? this.db.prepare<[string, string, string], FactRow>(sql).all(subject, predicate, tc.param)
      : this.db.prepare<[string, string], FactRow>(sql).all(subject, tc.param);

    const byPred = new Map<string, Fact[]>();
    for (const r of rows) {
      const fact = this.rowToFact(r);
      const bucket = byPred.get(fact.predicate);
      if (bucket) bucket.push(fact);
      else byPred.set(fact.predicate, [fact]);
    }
    const chains: FactHistoryChain[] = [];
    for (const [pred, history] of byPred.entries()) {
      chains.push({ subject, predicate: pred, history });
    }
    return chains;
  }

  async corroborationCounts(
    tenantId: string,
    triples: ReadonlyArray<{
      readonly subject: string;
      readonly predicate: string;
      readonly value: string;
    }>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (triples.length === 0) return out;

    // Batched query: COUNT(DISTINCT source_session_id) for each triple.
    // Uses a CTE join over a VALUES table — SQLite supports this since 3.8.3.
    // Each row counts how many sessions across the full fact history asserted
    // the same (subject, predicate, value), including superseded predecessors.
    const placeholders = triples.map(() => "(?, ?, ?)").join(", ");
    const args: string[] = [];
    for (const t of triples) {
      args.push(t.subject, t.predicate, t.value);
    }
    const corrTc = tenantClause(tenantId, "f.tenant_id");
    const sql = `
      WITH q(subject, predicate, value) AS (VALUES ${placeholders})
      SELECT q.subject, q.predicate, q.value,
             COUNT(DISTINCT f.source_session_id) AS session_count
      FROM q
      LEFT JOIN facts f
        ON f.subject = q.subject
       AND f.predicate = q.predicate
       AND f.value = q.value
       AND ${corrTc.sql}
      GROUP BY q.subject, q.predicate, q.value
    `;
    type Row = {
      subject: string;
      predicate: string;
      value: string;
      session_count: number;
    };
    const rows = this.db.prepare<unknown[], Row>(sql).all(...args, corrTc.param);
    for (const r of rows) {
      out.set(`${r.subject} ${r.predicate} ${r.value}`, r.session_count);
    }
    return out;
  }

  /**
   * Insert (or replace) the embedding row for a fact. Best-effort: callers
   * trap embedder errors so an unreachable Ollama doesn't roll back ingest.
   * vec0 doesn't UPDATE, so this is a DELETE+INSERT pair. Guarded by a
   * tenant-scoped existence check — writing an embedding for a fact outside
   * the caller's tenant is a no-op, not a fallthrough write.
   */
  async upsertEmbedding(tenantId: string, factId: string, vector: Float32Array): Promise<void> {
    const tc = tenantClause(tenantId);
    const owned = this.db
      .prepare<[string, string], { id: string }>(`SELECT id FROM facts WHERE id = ? AND ${tc.sql}`)
      .get(factId, tc.param);
    if (!owned) return;
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
    this.db
      .prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)")
      .run(factId, blob);
  }

  async markSuperseded(tenantId: string, oldId: string, newId: string | null): Promise<void> {
    if (newId !== null && oldId === newId) {
      throw new Error("A fact cannot supersede itself");
    }
    const txn = this.db.transaction(() => {
      const oldTc = tenantClause(tenantId);
      const old = this.db
        .prepare<unknown[], { id: string }>(`SELECT id FROM facts WHERE id = ? AND ${oldTc.sql}`)
        .get(oldId, oldTc.param);
      if (!old) throw new Error(`Fact ${oldId} not found`);
      if (newId !== null) {
        const newTc = tenantClause(tenantId);
        const next = this.db
          .prepare<unknown[], { id: string }>(`SELECT id FROM facts WHERE id = ? AND ${newTc.sql}`)
          .get(newId, newTc.param);
        if (!next) throw new Error(`Fact ${newId} not found`);
      }
      const updateTc = tenantClause(tenantId);
      this.db
        .prepare(`UPDATE facts SET superseded_by = ? WHERE id = ? AND ${updateTc.sql}`)
        .run(newId, oldId, updateTc.param);
      // A superseded fact is recall-ineligible, so its embedding must leave the
      // ANN index (matching retire()'s behavior) — otherwise it consumes
      // k-nearest slots and silently reduces effective recall (NLM #351).
      if (newId !== null) {
        this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(oldId);
      }
    });
    txn();
  }

  async retire(tenantId: string, factId: string): Promise<void> {
    const txn = this.db.transaction(() => {
      const rowTc = tenantClause(tenantId);
      const row = this.db
        .prepare<unknown[], { id: string }>(`SELECT id FROM facts WHERE id = ? AND ${rowTc.sql}`)
        .get(factId, rowTc.param);
      if (!row) throw new Error(`Fact ${factId} not found`);
      const updateTc = tenantClause(tenantId);
      this.db
        .prepare(`UPDATE facts SET retired_at = ? WHERE id = ? AND ${updateTc.sql}`)
        .run(new Date().toISOString(), factId, updateTc.param);
      this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
    });
    txn();
  }

  async ingestSessionFacts(
    tenantId: string,
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    this.ingestSessionFactsInTxn(tenantId, sessionId, facts);
  }

  /**
   * Sync core of ingestSessionFacts, callable from inside an existing
   * better-sqlite3 transaction. SINGLE SOURCE OF TRUTH for the replace +
   * deterministic-collapse + embedding-cleanup logic. The live ingest path
   * (SqliteSessionStore.insertSession / insertFactsForSession) runs inside its
   * own sync txn and delegates here, so it can no longer drift from this method.
   * NLM #351's embedding-ghost (bug 1) and supersedence-cycle (bug 2) fixes
   * originally landed only here and silently skipped the inlined copies — the
   * path production actually uses — leaving both bugs live in production.
   */
  ingestSessionFactsInTxn(tenantId: string, sessionId: string, facts: ReadonlyArray<Fact>, scope: string | null = null): void {
    // Re-ingesting a session replaces its facts; drop the old facts' embeddings
    // too, or they orphan in the ANN index as ghosts (NLM #351).
    const staleTc = tenantClause(tenantId);
    const stale = this.db
      .prepare<unknown[], { id: string }>(`SELECT id FROM facts WHERE source_session_id = ? AND ${staleTc.sql}`)
      .all(sessionId, staleTc.param);
    const deleteStaleTc = tenantClause(tenantId);
    this.db.prepare(`DELETE FROM facts WHERE source_session_id = ? AND ${deleteStaleTc.sql}`).run(sessionId, deleteStaleTc.param);
    const delStaleEmb = this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
    for (const row of stale) delStaleEmb.run(row.id);
    if (facts.length === 0) return;

    const insertStmt = this.insertStmt();
    for (const f of facts) insertStmt.run(this.toRow(f, scope, tenantId));

    // Collapse EVERY other active fact for this (subject, predicate) under the
    // new fact, not just the single most-recent prior. A single-prior loop
    // cannot restore the invariant once two priors are already active and
    // leaves the duplicate live forever. See NLM #301.
    const findTc = tenantClause(tenantId);
    const findSupersededStmt = this.db.prepare<unknown[], { id: string }>(
      `SELECT id FROM facts WHERE subject = ? AND predicate = ? AND superseded_by IS NULL AND id != ? AND ${findTc.sql}`,
    );
    const markTc = tenantClause(tenantId);
    const markSupersededStmt = this.db.prepare(
      `UPDATE facts SET superseded_by = ?
       WHERE subject = ? AND predicate = ? AND superseded_by IS NULL AND id != ? AND ${markTc.sql}`,
    );
    const delEmbeddingStmt = this.db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
    // Collapse ONCE per (subject, predicate), under a single winner. Running the
    // collapse per-fact creates a supersedence CYCLE when a batch carries two
    // facts for the same (subject, predicate): each supersedes the other, so
    // both end recall-ineligible forever (NLM #351 bug 2). Last fact in the
    // batch for a given (subject, predicate) wins; every other active fact —
    // batch duplicates and prior facts alike — collapses under it.
    for (const f of batchWinners(facts)) {
      // Capture which facts this collapse supersedes BEFORE the update, then
      // drop their embeddings — a superseded fact must not linger in the ANN
      // index (NLM #351). Same reason markSuperseded/retire delete embeddings.
      const collapsed = findSupersededStmt.all(f.subject, f.predicate, f.id, tenantId);
      markSupersededStmt.run(f.id, f.subject, f.predicate, f.id, tenantId);
      for (const row of collapsed) delEmbeddingStmt.run(row.id);
    }
  }

  private insertStmt(): Database.Statement<FactRow> {
    if (!this.cachedInsertStmt) {
      this.cachedInsertStmt = this.db.prepare<FactRow>(`
        INSERT INTO facts (
          id, kind, subject, predicate, value, source_session_id,
          source_quote, created_at, superseded_by, confidence, retired_at,
          scope, tenant_id
        ) VALUES (
          @id, @kind, @subject, @predicate, @value, @source_session_id,
          @source_quote, @created_at, @superseded_by, @confidence, @retired_at,
          @scope, @tenant_id
        )
      `);
    }
    return this.cachedInsertStmt;
  }

  private toRow(fact: Fact, scope: string | null, tenantId: string): FactRow {
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
      retired_at: fact.retiredAt ?? null,
      scope,
      tenant_id: tenantId,
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
      retiredAt: row.retired_at ?? null,
    };
  }
}
