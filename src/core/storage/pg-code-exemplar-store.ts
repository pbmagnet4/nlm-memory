/**
 * PgCodeExemplarStore — CodeExemplarStore over pg.Pool + pgvector.
 *
 * Behavioural mirror of SqliteCodeExemplarStore: insert is idempotent on the
 * deterministic id (sha256(install_scope|repo|code_hash|outcome)[:16]), the
 * vec lane is managed via upsertEmbedding, and search over-fetches by L2
 * distance then reranks in JS (negatives + reverted rows downranked).
 *
 * Embeddings live in code_exemplar_embeddings with ON DELETE CASCADE, so the
 * prune/cap deletes here don't need separate vec bookkeeping (unlike the
 * SQLite store, which deletes from code_exemplars_vec explicitly).
 */

import type { Pool } from "pg";
import type { CodeExemplarSearchFilter, CodeExemplarStore, ExemplarVerdictPatch, ExemplarVerdictResult, ExemplarVerdictSource } from "@ports/code-exemplar-store.js";
import type { CodeExemplar, CodeExemplarHit, CodeExemplarInput, CodeExemplarOutcome } from "@shared/types.js";
import { exemplarId } from "./sqlite-code-exemplar-store.js";

const VEC_DIM = 768;

const COLUMNS =
  "id, install_scope, signal_id, session_id, repo, model, lang, " +
  "task_context, code, code_hash, outcome, git_sha, survived, ts, created_at, " +
  "retired_at, label_source";

interface ExemplarRow {
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
}

function insertParams(input: CodeExemplarInput): unknown[] {
  const id = exemplarId({
    installScope: input.installScope,
    repo: input.repo,
    codeHash: input.codeHash,
    outcome: input.outcome,
  });
  return [
    id,
    input.installScope,
    input.signalId,
    input.sessionId,
    input.repo,
    input.model,
    input.lang,
    input.taskContext,
    input.code,
    input.codeHash,
    input.outcome,
    input.gitSha,
    input.survived,
    input.ts,
  ];
}

const INSERT_SQL = `
  INSERT INTO code_exemplars
    (id, install_scope, signal_id, session_id, repo, model, lang,
     task_context, code, code_hash, outcome, git_sha, survived, ts)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  ON CONFLICT (id) DO NOTHING
`;

export class PgCodeExemplarStore implements CodeExemplarStore {
  constructor(private readonly pool: Pool) {}

  async insert(input: CodeExemplarInput): Promise<{ id: string; skipped: boolean }> {
    const params = insertParams(input);
    const res = await this.pool.query(INSERT_SQL, params);
    return { id: params[0] as string, skipped: res.rowCount === 0 };
  }

  async insertMany(inputs: ReadonlyArray<CodeExemplarInput>): Promise<number> {
    if (inputs.length === 0) return 0;
    const client = await this.pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      for (const input of inputs) {
        const res = await client.query(INSERT_SQL, insertParams(input));
        if (res.rowCount && res.rowCount > 0) inserted++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return inserted;
  }

  async upsertEmbedding(exemplarId: string, vector: Float32Array): Promise<void> {
    if (vector.length !== VEC_DIM) {
      throw new Error(`code exemplar embeddings must be ${VEC_DIM}-dim (got ${vector.length})`);
    }
    const vecStr = `[${Array.from(vector).join(",")}]`;
    await this.pool.query(
      `INSERT INTO code_exemplar_embeddings (exemplar_id, embedding)
       VALUES ($1, $2::vector)
       ON CONFLICT (exemplar_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [exemplarId, vecStr],
    );
  }

  async searchByVector(
    queryVector: Float32Array,
    filter: CodeExemplarSearchFilter,
  ): Promise<ReadonlyArray<CodeExemplarHit>> {
    const k = Math.max(1, Math.min(50, filter.k ?? 5));
    const includeNegatives = filter.includeNegatives ?? true;
    const overFetch = k * 4;
    const vecStr = `[${Array.from(queryVector).join(",")}]`;

    // pgvector <-> is L2 distance; OllamaCodeEmbedder L2-normalises vectors,
    // so this orders identically to cosine and matches the SQLite vec0 lane.
    const res = await this.pool.query<ExemplarRow & { distance: number }>(
      `SELECT ${COLUMNS.split(", ").map((c) => `ce.${c}`).join(", ")},
              e.embedding <-> $1::vector AS distance
       FROM code_exemplar_embeddings e
       JOIN code_exemplars ce ON ce.id = e.exemplar_id
       WHERE ce.install_scope = $2 AND ce.retired_at IS NULL
       ORDER BY e.embedding <-> $1::vector
       LIMIT $3`,
      [vecStr, filter.installScope, overFetch],
    );

    let hits = res.rows.map((r): CodeExemplarHit => ({
      id: r.id,
      code: r.code,
      taskContext: r.task_context,
      outcome: r.outcome,
      repo: r.repo,
      model: r.model,
      lang: r.lang,
      survived: r.survived as 0 | 1 | null,
      gitSha: r.git_sha,
      distance: Number(r.distance),
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
    const res = await this.pool.query<ExemplarRow>(
      `SELECT ${COLUMNS} FROM code_exemplars WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? this.rowToExemplar(row) : null;
  }

  async applyBucketCap(installScope: string, maxPerBucket: number): Promise<number> {
    // Window-rank within each (repo, lang, outcome-class) bucket newest-first,
    // delete everything past the cap. Cascade clears the embeddings.
    const res = await this.pool.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY repo, lang,
             CASE WHEN outcome IN ('pass', 'fix') THEN 'positive' ELSE 'negative' END
           ORDER BY ts DESC
         ) AS rn
         FROM code_exemplars
         WHERE install_scope = $1
       )
       DELETE FROM code_exemplars
       WHERE id IN (SELECT id FROM ranked WHERE rn > $2)`,
      [installScope, maxPerBucket],
    );
    return res.rowCount ?? 0;
  }

  async pruneReverted(installScope: string): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM code_exemplars WHERE install_scope = $1 AND survived = 0",
      [installScope],
    );
    return res.rowCount ?? 0;
  }

  async setVerdict(
    id: string,
    patch: ExemplarVerdictPatch,
    source: ExemplarVerdictSource,
  ): Promise<ExemplarVerdictResult> {
    const cur = await this.pool.query<{ label_source: "llm" | "human" }>(
      "SELECT label_source FROM code_exemplars WHERE id = $1",
      [id],
    );
    if (cur.rows.length === 0) return { status: "not_found" };
    if (source === "llm" && cur.rows[0]!.label_source === "human") return { status: "human_locked" };

    const sets: string[] = [];
    const values: unknown[] = [];
    let n = 1;
    sets.push(`label_source = $${n++}`);
    values.push(source);
    if (patch.retired !== undefined) {
      sets.push(`retired_at = $${n++}`);
      values.push(patch.retired ? new Date().toISOString() : null);
    }
    if (patch.outcome !== undefined) {
      sets.push(`outcome = $${n++}`);
      values.push(patch.outcome);
    }
    values.push(id);
    await this.pool.query(`UPDATE code_exemplars SET ${sets.join(", ")} WHERE id = $${n}`, values);
    return { status: "applied" };
  }

  async pruneOlderThan(olderThanTs: string): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM code_exemplars WHERE ts < $1",
      [olderThanTs],
    );
    return res.rowCount ?? 0;
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
