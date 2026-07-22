/**
 * pg-embed-backfill -- re-embed every session in the Postgres store into
 * session_embedding_chunks. Mirrors reembedCorpus from embed-backfill.ts
 * but drives a pg Pool instead of a SQLite file.
 *
 * Resumable via a JSON state file at $NLM_EMBED_STATE (default
 * ~/.nlm/embed_reembed_pg.state). Same SAVE_EVERY = 25 checkpoint cadence.
 *
 * When the probed dim/model/provider differs from the stored embedding_config
 * row, both vector tables are rebuilt: rows cleared, the embedding column
 * altered to the new dimension, and indexes recreated. Facts (superseded_by
 * IS NULL AND retired_at IS NULL) are reembedded after the session loop.
 * Same-config reruns skip the rebuild.
 *
 * CRITICAL: the final config write is an awaited pool.query() INSERT ON
 * CONFLICT -- never routed through PgEmbeddingConfigStore.upsertLane, which
 * is fire-and-forget and can be lost when pool.end() follows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Pool } from "pg";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import type { BackfillReport } from "@core/embedding/embed-backfill.js";

export type { BackfillReport };

const DEFAULT_STATE_PATH = join(homedir(), ".nlm", "embed_reembed_pg.state");
const SAVE_EVERY = 25;

export interface PgBackfillOptions {
  readonly pgUrl: string;
  readonly embedder: LLMClient;
  readonly statePath?: string;
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly embedderProvider?: string;
  readonly onProgress?: (i: number, total: number, sid: string, status: string) => void;
}

interface StateConfig {
  provider: string;
  model: string;
  dim: number;
}

interface StateData {
  done: Set<string>;
  config?: StateConfig;
}

function loadStateData(path: string): StateData {
  if (!existsSync(path)) return { done: new Set() };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      done?: string[];
      config?: StateConfig;
    };
    return { done: new Set(raw.done ?? []), ...(raw.config ? { config: raw.config } : {}) };
  } catch {
    return { done: new Set() };
  }
}

function saveState(path: string, done: Set<string>, config?: StateConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const data: { done: string[]; config?: StateConfig } = { done: [...done].sort() };
  if (config) data.config = config;
  writeFileSync(path, JSON.stringify(data));
}

export async function reembedCorpusPg(opts: PgBackfillOptions): Promise<BackfillReport> {
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const pool = new Pool({ connectionString: opts.pgUrl });

  try {
    const tableCheck = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'embedding_config') AS exists",
    );
    if (!tableCheck.rows[0]?.exists) {
      throw new Error(
        "embedding_config table not found; run `nlm migrate` to apply pending migrations",
      );
    }

    const probeResult = await opts.embedder.embed("nlm dimension probe", "query");
    const dim = probeResult.vector.length;
    const model = probeResult.model;
    const provider = opts.embedderProvider ?? process.env["NLM_EMBED_PROVIDER"] ?? "ollama";

    const cfgRows = await pool.query<{ provider: string; model: string; dim: number }>(
      "SELECT provider, model, dim FROM embedding_config WHERE lane = 'prose'",
    );
    const storedConfig = cfgRows.rows[0] ?? null;

    const stateData = loadStateData(statePath);

    let configMatch = false;
    let needsRebuild = false;
    if (storedConfig !== null) {
      configMatch =
        storedConfig.provider === provider &&
        storedConfig.model === model &&
        storedConfig.dim === dim;
      if (!configMatch) {
        const stateConfigMatches =
          stateData.config !== undefined &&
          stateData.config.provider === provider &&
          stateData.config.model === model &&
          stateData.config.dim === dim;
        if (!stateConfigMatches) {
          needsRebuild = true;
        }
      }
    }

    // Resume state: stored config differs from runtime, but the state file already
    // carries the new config (tables were rebuilt in a prior interrupted run).
    // No column alter is needed, but facts must still be reembedded to finish the run.
    const isResumeState = storedConfig !== null && !configMatch && !needsRebuild;

    if (opts.dryRun) {
      if (needsRebuild) {
        const stored = storedConfig!;
        process.stderr.write(
          `[pg-embed-backfill] dim mismatch: stored ${stored.provider}/${stored.model}@${stored.dim},` +
          ` runtime ${provider}/${model}@${dim}.` +
          ` Would ALTER session_embedding_chunks and fact_embeddings to vector(${dim}).\n`,
        );
      } else if (isResumeState) {
        const stored = storedConfig!;
        process.stderr.write(
          `[pg-embed-backfill] resume state: interrupted rebuild detected.` +
          ` Stored config ${stored.provider}/${stored.model}@${stored.dim}` +
          ` differs from runtime ${provider}/${model}@${dim},` +
          ` but state file already matches runtime.` +
          ` No column alter; facts would be reembedded to complete the interrupted rebuild.\n`,
        );
      } else {
        process.stderr.write(
          `[pg-embed-backfill] dry-run: config matches (${provider}/${model}@${dim}), no rebuild needed.\n`,
        );
      }
      let dryRunFactCount = 0;
      if (isResumeState) {
        const countResult = await pool.query<{ cnt: string }>(
          "SELECT COUNT(*) AS cnt FROM facts WHERE superseded_by IS NULL AND retired_at IS NULL",
        );
        dryRunFactCount = Number(countResult.rows[0]?.cnt ?? 0);
      }
      return {
        total: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skippedAlreadyDone: 0,
        dbMissing: false,
        dryRun: true,
        rebuilt: needsRebuild,
        factsReembedded: dryRunFactCount,
      };
    }

    if (needsRebuild) {
      const stored = storedConfig!;
      process.stderr.write(
        `[pg-embed-backfill] rebuilding vec tables: stored ${stored.provider}/${stored.model}@${stored.dim}` +
        ` vs runtime ${provider}/${model}@${dim}\n`,
      );
      process.stderr.write(`[pg-embed-backfill] DELETE FROM session_embedding_chunks\n`);
      await pool.query("DELETE FROM session_embedding_chunks");
      await pool.query("DROP INDEX IF EXISTS session_chunks_embedding_idx");
      await pool.query(
        `ALTER TABLE session_embedding_chunks ALTER COLUMN embedding TYPE vector(${dim})`,
      );
      await pool.query(
        `CREATE INDEX session_chunks_embedding_idx` +
        ` ON session_embedding_chunks USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)`,
      );
      process.stderr.write(`[pg-embed-backfill] rebuilding fact_embeddings to vector(${dim})\n`);
      await pool.query("DELETE FROM fact_embeddings");
      await pool.query("DROP INDEX IF EXISTS fact_embeddings_idx");
      await pool.query(
        `ALTER TABLE fact_embeddings ALTER COLUMN embedding TYPE vector(${dim})`,
      );
      await pool.query(
        `CREATE INDEX fact_embeddings_idx` +
        ` ON fact_embeddings USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)`,
      );
      stateData.done = new Set();
    }

    const limitClause = opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "";
    const sessionResult = await pool.query<{
      id: string;
      label: string | null;
      summary: string | null;
      body: string | null;
    }>(
      "SELECT id, label, summary, body FROM sessions" +
      " WHERE body IS NOT NULL OR summary IS NOT NULL OR label IS NOT NULL" +
      " ORDER BY started_at" +
      limitClause,
    );
    const rows = sessionResult.rows;
    const total = rows.length;

    const done = stateData.done;

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const idx = i + 1;
      if (done.has(row.id)) {
        skipped += 1;
        continue;
      }
      const chunks = chunkSessionText({
        label: row.label,
        summary: row.summary,
        body: row.body,
      });
      if (chunks.length === 0) {
        failed += 1;
        opts.onProgress?.(idx, total, row.id, "SKIP (no text)");
        continue;
      }

      await pool.query("DELETE FROM session_embedding_chunks WHERE session_id = $1", [row.id]);

      const vectors: { idx: number; vec: Float32Array }[] = [];
      let chunkSkipped = 0;
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c]!;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const out = await opts.embedder.embed(chunk, "document");
            vectors.push({ idx: c, vec: out.vector });
            lastErr = undefined;
            break;
          } catch (e) {
            lastErr = e;
            if (!(e instanceof LLMUnreachableError)) throw e;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (lastErr !== undefined) chunkSkipped += 1;
      }
      if (vectors.length === 0) {
        failed += 1;
        opts.onProgress?.(idx, total, row.id, `FAIL (embedder, ${chunkSkipped}/${chunks.length} chunks)`);
        continue;
      }

      try {
        for (const { idx: cidx, vec } of vectors) {
          const vecStr = `[${Array.from(vec).join(",")}]`;
          const ins = await pool.query<{ chunk_id: number }>(
            `INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding)
             VALUES ($1, $2, $3::vector) RETURNING chunk_id`,
            [row.id, cidx, vecStr],
          );
          const chunkId = ins.rows[0]!.chunk_id;
          await pool.query(
            "INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES ($1, $2, $3)",
            [chunkId, row.id, cidx],
          );
        }
      } catch (e) {
        failed += 1;
        opts.onProgress?.(idx, total, row.id, `FAIL (db): ${(e as Error).message}`);
        continue;
      }

      done.add(row.id);
      succeeded += 1;
      const status =
        chunkSkipped === 0
          ? `OK (${vectors.length} chunks)`
          : `PARTIAL (${vectors.length}/${chunks.length} chunks, ${chunkSkipped} skipped)`;
      opts.onProgress?.(idx, total, row.id, status);
      if (succeeded % SAVE_EVERY === 0) saveState(statePath, done, { provider, model, dim });
    }

    // Reembed facts whenever the stored config does not match the runtime config
    // (storedConfig exists but configMatch is false). This covers both fresh
    // rebuilds and interrupted rebuilds that resume: the embedding_config row
    // is only updated on successful completion, so storedConfig still holds
    // the old values during a partial run. Gating on needsRebuild alone skips
    // facts in that resume path.
    let factsReembedded = 0;
    if (storedConfig !== null && !configMatch) {
      const factResult = await pool.query<{
        id: string;
        subject: string;
        predicate: string;
        value: string;
      }>(
        "SELECT id, subject, predicate, value FROM facts" +
        " WHERE superseded_by IS NULL AND retired_at IS NULL",
      );
      for (const fact of factResult.rows) {
        const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
        if (!factText) continue;
        try {
          const out = await opts.embedder.embed(factText, "document");
          const vecStr = `[${Array.from(out.vector).join(",")}]`;
          await pool.query(
            `INSERT INTO fact_embeddings (fact_id, embedding)
             VALUES ($1, $2::vector)
             ON CONFLICT (fact_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
            [fact.id, vecStr],
          );
          factsReembedded += 1;
        } catch {
          // Best-effort: fact row survives; semantic recall misses it until re-run.
        }
      }
    }

    await pool.query(
      `INSERT INTO embedding_config (lane, provider, model, dim, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lane) DO UPDATE SET
         provider   = EXCLUDED.provider,
         model      = EXCLUDED.model,
         dim        = EXCLUDED.dim,
         updated_at = EXCLUDED.updated_at`,
      ["prose", provider, model, dim, new Date().toISOString()],
    );
    saveState(statePath, done, { provider, model, dim });

    return {
      total,
      processed: succeeded + failed + skipped,
      succeeded,
      failed,
      skippedAlreadyDone: skipped,
      dbMissing: false,
      rebuilt: needsRebuild,
      factsReembedded,
    };
  } finally {
    await pool.end();
  }
}
