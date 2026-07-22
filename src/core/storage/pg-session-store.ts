/**
 * PgSessionStore — SessionStore implementation over pg.Pool + pgvector.
 *
 * Constructor takes the Pool from PgStorage. Also exposes recentWrites()
 * and recentMarkers() for the /live HTTP endpoints, and insertSession() +
 * insertSessionForTest() for ingest and test seeding.
 *
 * Tenancy: mirrors SqliteSessionStore — every method takes `tenantId` as its
 * non-optional first parameter and routes STAMP-table WHERE fragments
 * through `tenantClausePg`. See that file's header comment for the full
 * per-table rationale.
 */

import type { Pool, PoolClient } from "pg";
import type {
  KeywordNeighbor,
  SearchOptions,
  SemanticNeighbor,
  SessionStore,
} from "@ports/session-store.js";
import type { Fact, Session, SessionStatus } from "@shared/types.js";
import type { BackfillCandidate, BackfillCandidateFilter, IngestRecord, RecentMarker, RecentWrite, Supersedes } from "./sqlite-session-store.js";
import { tokenize } from "@core/recall/tokenize.js";
import type { PgFactStore } from "./pg-fact-store.js";
import { ingestSessionFactsOnClient } from "./pg-fact-ingest.js";
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import { batchWinners } from "./fact-batch.js";
import { loadActionOverlayPg, openQuestionId } from "@core/actions/overlay.js";
import type { ActionOverlay } from "@core/actions/overlay.js";
import { liveSessionStatus } from "./live-status.js";
import { tenantClausePg } from "@core/tenancy/tenant-clause.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";

type SessionRow = {
  id: string;
  runtime: string;
  runtime_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_min: number | null;
  label: string;
  summary: string;
  status: "active" | "closed" | "superseded" | "replaced";
  transcript_kind: string | null;
  transcript_path: string | null;
  body: string | null;
  workstream_id: string | null;
  classifier_provider?: string | null;
  classifier_model?: string | null;
  classifier_confidence?: number | null;
  agent_persona?: string | null;
  parent_session_id?: string | null;
  primary_model?: string | null;
  total_tokens?: number | null;
  skill?: string | null;
};

/**
 * PG mirror of SQLite findContinuesPredecessor: the most recent prior session
 * whose distinct entity-set is identical to the new session's. Runs on the
 * ingest transaction's own client. Returns null when there is no entity-set or
 * no exact-set match, leaving the pair unlinked for the re_derivation_rate metric.
 * Scoped to the same tenant as the new session.
 */
async function findContinuesPredecessorPg(
  client: PoolClient,
  tenantId: string,
  newId: string,
  rawEntities: ReadonlyArray<string>,
): Promise<string | null> {
  const entities = [...new Set(rawEntities.map((e) => e.trim()).filter(Boolean))];
  if (entities.length === 0) return null;
  const placeholders = entities.map((_, i) => `$${i + 3}`).join(",");
  // session_entities rows are always written with the same tenant_id as their
  // owning session (every write site stamps both together), so scoping the
  // outer `sessions` row by tenant is already sufficient. The `se.tenant_id =
  // s.tenant_id` join condition below is defense in depth (guard test C4
  // explicitly permits column-to-column tenant equality as a join form).
  const tc = tenantClausePg(tenantId, 2, "s.tenant_id");
  const res = await client.query<{ id: string }>(
    `SELECT s.id AS id
       FROM sessions s
       JOIN session_entities se ON se.session_id = s.id AND se.tenant_id = s.tenant_id
      WHERE s.id != $1
        AND ${tc.sql}
        AND se.entity_canonical IN (${placeholders})
      GROUP BY s.id
     HAVING COUNT(DISTINCT se.entity_canonical) = $${entities.length + 3}
        AND COUNT(DISTINCT se.entity_canonical)
          = (SELECT COUNT(*) FROM session_entities x WHERE x.session_id = s.id)
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT 1`,
    [newId, tc.param, ...entities, entities.length],
  );
  return res.rows[0]?.id ?? null;
}

export class PgSessionStore implements SessionStore {
  // `pool` is public-readonly so PG-native sibling helpers (actions-log Pg
  // functions) can share the same connection pool. See docs/plans/2026-05-31-pg-adapter.md.
  constructor(readonly pool: Pool) {}

  // Keyed by tenantId — see SqliteSessionStore's identical cache for the
  // tenancy rationale (program spec §4.6 hardening 1).
  private overlayCache = new Map<string, { overlay: ActionOverlay; at: number }>();

  invalidateOverlayCache(): void {
    this.overlayCache.clear();
  }

  private async overlay(tenantId: string): Promise<ActionOverlay> {
    // TTL backstop: explicit invalidation covers the daemon's own writers; the
    // 30s expiry bounds staleness if another process ever writes actions to
    // this database.
    const cached = this.overlayCache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.at < 30_000) {
      return cached.overlay;
    }
    const overlay = await loadActionOverlayPg(this.pool, tenantId);
    this.overlayCache.set(tenantId, { overlay, at: Date.now() });
    return overlay;
  }

  async getById(tenantId: string, sessionId: string): Promise<Session | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<SessionRow>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, body,
              classifier_provider, classifier_model, classifier_confidence,
              agent_persona, parent_session_id,
              primary_model, total_tokens, skill
       FROM sessions WHERE id = $1 AND ${tc.sql}`,
      [sessionId, tc.param],
    );
    if (!result.rows[0]) return null;
    const [entitiesMap, markersMap, edgesMap, overlay] = await Promise.all([
      this.loadEntities(tenantId, [sessionId]),
      this.loadMarkers([sessionId]),
      this.loadEdges([sessionId]),
      this.overlay(tenantId),
    ]);
    const edges = edgesMap.get(sessionId);
    return rowToSession(result.rows[0], entitiesMap, markersMap, overlay, edges);
  }

  async getByIds(tenantId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Session>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, ids.length + 1);
    const result = await this.pool.query<Omit<SessionRow, "body">>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path
       FROM sessions WHERE id IN (${placeholders}) AND ${tc.sql}`,
      [...ids, tc.param],
    );
    if (result.rows.length === 0) return [];
    const foundIds = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap, overlay] = await Promise.all([
      this.loadEntities(tenantId, foundIds),
      this.loadMarkers(foundIds),
      this.overlay(tenantId),
    ]);
    return result.rows.map((r) => rowToSession({ ...r, body: null }, entitiesMap, markersMap, overlay));
  }

  async listByDateRange(tenantId: string, fromIso: string, toIso: string): Promise<ReadonlyArray<Session>> {
    const tc = tenantClausePg(tenantId, 3);
    const result = await this.pool.query<Omit<SessionRow, "body">>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path, workstream_id
       FROM sessions
       WHERE started_at < $1 AND (ended_at IS NULL OR ended_at >= $2) AND ${tc.sql}
       ORDER BY started_at ASC`,
      [toIso, fromIso, tc.param],
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap, overlay] = await Promise.all([
      this.loadEntities(tenantId, ids),
      this.loadMarkers(ids),
      this.overlay(tenantId),
    ]);
    return result.rows.map((r) => rowToSession({ ...r, body: null }, entitiesMap, markersMap, overlay));
  }

  async semanticSearch(
    tenantId: string,
    queryVector: Float32Array,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<SemanticNeighbor>> {
    const wsIds = opts?.workstreamIds;
    if (wsIds !== undefined && wsIds.length === 0) return [];
    const k = Math.max(1, Math.trunc(limit));
    const vecStr = `[${Array.from(queryVector).join(",")}]`;
    const statusFilter =
      opts?.includeSuperseded === true
        ? "s.status != 'replaced'"
        : "s.status NOT IN ('superseded', 'replaced')";
    const params: unknown[] = [vecStr];
    let wsClause = "";
    if (wsIds?.length) {
      params.push(wsIds);
      wsClause = `AND s.workstream_id = ANY($${params.length}::text[])`;
    }
    // Tenant filter is applied in the id-resolution join against `sessions`
    // (program spec §4.3, vector-path rule) — the `<->` KNN scan over
    // session_embedding_chunks has no tenant column of its own.
    const tc = tenantClausePg(tenantId, params.length + 1, "s.tenant_id");
    params.push(tc.param);
    const limitParam = `$${params.length + 1}`;
    params.push(k);
    const result = await this.pool.query<{
      session_id: string;
      distance: number;
      status: string;
    }>(
      `SELECT sec.session_id, MIN(sec.embedding <-> $1::vector) AS distance, s.status
       FROM session_embedding_chunks sec
       JOIN sessions s ON s.id = sec.session_id
       WHERE ${tc.sql} ${wsClause}
       GROUP BY sec.session_id, s.status
       HAVING ${statusFilter}
       ORDER BY distance
       LIMIT ${limitParam}`,
      params,
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, distance: r.distance }));
  }

  async keywordSearch(
    tenantId: string,
    query: string,
    limit: number,
    opts?: SearchOptions,
  ): Promise<ReadonlyArray<KeywordNeighbor>> {
    const wsIds = opts?.workstreamIds;
    if (wsIds !== undefined && wsIds.length === 0) return [];
    const terms = tokenize(query).map(sanitizeTsToken).filter(Boolean);
    if (terms.length === 0) return [];
    const tsQuery = terms.join(" OR ");
    const k = Math.max(1, Math.trunc(limit));
    const statusFilter =
      opts?.includeSuperseded === true
        ? "status != 'replaced'"
        : "status NOT IN ('superseded', 'replaced')";
    const params: unknown[] = [tsQuery];
    let wsClause = "";
    if (wsIds?.length) {
      params.push(wsIds);
      wsClause = `AND workstream_id = ANY($${params.length}::text[])`;
    }
    const tc = tenantClausePg(tenantId, params.length + 1);
    params.push(tc.param);
    params.push(k);
    const limitParam = `$${params.length}`;
    const result = await this.pool.query<{ session_id: string; score: number }>(
      `SELECT id AS session_id,
              ts_rank_cd(fts_vector, websearch_to_tsquery('english', $1)) AS score
       FROM sessions
       WHERE fts_vector @@ websearch_to_tsquery('english', $1)
         AND ${statusFilter}
         ${wsClause}
         AND ${tc.sql}
       ORDER BY score DESC
       LIMIT ${limitParam}`,
      params,
    );
    return result.rows.map((r) => ({ sessionId: r.session_id, score: r.score }));
  }

  async resolveSuccessors(tenantId: string, ids: ReadonlyArray<string>): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, ids.length + 1, "s.tenant_id");
    const result = await this.pool.query<{ from_session: string; to_session: string }>(
      `SELECT se.from_session, se.to_session
       FROM session_edges se
       JOIN sessions s ON s.id = se.to_session
       WHERE se.kind = 'supersedes' AND se.to_session IN (${placeholders}) AND ${tc.sql}`,
      [...ids, tc.param],
    );
    const out = new Map<string, string>();
    for (const r of result.rows) out.set(r.to_session, r.from_session);
    return out;
  }

  async updateStatus(tenantId: string, sessionId: string, status: SessionStatus): Promise<void> {
    if (status === "idle") {
      throw new Error("Cannot persist derived status 'idle' — only active/closed/superseded");
    }
    const tc = tenantClausePg(tenantId, 3);
    await this.pool.query(
      `UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2 AND ${tc.sql}`,
      [status, sessionId, tc.param],
    );
  }

  async markSuperseded(tenantId: string, predecessorId: string, successorId: string): Promise<void> {
    if (predecessorId === successorId) {
      throw new Error("A session cannot supersede itself");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const predExistsTc = tenantClausePg(tenantId, 2);
      const predExists = await client.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM sessions WHERE id = $1 AND ${predExistsTc.sql}`, [predecessorId, predExistsTc.param],
      );
      if (Number(predExists.rows[0]?.c) === 0) {
        throw new Error(`predecessor session ${predecessorId} not found`);
      }
      const succExistsTc = tenantClausePg(tenantId, 2);
      const succExists = await client.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM sessions WHERE id = $1 AND ${succExistsTc.sql}`, [successorId, succExistsTc.param],
      );
      if (Number(succExists.rows[0]?.c) === 0) {
        throw new Error(`successor session ${successorId} not found`);
      }
      // Cycle guard. Edges read (from, to) = "from supersedes/replaces to". We
      // are about to insert (successor, predecessor). A cycle closes if the
      // predecessor can already reach the successor by following either edge
      // kind — then the new edge would loop back. Walk from→to over the union
      // of both supersedence relations starting at the predecessor.
      const seen = new Set<string>([predecessorId]);
      let frontier = [predecessorId];
      for (let depth = 0; depth < 100 && frontier.length > 0; depth++) {
        const children = await client.query<{ to_session: string }>(
          `SELECT to_session FROM session_edges WHERE from_session = ANY($1) AND kind IN ('supersedes', 'replaces')`,
          [frontier],
        );
        const next: string[] = [];
        for (const { to_session } of children.rows) {
          if (to_session === successorId) {
            throw new Error(
              `supersedence cycle: ${successorId} is already (transitively) superseded by ${predecessorId}`,
            );
          }
          if (!seen.has(to_session)) {
            seen.add(to_session);
            next.push(to_session);
          }
        }
        frontier = next;
      }
      await client.query(
        `DELETE FROM session_edges WHERE to_session = $1 AND kind = 'supersedes' AND from_session != $2`,
        [predecessorId, successorId],
      );
      await client.query(
        `INSERT INTO session_edges (from_session, to_session, kind)
         VALUES ($1, $2, 'supersedes')
         ON CONFLICT DO NOTHING`,
        [successorId, predecessorId],
      );
      const statusTc = tenantClausePg(tenantId, 2);
      await client.query(
        `UPDATE sessions SET status = 'superseded', updated_at = NOW() WHERE id = $1 AND ${statusTc.sql}`,
        [predecessorId, statusTc.param],
      );

      // Cascade supersedence to facts in a single correlated UPDATE, scoped to
      // the caller's tenant on both sides of the join.
      const sTc = tenantClausePg(tenantId, 3, "s.tenant_id");
      const pTc = tenantClausePg(tenantId, 3, "p.tenant_id");
      const cascadeSQL = `
        UPDATE facts AS p
        SET superseded_by = (
          SELECT s.id FROM facts s
          WHERE s.source_session_id = $2
            AND s.subject = p.subject
            AND s.predicate = p.predicate
            AND s.superseded_by IS NULL
            AND ${sTc.sql}
          LIMIT 1
        )
        WHERE p.source_session_id = $1
          AND ${pTc.sql}
          AND EXISTS (
            SELECT 1 FROM facts s
            WHERE s.source_session_id = $2
              AND s.subject = p.subject
              AND s.predicate = p.predicate
              AND s.superseded_by IS NULL
              AND ${sTc.sql}
          )
      `;
      const cascaded = await client.query<{ id: string }>(
        cascadeSQL + " RETURNING p.id",
        [predecessorId, successorId, sTc.param],
      );
      const cascadedIds = cascaded.rows.map((r) => r.id);
      if (cascadedIds.length > 0) {
        await client.query("DELETE FROM fact_embeddings WHERE fact_id = ANY($1)", [cascadedIds]);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getSessionScopeById(tenantId: string, id: string): Promise<string | null> {
    const tc = tenantClausePg(tenantId, 2);
    const r = await this.pool.query<{ scope: string | null }>(
      `SELECT scope FROM sessions WHERE id = $1 AND ${tc.sql}`, [id, tc.param],
    );
    return r.rows[0]?.scope ?? null;
  }

  async setWorkstreamBinding(tenantId: string, sessionId: string, workstreamId: string | null, source: import("@core/workstream/model.js").BindingSource | null, confidence: number | null): Promise<void> {
    const tc = tenantClausePg(tenantId, 5);
    await this.pool.query(
      `UPDATE sessions SET workstream_id = $1, binding_source = $2, binding_confidence = $3, updated_at = NOW() WHERE id = $4 AND ${tc.sql}`,
      [workstreamId, source, confidence, sessionId, tc.param],
    );
  }

  async listSessionIdsByWorkstreams(tenantId: string, workstreamIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    if (workstreamIds.length === 0) return [];
    const ph = workstreamIds.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, workstreamIds.length + 1);
    const r = await this.pool.query<{ id: string }>(
      `SELECT id FROM sessions WHERE workstream_id IN (${ph}) AND ${tc.sql} ORDER BY started_at ASC`, [...workstreamIds, tc.param],
    );
    return r.rows.map((row) => row.id);
  }

  async getEntities(tenantId: string, sessionId: string): Promise<ReadonlyArray<string>> {
    return (await this.loadEntities(tenantId, [sessionId])).get(sessionId) ?? [];
  }

  async getWorkstreamIds(tenantId: string, sessionIds: ReadonlyArray<string>): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (sessionIds.length === 0) return out;
    const ph = sessionIds.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, sessionIds.length + 1);
    const result = await this.pool.query<{ id: string; workstream_id: string | null }>(
      `SELECT id, workstream_id FROM sessions WHERE id IN (${ph}) AND ${tc.sql}`, [...sessionIds, tc.param],
    );
    for (const r of result.rows) out.set(r.id, r.workstream_id);
    return out;
  }

  async recentWrites(tenantId: string, limit: number): Promise<RecentWrite[]> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<Omit<RecentWrite, "entities">>(
      `SELECT id, runtime, label, summary, created_at AS "createdAt"
       FROM sessions WHERE ${tc.sql} ORDER BY created_at DESC LIMIT $1`,
      [limit, tc.param],
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const entTc = tenantClausePg(tenantId, 2);
    const entityResult = await this.pool.query<{ session_id: string; entity_canonical: string }>(
      `SELECT session_id, entity_canonical
       FROM session_entities
       WHERE session_id = ANY($1) AND ${entTc.sql}
       ORDER BY entity_canonical`,
      [ids, entTc.param],
    );
    const byId = new Map<string, string[]>();
    for (const e of entityResult.rows) {
      const list = byId.get(e.session_id);
      if (list) list.push(e.entity_canonical);
      else byId.set(e.session_id, [e.entity_canonical]);
    }
    return result.rows.map((r) => ({ ...r, entities: byId.get(r.id) ?? [] }));
  }

  async recentMarkers(tenantId: string, limit: number): Promise<RecentMarker[]> {
    const tc = tenantClausePg(tenantId, 2, "s.tenant_id");
    const result = await this.pool.query<RecentMarker>(
      `SELECT m.session_id AS "sessionId", m.kind, m.text, s.label, s.created_at AS "createdAt"
       FROM markers m
       JOIN sessions s ON s.id = m.session_id
       WHERE ${tc.sql}
       ORDER BY s.created_at DESC, m.position ASC
       LIMIT $1`,
      [limit, tc.param],
    );
    return result.rows;
  }

  async insertSession(
    tenantId: string,
    record: IngestRecord,
    embedder: import("@ports/llm-client.js").LLMClient | null = null,
    supersedes: Supersedes | null = null,
    factSink: { factStore: PgFactStore; facts: ReadonlyArray<Fact> } | null = null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (
           id, runtime, runtime_session_id, started_at, ended_at, duration_min,
           label, summary, body, status, transcript_kind, transcript_path,
           transcript_offset, transcript_length,
           classifier_provider, classifier_model, classifier_confidence,
           scope, agent_persona, parent_session_id,
           primary_model, total_tokens, skill, tenant_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT (id) DO UPDATE SET
           ended_at = EXCLUDED.ended_at,
           duration_min = EXCLUDED.duration_min,
           label = EXCLUDED.label,
           summary = EXCLUDED.summary,
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           classifier_provider = EXCLUDED.classifier_provider,
           classifier_model = EXCLUDED.classifier_model,
           classifier_confidence = EXCLUDED.classifier_confidence,
           scope = COALESCE(EXCLUDED.scope, sessions.scope),
           agent_persona = COALESCE(EXCLUDED.agent_persona, sessions.agent_persona),
           parent_session_id = COALESCE(EXCLUDED.parent_session_id, sessions.parent_session_id),
           primary_model = COALESCE(EXCLUDED.primary_model, sessions.primary_model),
           total_tokens = COALESCE(EXCLUDED.total_tokens, sessions.total_tokens),
           skill = COALESCE(EXCLUDED.skill, sessions.skill),
           updated_at = NOW()`,
        [
          record.id, record.runtime, record.runtimeSessionId,
          record.startedAt, record.endedAt, record.durationMin,
          record.label, record.summary, record.body,
          record.status === "idle" ? "active" : record.status,
          record.transcriptKind, record.transcriptPath,
          record.transcriptOffset, record.transcriptLength,
          record.classifier?.provider ?? null,
          record.classifier?.model ?? null,
          record.classifier?.confidence ?? null,
          record.scope,
          record.agentPersona ?? null,
          record.parentSessionId ?? null,
          record.primaryModel ?? null,
          record.totalTokens ?? null,
          record.skill ?? null,
          tenantId,
        ],
      );
      await client.query("DELETE FROM markers WHERE session_id = $1", [record.id]);
      for (let i = 0; i < record.decisions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
          [record.id, record.decisions[i]!.trim(), i],
        );
      }
      for (let i = 0; i < record.openQuestions.length; i++) {
        await client.query(
          "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
          [record.id, record.openQuestions[i]!.trim(), i],
        );
      }
      // Replace entity-link semantics: delete the session's existing links, then
      // re-insert for the new entity list. Without this, nlm reprocess amplifies
      // stale links (ON CONFLICT DO NOTHING keeps dropped entities forever) and
      // double-counts session_count on every re-ingest pass.
      const rawNewEntities = [...new Set(record.entities.map((e) => e.trim()).filter(Boolean))];
      // Resolve each extracted entity through entity_variants so merged surface
      // forms bind to the canonical instead of resurrecting the retired source.
      const variantTc = tenantClausePg(tenantId, 1);
      const variantRes = await client.query<{ variant: string; canonical: string }>(
        `SELECT variant, canonical FROM entity_variants WHERE ${variantTc.sql} AND variant = ANY($2)`,
        [variantTc.param, rawNewEntities],
      );
      const variantMap = new Map(variantRes.rows.map((r) => [r.variant, r.canonical]));
      const newEntities = rawNewEntities.map((name) => variantMap.get(name) ?? name);
      const oldTc = tenantClausePg(tenantId, 1);
      const oldRes = await client.query<{ entity_canonical: string }>(
        `SELECT entity_canonical FROM session_entities WHERE ${oldTc.sql} AND session_id = $2`,
        [oldTc.param, record.id],
      );
      const oldEntities = new Set(oldRes.rows.map((r) => r.entity_canonical));

      const deleteTc = tenantClausePg(tenantId, 1);
      await client.query(`DELETE FROM session_entities WHERE ${deleteTc.sql} AND session_id = $2`, [deleteTc.param, record.id]);

      for (const name of newEntities) {
        const insertTc = tenantClausePg(tenantId, 1);
        await client.query(
          `INSERT INTO entities (tenant_id, canonical, type, status, source, first_seen_session, last_seen_session, session_count)
           VALUES ($1, $2, 'candidate', 'candidate', 'auto-detected', $3, $3, 0)
           ON CONFLICT (tenant_id, canonical) DO NOTHING`,
          [insertTc.param, name, record.id],
        );
        // Update last_seen for entities newly added to this session; matches prior touch semantics.
        if (!oldEntities.has(name)) {
          const touchTc = tenantClausePg(tenantId, 2);
          await client.query(
            `UPDATE entities SET last_seen_session = $1, updated_at = NOW() WHERE ${touchTc.sql} AND canonical = $3`,
            [record.id, touchTc.param, name],
          );
        }
        await client.query(
          "INSERT INTO session_entities (tenant_id, session_id, entity_canonical) VALUES ($1, $2, $3)",
          [tenantId, record.id, name],
        );
      }

      // Recompute session_count exactly for every entity in (old union new) so
      // counts reflect reality regardless of prior drift.
      const allTouched = [...new Set([...oldEntities, ...newEntities])];
      for (const name of allTouched) {
        const recomputeTc = tenantClausePg(tenantId, 2);
        await client.query(
          `UPDATE entities SET session_count = (SELECT COUNT(*) FROM session_entities WHERE ${recomputeTc.sql} AND entity_canonical = $1), updated_at = NOW() WHERE ${recomputeTc.sql} AND canonical = $1`,
          [name, recomputeTc.param],
        );
      }
      if (supersedes && supersedes.priorSessionId !== record.id) {
        const predecessorStatus = supersedes.kind === "replaces" ? "replaced" : "superseded";
        await client.query(
          `INSERT INTO session_edges (from_session, to_session, kind)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [record.id, supersedes.priorSessionId, supersedes.kind],
        );
        const predStatusTc = tenantClausePg(tenantId, 3);
        await client.query(
          `UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2 AND ${predStatusTc.sql}`,
          [predecessorStatus, supersedes.priorSessionId, predStatusTc.param],
        );
      } else {
        const priorId = await findContinuesPredecessorPg(client, tenantId, record.id, record.entities);
        if (priorId !== null) {
          await client.query(
            `INSERT INTO session_edges (from_session, to_session, kind)
             VALUES ($1, $2, 'continues') ON CONFLICT DO NOTHING`,
            [record.id, priorId],
          );
        }
      }

      // Atomic session+facts ingest on the session's own client. Single source of truth: pg-fact-ingest.ts.
      if (factSink !== null) {
        await ingestSessionFactsOnClient(client, tenantId, record.id, factSink.facts, record.scope);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (embedder) {
      const chunks = chunkSessionText({ label: record.label, summary: record.summary, body: record.body });
      await this.pool.query("DELETE FROM session_embedding_chunks WHERE session_id = $1", [record.id]);
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const text = chunks[chunkIdx]!;
        if (!text) continue;
        try {
          const { vector } = await embedder.embed(text, "document");
          const vecStr = `[${Array.from(vector).join(",")}]`;
          const ins = await this.pool.query<{ chunk_id: number }>(
            `INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding)
             VALUES ($1, $2, $3::vector) RETURNING chunk_id`,
            [record.id, chunkIdx, vecStr],
          );
          const chunkId = ins.rows[0]!.chunk_id;
          await this.pool.query(
            "INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES ($1, $2, $3)",
            [chunkId, record.id, chunkIdx],
          );
        } catch (err) {
          process.stderr.write(`[nlm] embedding chunk failed session=${record.id} chunk=${chunkIdx}: ${String(err)}\n`);
        }
      }

      // Fact embeddings are best-effort and live outside the txn, mirroring the
      // SQLite path. A per-fact embed failure leaves the fact current but
      // semantically unreachable until a future re-ingest.
      if (factSink !== null) {
        for (const fact of batchWinners(factSink.facts)) {
          const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
          if (!factText) continue;
          try {
            const { vector } = await embedder.embed(factText, "document");
            await factSink.factStore.upsertEmbedding(tenantId, fact.id, vector);
          } catch {
            // Tolerated; see comment above.
          }
        }
      }
    }
  }

  async insertSessionForTest(session: Session, tenantId: string = DEFAULT_TEAM_ID): Promise<void> {
    const status: SessionStatus = session.status === "idle" ? "active" : session.status;
    await this.pool.query(
      `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, ended_at,
         duration_min, label, summary, body, status, transcript_kind, transcript_path, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        session.id, session.runtime, session.runtimeSessionId, session.startedAt,
        session.endedAt, session.durationMin, session.label, session.summary,
        session.body, status, session.transcriptKind, session.transcriptPath, tenantId,
      ],
    );
    for (const e of session.entities) {
      await this.pool.query(
        "INSERT INTO entities (tenant_id, canonical, type, status) VALUES ($1, $2, 'candidate', 'active') ON CONFLICT DO NOTHING",
        [tenantId, e],
      );
      await this.pool.query(
        "INSERT INTO session_entities (tenant_id, session_id, entity_canonical) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantId, session.id, e],
      );
    }
    for (let i = 0; i < session.decisions.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'decision', $2, $3)",
        [session.id, session.decisions[i], i],
      );
    }
    for (let i = 0; i < session.open.length; i++) {
      await this.pool.query(
        "INSERT INTO markers (session_id, kind, text, position) VALUES ($1, 'open', $2, $3)",
        [session.id, session.open[i], i],
      );
    }
  }

  /** PG counterpart of SqliteSessionStore.listBackfillCandidates. */
  async listBackfillCandidates(tenantId: string, filter: BackfillCandidateFilter): Promise<BackfillCandidate[]> {
    const params: unknown[] = [filter.cutoff];
    let fromClause = "";
    if (filter.from) { params.push(filter.from); fromClause = `AND s.id > $${params.length}`; }
    // facts.tenant_id is always stamped to match its source_session_id's
    // session tenant (every write site stamps both together), so scoping by
    // source_session_id = s.id against an already tenant-filtered `s` is
    // already sufficient. The f.tenant_id = s.tenant_id condition below is
    // defense in depth (guard test C4 permits column-to-column tenant
    // equality as a join form).
    const existingFactsClause = filter.reprocess
      ? ""
      : "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_session_id = s.id AND f.tenant_id = s.tenant_id)";
    const tc = tenantClausePg(tenantId, params.length + 1, "s.tenant_id");
    params.push(tc.param);
    const result = await this.pool.query<{ id: string; started_at: string; body: string | null }>(
      `SELECT s.id, s.started_at, s.body FROM sessions s
       WHERE s.started_at < $1 AND s.body IS NOT NULL AND length(s.body) > 0
         ${existingFactsClause}
         ${fromClause}
         AND ${tc.sql}
       ORDER BY s.started_at ASC, s.id ASC`,
      params,
    );
    return result.rows.map((r) => ({ id: r.id, startedAt: r.started_at, body: r.body }));
  }

  /** PG counterpart of SqliteSessionStore.insertFactsForSession — writes facts
   *  for an EXISTING session row (deterministic supersedence + best-effort
   *  embeddings) in one transaction. Used by the fact backfill. */
  async insertFactsForSession(
    tenantId: string,
    sessionId: string,
    factStore: PgFactStore,
    facts: ReadonlyArray<Fact>,
    embedder: import("@ports/llm-client.js").LLMClient | null = null,
  ): Promise<void> {
    const sessionScope = await this.getSessionScopeById(tenantId, sessionId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ingestSessionFactsOnClient(client, tenantId, sessionId, facts, sessionScope);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (embedder) {
      for (const fact of batchWinners(facts)) {
        const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
        if (!factText) continue;
        try {
          const { vector } = await embedder.embed(factText, "document");
          await factStore.upsertEmbedding(tenantId, fact.id, vector);
        } catch {
          // Best-effort; a per-fact embed failure leaves the fact current but
          // semantically unreachable until a future re-ingest.
        }
      }
    }
  }

  private async loadEntities(tenantId: string, ids: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const tc = tenantClausePg(tenantId, ids.length + 1);
    const result = await this.pool.query<{ session_id: string; entity_canonical: string }>(
      `SELECT session_id, entity_canonical FROM session_entities
       WHERE session_id IN (${placeholders}) AND ${tc.sql} ORDER BY session_id`,
      [...ids, tc.param],
    );
    const out = new Map<string, string[]>();
    for (const r of result.rows) {
      const list = out.get(r.session_id);
      if (list) list.push(r.entity_canonical);
      else out.set(r.session_id, [r.entity_canonical]);
    }
    return out;
  }

  private async loadMarkers(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { decisions: string[]; open: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await this.pool.query<{ session_id: string; kind: "decision" | "open"; text: string }>(
      `SELECT session_id, kind, text FROM markers
       WHERE session_id IN (${placeholders}) ORDER BY session_id, position`,
      [...ids],
    );
    const out = new Map<string, { decisions: string[]; open: string[] }>();
    for (const r of result.rows) {
      let bucket = out.get(r.session_id);
      if (!bucket) { bucket = { decisions: [], open: [] }; out.set(r.session_id, bucket); }
      if (r.kind === "decision") bucket.decisions.push(r.text);
      else bucket.open.push(r.text);
    }
    return out;
  }

  private async loadEdges(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { supersededBy: string | null; supersedes: string[] }>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    // Both IN clauses reference the same $1..$n placeholders, so bind `ids`
    // once — not twice. (Passing [...ids, ...ids] over-supplies parameters and
    // PG rejects the bind: "supplies N parameters but requires M".)
    const result = await this.pool.query<{ from_session: string; to_session: string }>(
      `SELECT from_session, to_session FROM session_edges
       WHERE kind = 'supersedes'
         AND (from_session IN (${placeholders}) OR to_session IN (${placeholders}))`,
      [...ids],
    );
    const out = new Map<string, { supersededBy: string | null; supersedes: string[] }>();
    for (const id of ids) out.set(id, { supersededBy: null, supersedes: [] });
    for (const r of result.rows) {
      out.get(r.from_session)?.supersedes.push(r.to_session);
      const toEntry = out.get(r.to_session);
      if (toEntry) toEntry.supersededBy = r.from_session;
    }
    return out;
  }
}

function sanitizeTsToken(token: string): string {
  return token.replace(/[&|!():*'<]/g, "");
}

function rowToSession(
  row: SessionRow,
  entitiesById: Map<string, string[]>,
  markersById: Map<string, { decisions: string[]; open: string[] }>,
  overlay: ActionOverlay,
  edges?: { supersededBy: string | null; supersedes: string[] },
): Session {
  const m = markersById.get(row.id);
  const rawDecisions = m?.decisions ?? [];
  const rawOpen = m?.open ?? [];

  const activeOpen: string[] = [];
  const promotedDecisions: string[] = [];
  for (const text of rawOpen) {
    const id = openQuestionId(row.id, text);
    if (overlay.resolvedOpens.has(id)) continue;
    const resolution = overlay.promotedOpens.get(id);
    if (resolution !== undefined) {
      promotedDecisions.push(resolution);
      continue;
    }
    activeOpen.push(text);
  }

  return {
    id: row.id,
    runtime: row.runtime,
    runtimeSessionId: row.runtime_session_id ?? "",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMin: row.duration_min,
    label: row.label,
    summary: row.summary,
    status: liveSessionStatus(row.transcript_path, row.status),
    transcriptKind: row.transcript_kind ?? "",
    transcriptPath: row.transcript_path,
    body: row.body ?? "",
    entities: entitiesById.get(row.id) ?? [],
    decisions: [...rawDecisions, ...promotedDecisions],
    open: activeOpen,
    ...(edges !== undefined
      ? { supersededBy: edges.supersededBy, supersedes: edges.supersedes }
      : {}),
    workstreamId: row.workstream_id ?? null,
    classifierProvider: row.classifier_provider ?? null,
    classifierModel: row.classifier_model ?? null,
    classifierConfidence: row.classifier_confidence ?? null,
    agentPersona: row.agent_persona ?? null,
    parentSessionId: row.parent_session_id ?? null,
    primaryModel: row.primary_model ?? null,
    totalTokens: row.total_tokens ?? null,
    skill: row.skill ?? null,
  };
}
