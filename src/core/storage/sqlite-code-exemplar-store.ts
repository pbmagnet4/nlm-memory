/**
 * SqliteCodeExemplarStore — CodeExemplarStore over the shared better-sqlite3
 * connection (same handle as the rest of SqliteStorage).
 *
 * Insert is idempotent: a duplicate (install_scope, code_hash) is a no-op
 * (INSERT OR IGNORE on the primary key, which is sha256 of the dedup tuple).
 * The vec lane is managed separately via upsertEmbedding; inserts succeed
 * even when no embedder is configured.
 *
 * Tenancy (program spec §4, M2 plan Wave B3): every method takes `tenantId`
 * as its non-optional first parameter. `code_exemplars` is a STAMP table;
 * every SELECT/UPDATE/DELETE routes its WHERE fragment through
 * `tenantClause`, and INSERTs stamp `tenant_id` explicitly.
 * `code_exemplars_vec` carries no tenant_id (DERIVE-VIA-FK) — `searchByVector`
 * is the purest vector path in the codebase (no keyword pre-filter at all);
 * its tenant filter is applied inside the id-resolution SQL join against
 * `code_exemplars`, with a JS re-check of each row's own tenant_id as
 * defense in depth (never a substitute for the SQL filter).
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CodeExemplarSearchFilter, CodeExemplarStore, ExemplarVerdictPatch, ExemplarVerdictResult, ExemplarVerdictSource } from "@ports/code-exemplar-store.js";
import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";

const VEC_DIM = 768;

type ExemplarRow = {
  id: string;
  install_scope: string;
  signal_id: string | null;
  session_id: string | null;
  repo: string;
  model: string;
  lang: string | null;
  task_context: string;
  code: string;
  code_hash: string;
  outcome: CodeExemplarOutcome;
  git_sha: string | null;
  survived: number | null;
  // Absent on reads while stamping is write-only (#348 Stage A): read SELECTs
  // stay scope-free until the enforcement task.
  scope?: string | null;
  ts: string;
  created_at: string;
  retired_at: string | null;
  label_source: "llm" | "human";
};

/**
 * Deterministic primary key: sha256(install_scope|repo|code_hash|outcome)[:16].
 * Guarantees one row per unique (scope, repo, exact-code-content, outcome).
 */
export function exemplarId(parts: {
  installScope: string;
  repo: string;
  codeHash: string;
  outcome: string;
}): string {
  return createHash("sha256")
    .update([parts.installScope, parts.repo, parts.codeHash, parts.outcome].join("|"))
    .digest("hex")
    .slice(0, 16);
}

export class SqliteCodeExemplarStore implements CodeExemplarStore {
  constructor(private readonly db: Database.Database) {}

  async insert(tenantId: string, input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }> {
    const id = exemplarId({
      installScope: input.installScope,
      repo: input.repo,
      codeHash: input.codeHash,
      outcome: input.outcome,
    });
    const info = this.insertStmt().run(this.toRow(id, input, tenantId));
    return { id, skipped: info.changes === 0 };
  }

  async insertMany(tenantId: string, inputs: ReadonlyArray<CodeExemplarInput>): Promise<number> {
    if (inputs.length === 0) return 0;
    const stmt = this.insertStmt();
    let inserted = 0;
    const txn = this.db.transaction((rows: ReadonlyArray<ExemplarRow & { tenant_id: string }>) => {
      for (const row of rows) {
        const info = stmt.run(row);
        if (info.changes > 0) inserted++;
      }
    });
    txn(
      inputs.map((inp) => {
        const id = exemplarId({
          installScope: inp.installScope,
          repo: inp.repo,
          codeHash: inp.codeHash,
          outcome: inp.outcome,
        });
        return this.toRow(id, inp, tenantId);
      }),
    );
    return inserted;
  }

  /**
   * No-op if exemplarId isn't owned by tenantId — writing an embedding for
   * another tenant's exemplar must never fall through to a write.
   */
  async upsertEmbedding(tenantId: string, exemplarId: string, vector: Float32Array): Promise<void> {
    if (vector.length !== VEC_DIM) {
      throw new Error(`code exemplar embeddings must be ${VEC_DIM}-dim (got ${vector.length})`);
    }
    const tc = tenantClause(tenantId);
    const owned = this.db
      .prepare<[string, string], { id: string }>(`SELECT id FROM code_exemplars WHERE id = ? AND ${tc.sql}`)
      .get(exemplarId, tc.param);
    if (!owned) return;
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare("DELETE FROM code_exemplars_vec WHERE exemplar_id = ?").run(exemplarId);
    this.db
      .prepare("INSERT INTO code_exemplars_vec (exemplar_id, embedding) VALUES (?, ?)")
      .run(exemplarId, buf);
  }

  async searchByVector(
    tenantId: string,
    queryVector: Float32Array,
    filter: CodeExemplarSearchFilter,
  ): Promise<ReadonlyArray<CodeExemplarHit>> {
    const k = Math.max(1, Math.min(50, filter.k ?? 5));
    const includeNegatives = filter.includeNegatives ?? true;
    const queryBuf = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

    // vec0 doesn't support WHERE on aux columns, so we over-fetch and filter in JS.
    const overFetch = k * 4;

    type VecRow = { exemplar_id: string; distance: number };
    const vecRows = this.db
      .prepare<[Buffer, number], VecRow>(
        `SELECT exemplar_id, distance FROM code_exemplars_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(queryBuf, overFetch);

    if (vecRows.length === 0) return [];

    const ids = vecRows.map((r) => r.exemplar_id);
    const distanceById = new Map<string, number>(vecRows.map((r) => [r.exemplar_id, r.distance]));

    // code_exemplars_vec carries no tenant_id (DERIVE-VIA-FK) — the vec0 KNN
    // scan returns neighbors from the whole corpus regardless of tenant. The
    // tenant filter is re-applied HERE, inside the id-resolution SQL against
    // code_exemplars (program spec §4.3 vector-path rule) — this is the
    // purest vector path in the codebase (no keyword pre-filter at all), so
    // a candidate exemplar id that fails to resolve within the caller's
    // tenant is excluded outright, not merely down-ranked.
    const placeholders = ids.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare<unknown[], ExemplarRow & { tenant_id: string }>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at, tenant_id
         FROM code_exemplars
         WHERE id IN (${placeholders}) AND install_scope = ? AND retired_at IS NULL AND ${tc.sql}`,
      )
      .all(...ids, filter.installScope, tc.param) as Array<ExemplarRow & { tenant_id: string }>;

    // Defense in depth (never a substitute for the SQL filter above): re-check
    // each resolved row's own tenant, read into a local first so this JS
    // comparison can never be mistaken by the tenant-guard scan for an
    // inlined SQL WHERE fragment (that literal is reserved for tenant-clause.ts).
    let hits = rows.filter((r) => { const rowTenant = r["tenant_id"]; return rowTenant === tenantId; }).map((r): CodeExemplarHit => ({
      id: r.id,
      code: r.code,
      taskContext: r.task_context,
      outcome: r.outcome,
      repo: r.repo,
      model: r.model,
      lang: r.lang,
      survived: r.survived as 0 | 1 | null,
      gitSha: r.git_sha,
      distance: distanceById.get(r.id) ?? 999,
    }));

    if (filter.repo !== undefined) hits = hits.filter((h) => h.repo === filter.repo);
    if (filter.lang !== undefined) hits = hits.filter((h) => h.lang === filter.lang);
    if (filter.model !== undefined) hits = hits.filter((h) => h.model === filter.model);
    if (!includeNegatives) hits = hits.filter((h) => h.outcome === "pass" || h.outcome === "fix");

    // Rerank: survived=0 is downranked; negatives sorted after positives at same distance.
    hits.sort((a, b) => {
      const aIsNeg = a.outcome === "fail" || a.outcome === "exhausted" ? 1 : 0;
      const bIsNeg = b.outcome === "fail" || b.outcome === "exhausted" ? 1 : 0;
      const aSurvPenalty = a.survived === 0 ? 0.05 : 0;
      const bSurvPenalty = b.survived === 0 ? 0.05 : 0;
      return (a.distance + aSurvPenalty + aIsNeg * 0.1) - (b.distance + bSurvPenalty + bIsNeg * 0.1);
    });

    return hits.slice(0, k);
  }

  async getById(tenantId: string, id: string): Promise<CodeExemplar | null> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare<[string, string], ExemplarRow>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at,
                retired_at, label_source
         FROM code_exemplars WHERE id = ? AND ${tc.sql}`,
      )
      .get(id, tc.param);
    return row ? this.rowToExemplar(row) : null;
  }

  async listBySessions(tenantId: string, sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>> {
    if (sessionIds.length === 0) return [];
    const ph = sessionIds.map(() => "?").join(",");
    const tc = tenantClause(tenantId);
    const rows = this.db
      .prepare<unknown[], ExemplarRow>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at, retired_at, label_source
         FROM code_exemplars WHERE session_id IN (${ph}) AND retired_at IS NULL AND ${tc.sql} ORDER BY ts ASC`,
      )
      .all(...sessionIds, tc.param) as ExemplarRow[];
    return rows.map((r) => this.rowToExemplar(r));
  }

  async applyBucketCap(tenantId: string, installScope: string, maxPerBucket: number): Promise<number> {
    type BucketRow = { repo: string; lang: string | null; outcome_class: string };
    const bucketTc = tenantClause(tenantId);
    const buckets = this.db
      .prepare<unknown[], BucketRow>(
        `SELECT DISTINCT repo, lang,
           CASE WHEN outcome IN ('pass','fix') THEN 'positive' ELSE 'negative' END AS outcome_class
         FROM code_exemplars WHERE install_scope = ? AND ${bucketTc.sql}`,
      )
      .all(installScope, bucketTc.param);

    let deleted = 0;
    const delStmt = this.db.prepare("DELETE FROM code_exemplars WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const bucket of buckets) {
        const outcomeList = bucket.outcome_class === "positive" ? ["pass", "fix"] : ["fail", "exhausted"];
        const placeholders = outcomeList.map(() => "?").join(",");
        const langFilter = bucket.lang !== null ? "AND lang = ?" : "AND lang IS NULL";
        const idsTc = tenantClause(tenantId);
        const params: Array<string | null> =
          bucket.lang !== null
            ? [installScope, bucket.repo, bucket.lang, ...outcomeList, idsTc.param]
            : [installScope, bucket.repo, ...outcomeList, idsTc.param];

        type IdRow = { id: string };
        const allIds = this.db
          .prepare<Array<string | null>, IdRow>(
            `SELECT id FROM code_exemplars
             WHERE install_scope = ? AND repo = ? ${langFilter}
               AND outcome IN (${placeholders})
               AND ${idsTc.sql}
             ORDER BY ts DESC`,
          )
          .all(...params)
          .map((r) => r.id);

        const toDelete = allIds.slice(maxPerBucket);
        for (const id of toDelete) {
          delStmt.run(id);
          this.db.prepare("DELETE FROM code_exemplars_vec WHERE exemplar_id = ?").run(id);
          deleted++;
        }
      }
    });
    txn();
    return deleted;
  }

  async pruneReverted(tenantId: string, installScope: string): Promise<number> {
    type IdRow = { id: string };
    const tc = tenantClause(tenantId);
    const ids = this.db
      .prepare<unknown[], IdRow>(
        `SELECT id FROM code_exemplars WHERE install_scope = ? AND survived = 0 AND ${tc.sql}`,
      )
      .all(installScope, tc.param)
      .map((r) => r.id);
    let deleted = 0;
    const txn = this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM code_exemplars WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM code_exemplars_vec WHERE exemplar_id = ?").run(id);
        deleted++;
      }
    });
    txn();
    return deleted;
  }

  async setVerdict(
    tenantId: string,
    id: string,
    patch: ExemplarVerdictPatch,
    source: ExemplarVerdictSource,
  ): Promise<ExemplarVerdictResult> {
    const tc = tenantClause(tenantId);
    const row = this.db
      .prepare<unknown[], { label_source: "llm" | "human" }>(
        `SELECT label_source FROM code_exemplars WHERE id = ? AND ${tc.sql}`,
      )
      .get(id, tc.param);
    if (!row) return { status: "not_found" };
    if (source === "llm" && row.label_source === "human") return { status: "human_locked" };

    const sets: string[] = ["label_source = ?"];
    const params: unknown[] = [source];
    if (patch.retired !== undefined) {
      sets.push("retired_at = ?");
      params.push(patch.retired ? new Date().toISOString() : null);
    }
    if (patch.outcome !== undefined) {
      sets.push("outcome = ?");
      params.push(patch.outcome);
    }
    const updateTc = tenantClause(tenantId);
    params.push(id, updateTc.param);
    this.db.prepare(`UPDATE code_exemplars SET ${sets.join(", ")} WHERE id = ? AND ${updateTc.sql}`).run(...params);
    return { status: "applied" };
  }

  async pruneOlderThan(tenantId: string, olderThanTs: string): Promise<number> {
    type IdRow = { id: string };
    const tc = tenantClause(tenantId);
    const ids = this.db
      .prepare<unknown[], IdRow>(`SELECT id FROM code_exemplars WHERE ts < ? AND ${tc.sql}`)
      .all(olderThanTs, tc.param)
      .map((r) => r.id);
    let deleted = 0;
    const txn = this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM code_exemplars WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM code_exemplars_vec WHERE exemplar_id = ?").run(id);
        deleted++;
      }
    });
    txn();
    return deleted;
  }

  private insertStmt() {
    return this.db.prepare<ExemplarRow & { tenant_id: string }>(`
      INSERT OR IGNORE INTO code_exemplars (
        id, install_scope, signal_id, session_id, repo, model, lang,
        task_context, code, code_hash, outcome, git_sha, survived, scope, ts, created_at, tenant_id
      ) VALUES (
        @id, @install_scope, @signal_id, @session_id, @repo, @model, @lang,
        @task_context, @code, @code_hash, @outcome, @git_sha, @survived, @scope, @ts, @created_at, @tenant_id
      )
    `);
  }

  private toRow(id: string, inp: CodeExemplarInput, tenantId: string): ExemplarRow & { tenant_id: string } {
    return {
      id,
      install_scope: inp.installScope,
      signal_id: inp.signalId,
      session_id: inp.sessionId,
      repo: inp.repo,
      model: inp.model,
      lang: inp.lang,
      task_context: inp.taskContext,
      code: inp.code,
      code_hash: inp.codeHash,
      outcome: inp.outcome,
      git_sha: inp.gitSha,
      survived: inp.survived,
      scope: inp.scope,
      ts: inp.ts,
      created_at: new Date().toISOString(),
      retired_at: null,
      label_source: "llm",
      tenant_id: tenantId,
    };
  }

  private rowToExemplar(row: ExemplarRow): CodeExemplar {
    return {
      id: row.id,
      installScope: row.install_scope,
      signalId: row.signal_id,
      sessionId: row.session_id,
      repo: row.repo,
      model: row.model,
      lang: row.lang,
      taskContext: row.task_context,
      code: row.code,
      codeHash: row.code_hash,
      outcome: row.outcome,
      gitSha: row.git_sha,
      survived: row.survived as 0 | 1 | null,
      scope: row.scope ?? null,
      ts: row.ts,
      createdAt: row.created_at,
      retiredAt: row.retired_at,
      labelSource: row.label_source,
    };
  }
}
