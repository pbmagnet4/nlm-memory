/**
 * SqliteCodeExemplarStore — CodeExemplarStore over the shared better-sqlite3
 * connection (same handle as the rest of SqliteStorage).
 *
 * Insert is idempotent: a duplicate (install_scope, code_hash) is a no-op
 * (INSERT OR IGNORE on the primary key, which is sha256 of the dedup tuple).
 * The vec lane is managed separately via upsertEmbedding; inserts succeed
 * even when no embedder is configured.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CodeExemplarSearchFilter, CodeExemplarStore, ExemplarVerdictPatch, ExemplarVerdictResult, ExemplarVerdictSource } from "@ports/code-exemplar-store.js";
import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";

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

  async insert(input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }> {
    const id = exemplarId({
      installScope: input.installScope,
      repo: input.repo,
      codeHash: input.codeHash,
      outcome: input.outcome,
    });
    const info = this.insertStmt().run(this.toRow(id, input));
    return { id, skipped: info.changes === 0 };
  }

  async insertMany(inputs: ReadonlyArray<CodeExemplarInput>): Promise<number> {
    if (inputs.length === 0) return 0;
    const stmt = this.insertStmt();
    let inserted = 0;
    const txn = this.db.transaction((rows: ReadonlyArray<ExemplarRow>) => {
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
        return this.toRow(id, inp);
      }),
    );
    return inserted;
  }

  async upsertEmbedding(exemplarId: string, vector: Float32Array): Promise<void> {
    if (vector.length !== VEC_DIM) {
      throw new Error(`code exemplar embeddings must be ${VEC_DIM}-dim (got ${vector.length})`);
    }
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare("DELETE FROM code_exemplars_vec WHERE exemplar_id = ?").run(exemplarId);
    this.db
      .prepare("INSERT INTO code_exemplars_vec (exemplar_id, embedding) VALUES (?, ?)")
      .run(exemplarId, buf);
  }

  async searchByVector(
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

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], ExemplarRow>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at
         FROM code_exemplars
         WHERE id IN (${placeholders}) AND install_scope = ? AND retired_at IS NULL`,
      )
      .all(...ids, filter.installScope) as ExemplarRow[];

    let hits = rows.map((r): CodeExemplarHit => ({
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

  async getById(id: string): Promise<CodeExemplar | null> {
    const row = this.db
      .prepare<[string], ExemplarRow>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at,
                retired_at, label_source
         FROM code_exemplars WHERE id = ?`,
      )
      .get(id);
    return row ? this.rowToExemplar(row) : null;
  }

  async listBySessions(sessionIds: ReadonlyArray<string>): Promise<ReadonlyArray<CodeExemplar>> {
    if (sessionIds.length === 0) return [];
    const ph = sessionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], ExemplarRow>(
        `SELECT id, install_scope, signal_id, session_id, repo, model, lang,
                task_context, code, code_hash, outcome, git_sha, survived, ts, created_at, retired_at, label_source
         FROM code_exemplars WHERE session_id IN (${ph}) AND retired_at IS NULL ORDER BY ts ASC`,
      )
      .all(...sessionIds) as ExemplarRow[];
    return rows.map((r) => this.rowToExemplar(r));
  }

  async applyBucketCap(installScope: string, maxPerBucket: number): Promise<number> {
    type BucketRow = { repo: string; lang: string | null; outcome_class: string };
    const buckets = this.db
      .prepare<[string], BucketRow>(
        `SELECT DISTINCT repo, lang,
           CASE WHEN outcome IN ('pass','fix') THEN 'positive' ELSE 'negative' END AS outcome_class
         FROM code_exemplars WHERE install_scope = ?`,
      )
      .all(installScope);

    let deleted = 0;
    const delStmt = this.db.prepare("DELETE FROM code_exemplars WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const bucket of buckets) {
        const outcomeList = bucket.outcome_class === "positive" ? ["pass", "fix"] : ["fail", "exhausted"];
        const placeholders = outcomeList.map(() => "?").join(",");
        const langFilter = bucket.lang !== null ? "AND lang = ?" : "AND lang IS NULL";
        const params: Array<string | null> =
          bucket.lang !== null
            ? [installScope, bucket.repo, bucket.lang, ...outcomeList]
            : [installScope, bucket.repo, ...outcomeList];

        type IdRow = { id: string };
        const allIds = this.db
          .prepare<Array<string | null>, IdRow>(
            `SELECT id FROM code_exemplars
             WHERE install_scope = ? AND repo = ? ${langFilter}
               AND outcome IN (${placeholders})
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

  async pruneReverted(installScope: string): Promise<number> {
    type IdRow = { id: string };
    const ids = this.db
      .prepare<[string], IdRow>(
        "SELECT id FROM code_exemplars WHERE install_scope = ? AND survived = 0",
      )
      .all(installScope)
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
    id: string,
    patch: ExemplarVerdictPatch,
    source: ExemplarVerdictSource,
  ): Promise<ExemplarVerdictResult> {
    const row = this.db
      .prepare<[string], { label_source: "llm" | "human" }>(
        "SELECT label_source FROM code_exemplars WHERE id = ?",
      )
      .get(id);
    if (!row) return { status: "not_found" };
    if (source === "llm" && row.label_source === "human") return { status: "human_locked" };

    const sets: string[] = ["label_source = @source"];
    const params: Record<string, unknown> = { id, source };
    if (patch.retired !== undefined) {
      sets.push("retired_at = @retiredAt");
      params["retiredAt"] = patch.retired ? new Date().toISOString() : null;
    }
    if (patch.outcome !== undefined) {
      sets.push("outcome = @outcome");
      params["outcome"] = patch.outcome;
    }
    this.db.prepare(`UPDATE code_exemplars SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return { status: "applied" };
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    type IdRow = { id: string };
    const ids = this.db
      .prepare<[string], IdRow>("SELECT id FROM code_exemplars WHERE ts < ?")
      .all(olderThanTs)
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
    return this.db.prepare<ExemplarRow>(`
      INSERT OR IGNORE INTO code_exemplars (
        id, install_scope, signal_id, session_id, repo, model, lang,
        task_context, code, code_hash, outcome, git_sha, survived, ts, created_at
      ) VALUES (
        @id, @install_scope, @signal_id, @session_id, @repo, @model, @lang,
        @task_context, @code, @code_hash, @outcome, @git_sha, @survived, @ts, @created_at
      )
    `);
  }

  private toRow(id: string, inp: CodeExemplarInput): ExemplarRow {
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
      ts: inp.ts,
      created_at: new Date().toISOString(),
      retired_at: null,
      label_source: "llm",
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
      ts: row.ts,
      createdAt: row.created_at,
      retiredAt: row.retired_at,
      labelSource: row.label_source,
    };
  }
}
