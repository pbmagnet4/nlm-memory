/**
 * fact embed-backfill — (re)embed active facts that are missing a vector.
 *
 * The ingest path embeds facts best-effort: `SqliteSessionStore.embedFacts`
 * traps per-fact embed errors so one bad call can't abort a batch, which
 * leaves the fact row current but absent from `fact_embeddings`. Such a fact
 * is still keyword-recallable via FTS5 and permanently invisible to semantic
 * recall — and nothing repairs it, because the only existing fact re-embed
 * runs inside `reembedCorpus` and is gated behind an embedder config change
 * (a same-config rerun reembeds sessions only). This is that missing repair.
 *
 * Mirrors the exemplar embed-backfill (backfillExemplarEmbeddings): same
 * discovery-by-absence, the store's existing tenant-checked upsertEmbedding,
 * and a single retry on transient embedder failures. The retry matters here
 * specifically — the measured production failure is sporadic (~1 in 26 calls,
 * a steady 3-10% on every busy day since April), not a sustained outage, so
 * most rows succeed on a second attempt.
 *
 * Embed text is `${subject} ${predicate} ${value}`.trim() with role
 * "document", byte-identical to embedFacts. A different shape here would
 * produce vectors that don't sit in the same space as live-path ones.
 *
 * Only recall-eligible facts are embedded (superseded_by IS NULL AND
 * retired_at IS NULL). Embedding a dead fact would reintroduce exactly the
 * ghost vectors scripts/repair-fact-embeddings.mjs deletes (#351), where they
 * consume ANN k-nearest slots and reduce effective recall.
 *
 * Idempotent: discovery is by absence from the vec table, so a second run
 * finds nothing.
 *
 * Layering: depends on the FactStore port for the upsert and on a read-only
 * better-sqlite3 handle for discovery — the port has no "list rows missing a
 * vector" method, and adding one for a one-shot operational tool isn't worth
 * it. Same direct-SQLite call the session and exemplar backfills make.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { FactStore } from "@ports/fact-store.js";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";

export interface FactBackfillOptions {
  readonly tenantId: string;
  readonly dbPath: string;
  readonly embedder: LLMClient;
  readonly store: FactStore;
  readonly limit?: number;
  readonly onProgress?: (i: number, total: number, id: string, status: string) => void;
}

export interface FactBackfillReport {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly dbMissing: boolean;
}

interface MissingRow {
  id: string;
  subject: string;
  predicate: string;
  value: string;
}

/** Byte-identical to SqliteSessionStore.embedFacts — keep the two in sync. */
export function composeFactEmbedText(
  subject: string,
  predicate: string,
  value: string,
): string {
  return `${subject} ${predicate} ${value}`.trim();
}

export async function backfillFactEmbeddings(
  opts: FactBackfillOptions,
): Promise<FactBackfillReport> {
  if (!existsSync(opts.dbPath)) {
    return { total: 0, succeeded: 0, failed: 0, dbMissing: true };
  }

  const db = new Database(opts.dbPath, { readonly: true });
  sqliteVec.load(db);

  let rows: MissingRow[];
  try {
    const sql =
      "SELECT f.id, f.subject, f.predicate, f.value FROM facts f " +
      "WHERE f.superseded_by IS NULL AND f.retired_at IS NULL " +
      "AND f.id NOT IN (SELECT fact_id FROM fact_embeddings) " +
      "ORDER BY f.created_at" +
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
    const text = composeFactEmbedText(row.subject, row.predicate, row.value);

    if (!text) {
      failed += 1;
      opts.onProgress?.(idx, total, row.id, "FAIL (empty embed text)");
      continue;
    }

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
      opts.onProgress?.(
        idx,
        total,
        row.id,
        `FAIL (embedder): ${(lastErr as Error)?.message ?? "unknown"}`,
      );
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
