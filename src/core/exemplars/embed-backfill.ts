/**
 * exemplar embed-backfill — (re)embed code_exemplars rows that are missing a
 * vector. The /api/signal capture path embeds exemplars fire-and-forget; a
 * cold CodeRankEmbed model on first capture can drop the vector, leaving the
 * exemplar permanently unretrievable (recall_code is vector-only). This is
 * the repair: discover rows with no entry in code_exemplars_vec, embed
 * taskContext + code via the CodeEmbedder, and upsert the vector.
 *
 * Lane rebuild (T1179): the code embedder is probed once and compared with the
 * `embedding_config` code row and the vec table's dim. On a mismatch, onStale
 * "rebuild" drops and recreates `code_exemplars_vec` at the probed dim and
 * writes the config row immediately (so an interrupted run resumes by
 * absence-discovery instead of dropping again); "skip" (the daemon sweep)
 * writes nothing. pg twin: pg-embed-backfill.ts.
 *
 * Mirrors the session embed-backfill (reembedCorpus): same embed-text shape
 * as the live capture path (composeEmbedText, role "document"), the store's
 * existing upsertEmbedding, and a single retry on transient
 * embedder failures. Idempotent — rows that already have a vector are skipped
 * (discovery is by absence in the vec table, so a second run finds nothing).
 *
 * Layering: depends on the CodeExemplarStore port for the upsert and on a
 * read-only better-sqlite3 handle for discovery (the store has no
 * "list rows missing a vector" method and adding one to the port for a
 * one-shot operational tool isn't worth it — same direct-SQLite call the
 * session backfill makes).
 *
 * Tenancy: this is an operator-run local CLI maintenance tool (`nlm
 * embed-backfill --exemplars`), not a corpus-returning surface in the
 * disposition table — the discovery query stays whole-DB (it repairs
 * dropped embeddings across every row missing one), while the write itself
 * routes through the now-tenant-checked `upsertEmbedding` so a tenant
 * mismatch (impossible in local single-tenant mode; relevant once M3 wires
 * a hosted equivalent) is a no-op, not a cross-tenant write.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import type { EmbeddingLaneConfig } from "@core/embedding/embedding-config.js";
import { SqliteEmbeddingConfigStore } from "@core/storage/sqlite-embedding-config.js";
import { composeEmbedText } from "./embed-text.js";

/** What to do when the code lane's stored vectors come from a different provider/model/dim. */
export type OnStale = "rebuild" | "skip";

const PROBE_TEXT = "nlm dimension probe";

export interface ExemplarBackfillOptions {
  readonly tenantId: string;
  readonly dbPath: string;
  readonly embedder: CodeEmbedder;
  readonly store: CodeExemplarStore;
  readonly limit?: number;
  /** Provider and model of `embedder`; recorded in embedding_config (the embedder port does not expose them). */
  readonly provider: string;
  readonly model: string;
  /**
   * "rebuild" (CLI, settings job) drops and recreates the vector table at the
   * probed dim; "skip" (the daemon's repair sweep) never drops and writes
   * nothing when the lane is stale.
   */
  readonly onStale: OnStale;
  /** Report what a rebuild would drop without writing anything. */
  readonly dryRun?: boolean;
  readonly onProgress?: (i: number, total: number, id: string, status: string) => void;
}

export interface ExemplarBackfillReport {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly dbMissing: boolean;
  /** The vector table was dropped and recreated at a new dim/model. */
  readonly rebuilt?: boolean;
  /** The lane is stale and nothing was written (onStale "skip", or dryRun). */
  readonly stale?: boolean;
  readonly dryRun?: boolean;
}

export interface MissingRow {
  id: string;
  task_context: string;
  code: string;
}

/** Dimension of the vec0 table, parsed from its CREATE statement; null when the table is absent. */
function vecTableDim(db: Database.Database): number | null {
  const row = db
    .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'code_exemplars_vec'")
    .get();
  const m = row ? /float\[(\d+)\]/.exec(row.sql) : null;
  return m ? Number(m[1]) : null;
}

function staleMessage(stored: EmbeddingLaneConfig | null, runtime: EmbeddingLaneConfig, tableDim: number | null): string {
  const was = stored ? `${stored.provider}/${stored.model}@${stored.dim}` : `table@${tableDim}`;
  return `stored ${was} vs runtime ${runtime.provider}/${runtime.model}@${runtime.dim}`;
}

export async function backfillExemplarEmbeddings(
  opts: ExemplarBackfillOptions,
): Promise<ExemplarBackfillReport> {
  if (!existsSync(opts.dbPath)) {
    return { total: 0, succeeded: 0, failed: 0, dbMissing: true };
  }

  const probe = await opts.embedder.embed(PROBE_TEXT, "query");
  const runtime: EmbeddingLaneConfig = { lane: "code", provider: opts.provider, model: opts.model, dim: probe.dim };

  const db = new Database(opts.dbPath);
  sqliteVec.load(db);

  let rows: MissingRow[];
  let rebuilt = false;
  try {
    const config = new SqliteEmbeddingConfigStore(db);
    const stored = config.getLane("code");
    const tableDim = vecTableDim(db);
    const identityMatch =
      stored === null || (stored.provider === runtime.provider && stored.model === runtime.model && stored.dim === runtime.dim);
    const stale = !identityMatch || tableDim !== runtime.dim;

    if (stale && (opts.dryRun || opts.onStale === "skip")) {
      const detail = staleMessage(stored, runtime, tableDim);
      process.stderr.write(
        opts.dryRun
          ? `[exemplar-backfill] dry-run: ${detail}. Would DROP code_exemplars_vec and re-embed every exemplar.\n`
          : `[exemplar-backfill] code lane stale (${detail}); skipping, run \`nlm embed-backfill --exemplars\` to rebuild\n`,
      );
      return { total: 0, succeeded: 0, failed: 0, dbMissing: false, stale: true, ...(opts.dryRun ? { dryRun: true } : {}) };
    }
    if (opts.dryRun) {
      process.stderr.write(`[exemplar-backfill] dry-run: config matches (${runtime.provider}/${runtime.model}@${runtime.dim}), no rebuild needed.\n`);
      return { total: 0, succeeded: 0, failed: 0, dbMissing: false, dryRun: true };
    }

    if (stale) {
      process.stderr.write(`[exemplar-backfill] rebuilding code_exemplars_vec: ${staleMessage(stored, runtime, tableDim)}\n`);
      db.exec("DROP TABLE IF EXISTS code_exemplars_vec");
      db.exec(
        `CREATE VIRTUAL TABLE code_exemplars_vec USING vec0(exemplar_id TEXT PRIMARY KEY, embedding float[${runtime.dim}])`,
      );
      rebuilt = true;
    }
    // Written straight after the drop: an interrupted run then resumes by
    // absence-discovery instead of dropping the vectors it already rebuilt.
    if (stale || stored === null) config.upsertLane(runtime, new Date().toISOString());

    const sql =
      "SELECT e.id, e.task_context, e.code FROM code_exemplars e " +
      "WHERE e.id NOT IN (SELECT exemplar_id FROM code_exemplars_vec) " +
      "ORDER BY e.created_at" +
      (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "");
    rows = db.prepare<[], MissingRow>(sql).all();
  } finally {
    db.close();
  }

  const loopReport = await embedMissingRows(rows, opts);
  return { ...loopReport, dbMissing: false, ...(rebuilt ? { rebuilt } : {}) };
}

interface EmbedLoopOptions {
  readonly tenantId: string;
  readonly embedder: CodeEmbedder;
  readonly store: CodeExemplarStore;
  readonly onProgress?: (i: number, total: number, id: string, status: string) => void;
}

/** Embeds each row (one retry on a transient embedder failure) and upserts the vector; shared by the SQLite and pg backfills. */
export async function embedMissingRows(
  rows: ReadonlyArray<MissingRow>,
  opts: EmbedLoopOptions,
): Promise<{ total: number; succeeded: number; failed: number }> {
  const total = rows.length;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const idx = i + 1;
    const text = composeEmbedText(row.task_context, row.code);

    let vector: Float32Array | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await opts.embedder.embed(text, "document");
        vector = out.vector;
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof LLMUnreachableError)) throw e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (vector === undefined) {
      failed += 1;
      opts.onProgress?.(idx, total, row.id, `FAIL (embedder): ${(lastErr as Error)?.message ?? "unknown"}`);
      continue;
    }

    try {
      await opts.store.upsertEmbedding(opts.tenantId, row.id, vector);
    } catch (e) {
      failed += 1;
      opts.onProgress?.(idx, total, row.id, `FAIL (db): ${(e as Error).message}`);
      continue;
    }

    succeeded += 1;
    opts.onProgress?.(idx, total, row.id, "OK");
  }

  return { total, succeeded, failed };
}
