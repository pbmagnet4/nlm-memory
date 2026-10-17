/**
 * PgFactStore — FactStore implementation over pg.Pool + pgvector.
 *
 * Receives its Pool from PgStorage. Never opens its own connection.
 *
 * Tenancy: mirrors SqliteFactStore — every method takes `tenantId` as its
 * non-optional first parameter and routes STAMP-table WHERE fragments
 * through `tenantClausePg`. See that file's header comment for the full
 * per-table rationale, including the vector-path re-resolution in
 * semanticSearch.
 */

import { SOURCE_ANCHOR_COLUMNS, anchorValues, anchorFromRow, type SourceAnchorRow } from "./fact-source-anchor.js";
import { persistedText } from "@core/context/source-version.js";
import { tokenize } from "@core/recall/tokenize.js";
import type { Pool } from "pg";
import type {
  CurrentValueQuery,
  CurrentValueSummary,
  FactEligibility,
  FactListFilter,
  FactQuery,
  FactSemanticNeighbor,
  FactStore,
  SubjectStat,
} from "@ports/fact-store.js";
import type { Fact, FactHistoryChain, FactKind } from "@shared/types.js";
import { ingestSessionFactsOnClient } from "./pg-fact-ingest.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";

// Alias every source column so existing fact predicates/orderings remain unambiguous.
const SOURCE_ANCHOR_JOIN = `LEFT JOIN (
  SELECT id AS anchor_source_id, tenant_id AS anchor_source_tenant, body_version AS current_source_body_version
  FROM sessions
) anchor_source ON anchor_source_id = facts.source_session_id AND anchor_source_tenant = facts.tenant_id`;

type FactRow = SourceAnchorRow & {
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
};

export class PgFactStore implements FactStore {
  constructor(private readonly pool: Pool) {}

  async insert(tenantId: string, fact: Fact): Promise<void> {
    await this.pool.query(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
         source_quote, created_at, superseded_by, confidence, tenant_id, source_start, source_end, source_body_version, source_quote_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [fact.id, fact.kind, fact.subject, fact.predicate, fact.value,
       fact.sourceSessionId, fact.sourceQuote === null ? null : persistedText(fact.sourceQuote), fact.createdAt, fact.supersededBy, fact.confidence, tenantId, ...anchorValues(fact.sourceAnchor)],
    );
  }

  async insertMany(tenantId: string, facts: ReadonlyArray<Fact>): Promise<void> {
    if (facts.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const f of facts) {
        await client.query(
          `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence, tenant_id, source_start, source_end, source_body_version, source_quote_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [f.id, f.kind, f.subject, f.predicate, f.value,
           f.sourceSessionId, f.sourceQuote === null ? null : persistedText(f.sourceQuote), f.createdAt, f.supersededBy, f.confidence, tenantId, ...anchorValues(f.sourceAnchor)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(tenantId: string, id: string): Promise<Fact | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN} WHERE id = $1 AND ${tc.sql}`,
      [id, tc.param],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async getByIds(tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>> {
    if (ids.length === 0) return [];
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN} WHERE id = ANY($1) AND ${tc.sql}`,
      [ids as string[], tc.param],
    );
    return result.rows.map(rowToFact);
  }

  async findCurrent(tenantId: string, subject: string, predicate: string): Promise<Fact | null> {
    const tc = tenantClausePg(tenantId, 3);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN}
       WHERE subject = $1 AND predicate = $2 AND superseded_by IS NULL AND retired_at IS NULL AND ${tc.sql}
       ORDER BY created_at DESC
       LIMIT 1`,
      [subject, predicate, tc.param],
    );
    return result.rows[0] ? rowToFact(result.rows[0]) : null;
  }

  async list(tenantId: string, query: FactQuery): Promise<ReadonlyArray<Fact>> {
    const limit = Math.max(1, Math.trunc(query.limit ?? 50));
    const includeSuperseded = query.includeSuperseded === true;
    const where: string[] = ["subject = $1"];
    const params: unknown[] = [query.subject];
    let idx = 2;
    if (query.predicate !== undefined) {
      where.push(`predicate = $${idx++}`);
      params.push(query.predicate);
    }
    if (!includeSuperseded) {
      where.push("superseded_by IS NULL");
      where.push("retired_at IS NULL");
    }
    const tc = tenantClausePg(tenantId, idx++);
    where.push(tc.sql);
    params.push(tc.param);
    params.push(limit);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN}
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      params,
    );
    return result.rows.map(rowToFact);
  }

  async listBySession(tenantId: string, sessionId: string): Promise<ReadonlyArray<Fact>> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN}
       WHERE source_session_id = $1 AND ${tc.sql}
       ORDER BY created_at ASC`,
      [sessionId, tc.param],
    );
    return result.rows.map(rowToFact);
  }

  async listBySessions(tenantId: string, sessionIds: ReadonlyArray<string>, opts?: { includeSuperseded?: boolean }): Promise<ReadonlyArray<Fact>> {
    if (sessionIds.length === 0) return [];
    const ph = sessionIds.map((_, i) => `$${i + 1}`).join(",");
    const filter = opts?.includeSuperseded === true ? "" : " AND superseded_by IS NULL AND retired_at IS NULL";
    const tc = tenantClausePg(tenantId, sessionIds.length + 1);
    const result = await this.pool.query<FactRow>(
      `SELECT id, kind, subject, predicate, value, source_session_id,
              source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
       FROM facts ${SOURCE_ANCHOR_JOIN} WHERE source_session_id IN (${ph}) AND ${tc.sql}${filter} ORDER BY created_at ASC`,
      [...sessionIds, tc.param],
    );
    return result.rows.map(rowToFact);
  }

  async listForRecall(tenantId: string, filter: FactListFilter): Promise<ReadonlyArray<Fact>> {
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (filter.subject !== undefined) { where.push(`subject = $${idx++}`); params.push(filter.subject); }
    if (filter.predicate !== undefined) { where.push(`predicate = $${idx++}`); params.push(filter.predicate); }
    if (filter.kind !== undefined) { where.push(`kind = $${idx++}`); params.push(filter.kind); }
    if (filter.minConfidence !== undefined) { where.push(`confidence >= $${idx++}`); params.push(filter.minConfidence); }
    if (filter.includeSuperseded !== true) {
      where.push("superseded_by IS NULL");
      where.push("retired_at IS NULL");
    }
    const tc = tenantClausePg(tenantId, idx++);
    where.push(tc.sql);
    params.push(tc.param);
    const sourceTenant = tenantClausePg(tenantId, idx++);
    const sourceWhere = [sourceTenant.sql];
    params.push(sourceTenant.param);
    if (filter.workstreamIds !== undefined) {
      if (filter.workstreamIds.length === 0) return [];
      sourceWhere.push(`workstream_id = ANY($${idx++}::text[])`);
      params.push(filter.workstreamIds);
    }
    where.push(`source_session_id IN (SELECT id FROM sessions WHERE ${sourceWhere.join(" AND ")})`);
    const tokens = [...new Set(tokenize(filter.query))];
    if (filter.query && tokens.length === 0) return [];
    const document = "to_tsvector('simple', subject || ' ' || predicate || ' ' || value)";
    let order = "created_at DESC";
    if (tokens.length > 0) {
      const search = tokens.map((_, i) => `plainto_tsquery('simple', $${idx + i})`).join(" || ");
      params.push(...tokens);
      idx += tokens.length;
      where.push(`${document} @@ (${search})`);
      order = `ts_rank(${document}, (${search})) DESC, created_at DESC, id ASC`;
    }
    const limit = Math.max(1, Math.trunc(filter.limit ?? 500));
    params.push(limit);
    const sql = `
      SELECT id, kind, subject, predicate, value, source_session_id,
             source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
      FROM facts ${SOURCE_ANCHOR_JOIN}
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${idx}
    `;
    const result = await this.pool.query<FactRow>(sql, params);
    return result.rows.map(rowToFact);
  }

  async markSuperseded(tenantId: string, oldId: string, newId: string | null): Promise<void> {
    if (newId !== null && oldId === newId) {
      throw new Error("A fact cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const oldTc = tenantClausePg(tenantId, 2);
      const old = await client.query<{ id: string }>(
        `SELECT id FROM facts WHERE id = $1 AND ${oldTc.sql}`, [oldId, oldTc.param],
      );
      if (old.rows.length === 0) throw new Error(`Fact ${oldId} not found`);
      if (newId !== null) {
        const newTc = tenantClausePg(tenantId, 2);
        const next = await client.query<{ id: string }>(
          `SELECT id FROM facts WHERE id = $1 AND ${newTc.sql}`, [newId, newTc.param],
        );
        if (next.rows.length === 0) throw new Error(`Fact ${newId} not found`);
      }
      const updateTc = tenantClausePg(tenantId, 3);
      await client.query(
        `UPDATE facts SET superseded_by = $1 WHERE id = $2 AND ${updateTc.sql}`, [newId, oldId, updateTc.param],
      );
      // Superseded facts leave the ANN index (parity with SQLite + retire); a
      // lingering embedding silently reduces effective recall (NLM #351).
      if (newId !== null) {
        await client.query("DELETE FROM fact_embeddings WHERE fact_id = $1", [oldId]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async retire(tenantId: string, factId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rowTc = tenantClausePg(tenantId, 2);
      const row = await client.query<{ id: string }>(
        `SELECT id FROM facts WHERE id = $1 AND ${rowTc.sql}`, [factId, rowTc.param],
      );
      if (row.rows.length === 0) throw new Error(`Fact ${factId} not found`);
      const updateTc = tenantClausePg(tenantId, 3);
      await client.query(
        `UPDATE facts SET retired_at = $1 WHERE id = $2 AND ${updateTc.sql}`,
        [new Date().toISOString(), factId, updateTc.param],
      );
      await client.query("DELETE FROM fact_embeddings WHERE fact_id = $1", [factId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async ingestSessionFacts(
    tenantId: string,
    sessionId: string,
    facts: ReadonlyArray<Fact>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ingestSessionFactsOnClient(client, tenantId, sessionId, facts);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Guarded by a tenant-scoped existence check — writing an embedding for a
   * fact outside the caller's tenant is a no-op, not a fallthrough write.
   */
  async upsertEmbedding(tenantId: string, factId: string, vector: Float32Array): Promise<void> {
    const tc = tenantClausePg(tenantId, 2);
    const owned = await this.pool.query<{ id: string }>(
      `SELECT id FROM facts WHERE id = $1 AND ${tc.sql}`, [factId, tc.param],
    );
    if (owned.rows.length === 0) return;
    const vecStr = `[${Array.from(vector).join(",")}]`;
    await this.pool.query(
      `INSERT INTO fact_embeddings (fact_id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [factId, vecStr],
    );
  }

  async summarizeCurrentValues(tenantId: string, query: CurrentValueQuery): Promise<CurrentValueSummary> {
    if (query.workstreamIds?.length === 0) return { distinctValueCount: 0, sourceSessionCount: 0, examples: [] };
    const factTenant = tenantClausePg(tenantId, 1, "f.tenant_id");
    const sourceTenant = tenantClausePg(tenantId, 2, "s.tenant_id");
    const where = [factTenant.sql, sourceTenant.sql, "f.subject = $3", "f.predicate = $4",
      "f.superseded_by IS NULL", "f.retired_at IS NULL"];
    const params: unknown[] = [factTenant.param, sourceTenant.param, query.subject, query.predicate];
    if (query.kind !== undefined) { params.push(query.kind); where.push(`f.kind = $${params.length}`); }
    if (query.minConfidence !== undefined) { params.push(query.minConfidence); where.push(`f.confidence >= $${params.length}`); }
    if (query.workstreamIds !== undefined) {
      params.push(query.workstreamIds); where.push(`s.workstream_id = ANY($${params.length}::text[])`);
    }
    const { rows } = await this.pool.query<{
      distinct_count: string; source_count: string; value: string | null; source_session_id: string | null;
    }>(`
      WITH eligible AS MATERIALIZED (
        SELECT f.value, f.source_session_id FROM facts f JOIN sessions s ON s.id = f.source_session_id
        WHERE ${where.join(" AND ")}
      ), totals AS (
        SELECT COUNT(DISTINCT value) AS distinct_count, COUNT(DISTINCT source_session_id) AS source_count FROM eligible
      ), examples AS (
        SELECT value, MIN(source_session_id COLLATE "C") AS source_session_id FROM eligible
        GROUP BY value ORDER BY value COLLATE "C" LIMIT 2
      )
      SELECT totals.*, examples.* FROM totals LEFT JOIN examples ON TRUE ORDER BY value COLLATE "C"
    `, params);
    return { distinctValueCount: Number(rows[0]!.distinct_count), sourceSessionCount: Number(rows[0]!.source_count),
      examples: rows.flatMap((r) => r.value === null ? [] : [{ value: r.value, sourceSessionId: r.source_session_id! }]) };
  }

  async semanticSearch(
    tenantId: string,
    queryVector: Float32Array,
    limit: number,
    eligibility?: FactEligibility,
  ): Promise<ReadonlyArray<FactSemanticNeighbor>> {
    if (eligibility?.workstreamIds?.length === 0) return [];
    const factTenant = tenantClausePg(tenantId, 2, "f.tenant_id");
    const sourceTenant = tenantClausePg(tenantId, 3, "s.tenant_id");
    const where = [factTenant.sql, sourceTenant.sql];
    const params: unknown[] = [JSON.stringify(Array.from(queryVector)), factTenant.param, sourceTenant.param];
    for (const field of ["subject", "predicate", "kind"] as const) {
      if (eligibility?.[field] !== undefined) {
        params.push(eligibility[field]);
        where.push(`f.${field} = $${params.length}`);
      }
    }
    if (eligibility?.minConfidence !== undefined) {
      params.push(eligibility.minConfidence);
      where.push(`f.confidence >= $${params.length}`);
    }
    if (eligibility?.includeSuperseded !== true) {
      where.push("f.superseded_by IS NULL", "f.retired_at IS NULL");
    }
    if (eligibility?.workstreamIds !== undefined) {
      params.push(eligibility.workstreamIds);
      where.push(`s.workstream_id = ANY($${params.length}::text[])`);
    }
    params.push(Math.max(1, Math.trunc(limit)));
    // Materialization prevents an approximate vector index from limiting the eligible corpus.
    const result = await this.pool.query<{ fact_id: string; distance: number }>(`
      WITH eligible AS MATERIALIZED (
        SELECT fe.fact_id, fe.embedding
        FROM fact_embeddings fe
        JOIN facts f ON f.id = fe.fact_id
        JOIN sessions s ON s.id = f.source_session_id
        WHERE ${where.join(" AND ")}
      )
      SELECT fact_id, embedding <-> $1::vector AS distance
      FROM eligible
      ORDER BY distance, fact_id COLLATE "C"
      LIMIT $${params.length}
    `, params);
    return result.rows.map((r) => ({ factId: r.fact_id, distance: r.distance }));
  }

  async getHistory(
    tenantId: string,
    subject: string,
    predicate?: string,
  ): Promise<ReadonlyArray<FactHistoryChain>> {
    const result = predicate
      ? await this.pool.query<FactRow>(
          (() => {
            const tc = tenantClausePg(tenantId, 3);
            return `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
           FROM facts ${SOURCE_ANCHOR_JOIN}
           WHERE subject = $1 AND predicate = $2 AND ${tc.sql}
           ORDER BY predicate ASC, created_at DESC`;
          })(),
          [subject, predicate, tenantId],
        )
      : await this.pool.query<FactRow>(
          (() => {
            const tc = tenantClausePg(tenantId, 2);
            return `SELECT id, kind, subject, predicate, value, source_session_id,
                  source_quote, created_at, superseded_by, confidence, retired_at, ${SOURCE_ANCHOR_COLUMNS}
           FROM facts ${SOURCE_ANCHOR_JOIN}
           WHERE subject = $1 AND ${tc.sql}
           ORDER BY predicate ASC, created_at DESC`;
          })(),
          [subject, tenantId],
        );

    const byPred = new Map<string, Fact[]>();
    for (const row of result.rows) {
      const fact = rowToFact(row);
      const bucket = byPred.get(fact.predicate);
      if (bucket) bucket.push(fact);
      else byPred.set(fact.predicate, [fact]);
    }
    return [...byPred.entries()].map(([pred, history]) => ({ subject, predicate: pred, history }));
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

    const values: string[] = [];
    const args: string[] = [];
    for (let i = 0; i < triples.length; i++) {
      const t = triples[i]!;
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      args.push(t.subject, t.predicate, t.value);
    }
    const tc = tenantClausePg(tenantId, args.length + 1, "f.tenant_id");
    const sql = `
      WITH q(subject, predicate, value) AS (VALUES ${values.join(", ")})
      SELECT q.subject, q.predicate, q.value,
             COUNT(DISTINCT f.source_session_id)::int AS session_count
      FROM q
      LEFT JOIN facts f
        ON f.subject = q.subject
       AND f.predicate = q.predicate
       AND f.value = q.value
       AND ${tc.sql}
      GROUP BY q.subject, q.predicate, q.value
    `;
    const result = await this.pool.query<{
      subject: string;
      predicate: string;
      value: string;
      session_count: number;
    }>(sql, [...args, tenantId]);
    for (const r of result.rows) {
      out.set(`${r.subject} ${r.predicate} ${r.value}`, r.session_count);
    }
    return out;
  }

  async listSubjectStats(_tenantId: string): Promise<ReadonlyArray<SubjectStat>> {
    throw new Error(
      "listSubjectStats is not implemented on the Postgres backend; the wiki " +
        "projection is SQLite-only and the daemon does not start it under PgStorage",
    );
  }

  async listBySubjects(_tenantId: string, _subjects: ReadonlyArray<string>): Promise<ReadonlyArray<Fact>> {
    throw new Error(
      "listBySubjects is not implemented on the Postgres backend; the wiki " +
        "projection is SQLite-only and the daemon does not start it under PgStorage",
    );
  }
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    sourceSessionId: row.source_session_id,
    sourceQuote: row.source_quote,
      sourceAnchor: anchorFromRow(row, row.source_quote),
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    confidence: row.confidence,
    retiredAt: row.retired_at ?? null,
  };
}
