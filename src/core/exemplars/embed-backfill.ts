/**
 * exemplar embed-backfill — (re)embed code_exemplars rows that are missing a
 * vector. The /api/signal capture path embeds exemplars fire-and-forget; a
 * cold CodeRankEmbed model on first capture can drop the vector, leaving the
 * exemplar permanently unretrievable (recall_code is vector-only). This is
 * the repair: discover rows with no entry in code_exemplars_vec, embed
 * taskContext + code via the CodeEmbedder, and upsert the vector.
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
import { composeEmbedText } from "./embed-text.js";

export interface ExemplarBackfillOptions {
  readonly tenantId: string;
  readonly dbPath: string;
  readonly embedder: CodeEmbedder;
  readonly store: CodeExemplarStore;
  readonly limit?: number;
  readonly onProgress?: (i: number, total: number, id: string, status: string) => void;
}

export interface ExemplarBackfillReport {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly dbMissing: boolean;
}

interface MissingRow {
  id: string;
  task_context: string;
  code: string;
}

export async function backfillExemplarEmbeddings(
  opts: ExemplarBackfillOptions,
): Promise<ExemplarBackfillReport> {
  if (!existsSync(opts.dbPath)) {
    return { total: 0, succeeded: 0, failed: 0, dbMissing: true };
  }

  const db = new Database(opts.dbPath, { readonly: true });
  sqliteVec.load(db);

  let rows: MissingRow[];
  try {
    const sql =
      "SELECT e.id, e.task_context, e.code FROM code_exemplars e " +
      "WHERE e.id NOT IN (SELECT exemplar_id FROM code_exemplars_vec) " +
      "ORDER BY e.created_at" +
      (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "");
    rows = db.prepare<[], MissingRow>(sql).all();
  } finally {
    db.close();
  }

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

  return { total, succeeded, failed, dbMissing: false };
}
