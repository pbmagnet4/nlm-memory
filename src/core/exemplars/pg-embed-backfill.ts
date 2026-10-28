/**
 * pg exemplar embed-backfill — Postgres twin of `backfillExemplarEmbeddings`
 * (embed-backfill.ts): probe the code embedder once, compare it with the
 * `embedding_config` code row and the `code_exemplar_embeddings` column dim,
 * rebuild on a mismatch (clear rows, ALTER the column to `vector(dim)`,
 * recreate the ivfflat index), then embed every exemplar with no vector.
 *
 * As on SQLite, the config row is written straight after the rebuild so an
 * interrupted run resumes by absence-discovery without clearing again. The
 * write is an awaited pool.query, never the fire-and-forget config store.
 */

import type { Pool } from "pg";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { EmbeddingLaneConfig } from "@core/embedding/embedding-config.js";
import { embedMissingRows, type ExemplarBackfillReport, type MissingRow, type OnStale } from "./embed-backfill.js";

export interface PgExemplarBackfillOptions {
  readonly tenantId: string;
  readonly pool: Pool;
  readonly embedder: CodeEmbedder;
  readonly store: CodeExemplarStore;
  readonly provider: string;
  readonly model: string;
  readonly onStale: OnStale;
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly onProgress?: (i: number, total: number, id: string, status: string) => void;
}

const PROBE_TEXT = "nlm dimension probe";

export async function backfillExemplarEmbeddingsPg(opts: PgExemplarBackfillOptions): Promise<ExemplarBackfillReport> {
  const { pool } = opts;
  const probe = await opts.embedder.embed(PROBE_TEXT, "query");
  const runtime: EmbeddingLaneConfig = { lane: "code", provider: opts.provider, model: opts.model, dim: probe.dim };

  const cfg = await pool.query<{ provider: string; model: string; dim: number }>(
    "SELECT provider, model, dim FROM embedding_config WHERE lane = 'code'",
  );
  const stored = cfg.rows[0] ?? null;
  const typmod = await pool.query<{ dim: number }>(
    "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'code_exemplar_embeddings'::regclass AND attname = 'embedding'",
  );
  const tableDim = typmod.rows[0]?.dim ?? null;

  const identityMatch =
    stored === null || (stored.provider === runtime.provider && stored.model === runtime.model && stored.dim === runtime.dim);
  const stale = !identityMatch || tableDim !== runtime.dim;
  const was = stored ? `${stored.provider}/${stored.model}@${stored.dim}` : `table@${tableDim}`;
  const detail = `stored ${was} vs runtime ${runtime.provider}/${runtime.model}@${runtime.dim}`;

  if (stale && (opts.dryRun || opts.onStale === "skip")) {
    process.stderr.write(
      opts.dryRun
        ? `[pg-exemplar-backfill] dry-run: ${detail}. Would clear code_exemplar_embeddings, ALTER to vector(${runtime.dim}) and re-embed every exemplar.\n`
        : `[pg-exemplar-backfill] code lane stale (${detail}); skipping, run \`nlm embed-backfill --exemplars\` to rebuild\n`,
    );
    return { total: 0, succeeded: 0, failed: 0, dbMissing: false, stale: true, ...(opts.dryRun ? { dryRun: true } : {}) };
  }
  if (opts.dryRun) {
    process.stderr.write(`[pg-exemplar-backfill] dry-run: config matches (${runtime.provider}/${runtime.model}@${runtime.dim}), no rebuild needed.\n`);
    return { total: 0, succeeded: 0, failed: 0, dbMissing: false, dryRun: true };
  }

  if (stale) {
    process.stderr.write(`[pg-exemplar-backfill] rebuilding code_exemplar_embeddings: ${detail}\n`);
    await pool.query("DELETE FROM code_exemplar_embeddings");
    await pool.query("DROP INDEX IF EXISTS code_exemplar_embeddings_idx");
    await pool.query(`ALTER TABLE code_exemplar_embeddings ALTER COLUMN embedding TYPE vector(${runtime.dim})`);
    await pool.query(
      "CREATE INDEX code_exemplar_embeddings_idx ON code_exemplar_embeddings USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)",
    );
  }
  if (stale || stored === null) {
    await pool.query(
      `INSERT INTO embedding_config (lane, provider, model, dim, updated_at)
       VALUES ('code', $1, $2, $3, $4)
       ON CONFLICT (lane) DO UPDATE SET
         provider = EXCLUDED.provider, model = EXCLUDED.model, dim = EXCLUDED.dim, updated_at = EXCLUDED.updated_at`,
      [runtime.provider, runtime.model, runtime.dim, new Date().toISOString()],
    );
  }

  const { rows } = await pool.query<MissingRow>(
    "SELECT e.id, e.task_context, e.code FROM code_exemplars e " +
      "WHERE NOT EXISTS (SELECT 1 FROM code_exemplar_embeddings v WHERE v.exemplar_id = e.id) " +
      "ORDER BY e.created_at" +
      (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : ""),
  );
  const loop = await embedMissingRows(rows, opts);
  return { ...loop, dbMissing: false, ...(stale ? { rebuilt: true } : {}) };
}
