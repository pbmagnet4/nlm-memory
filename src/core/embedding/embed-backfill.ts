/**
 * embed-backfill — re-embed every session in canonical.sqlite into the
 * chunk + max-pool index (session_embedding_chunks).
 *
 * For each session: chunk (label + summary + body) via chunkSessionText,
 * embed each chunk with kind="document", and write to the chunk table +
 * session_chunk_map via the same INSERT pair used by the live ingest path.
 *
 * Resumable via a JSON state file at $NLM_EMBED_STATE (default
 * ~/.nlm/embed_reembed.state). Interrupting + rerunning skips already-done
 * session ids. A session is considered "done" only when ALL its chunks
 * embed successfully — partial sessions are retried on the next run.
 *
 * When the probed embedder dim/model/provider differs from the stored
 * embedding_config prose row, both vec tables are dropped and recreated at
 * the new dim before the session loop runs. Facts (superseded_by IS NULL
 * AND retired_at IS NULL) are reembedded immediately after the session
 * loop. Same-config reruns skip the rebuild and reembed sessions only.
 *
 * Layering: depends on the LLMClient port. SQLite touched directly via
 * better-sqlite3 because this is a one-shot operational tool, not a hot
 * path. Lives under core/ but is invoked from the CLI composition root.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { LLMClient } from "@ports/llm-client.js";
import { LLMUnreachableError } from "@ports/llm-client.js";
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import { SqliteEmbeddingConfigStore } from "@core/storage/sqlite-embedding-config.js";
import type { EmbeddingLaneConfig } from "@core/embedding/embedding-config.js";

const DEFAULT_STATE_PATH = join(homedir(), ".nlm", "embed_reembed.state");
const SAVE_EVERY = 25;

export interface BackfillOptions {
  readonly dbPath: string;
  readonly embedder: LLMClient;
  readonly statePath?: string;
  readonly limit?: number;
  readonly dryRun?: boolean;
  /** Provider string written to embedding_config. Defaults to NLM_EMBED_PROVIDER env or "ollama". */
  readonly embedderProvider?: string;
  readonly onProgress?: (i: number, total: number, sid: string, status: string) => void;
}

export interface BackfillReport {
  readonly total: number;
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skippedAlreadyDone: number;
  readonly dbMissing: boolean;
  readonly rebuilt?: boolean;
  readonly factsReembedded?: number;
  readonly dryRun?: boolean;
}

interface SessionRow {
  id: string;
  label: string | null;
  summary: string | null;
  body: string | null;
}

interface FactRow {
  id: string;
  subject: string;
  predicate: string;
  value: string;
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


export async function reembedCorpus(opts: BackfillOptions): Promise<BackfillReport> {
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;

  if (!existsSync(opts.dbPath)) {
    return { total: 0, processed: 0, succeeded: 0, failed: 0, skippedAlreadyDone: 0, dbMissing: true };
  }

  const db = new Database(opts.dbPath);
  sqliteVec.load(db);

  try {
    const configTableRow = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_config'",
      )
      .get();
    if (!configTableRow) {
      throw new Error(
        "embedding_config table not found; run `nlm migrate` to apply pending migrations",
      );
    }

    const probeResult = await opts.embedder.embed("nlm dimension probe", "query");
    const dim = probeResult.vector.length;
    const model = probeResult.model;
    const provider = opts.embedderProvider ?? process.env["NLM_EMBED_PROVIDER"] ?? "ollama";
    const runtimeConfig: EmbeddingLaneConfig = { lane: "prose", provider, model, dim };

    const configStore = new SqliteEmbeddingConfigStore(db);
    const storedConfig = configStore.getLane("prose");

    const stateData = loadStateData(statePath);

    let needsRebuild = false;
    if (storedConfig !== null) {
      const configMatch =
        storedConfig.provider === runtimeConfig.provider &&
        storedConfig.model === runtimeConfig.model &&
        storedConfig.dim === runtimeConfig.dim;
      if (!configMatch) {
        // An interrupted rebuild already dropped+recreated the tables if the
        // state file carries a matching config. Resume without re-dropping.
        const stateConfigMatches =
          stateData.config !== undefined &&
          stateData.config.provider === runtimeConfig.provider &&
          stateData.config.model === runtimeConfig.model &&
          stateData.config.dim === runtimeConfig.dim;
        if (!stateConfigMatches) {
          needsRebuild = true;
        }
      }
    }

    if (opts.dryRun) {
      if (needsRebuild) {
        const stored = storedConfig!;
        process.stderr.write(
          `[embed-backfill] dim mismatch: stored ${stored.provider}/${stored.model}@${stored.dim},` +
          ` runtime ${provider}/${model}@${dim}.` +
          ` Would DROP session_embedding_chunks, session_chunk_map entries, fact_embeddings.\n`,
        );
      } else {
        process.stderr.write(
          `[embed-backfill] dry-run: config matches (${provider}/${model}@${dim}), no rebuild needed.\n`,
        );
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
        factsReembedded: 0,
      };
    }

    if (needsRebuild) {
      const stored = storedConfig!;
      process.stderr.write(
        `[embed-backfill] rebuilding vec tables: stored ${stored.provider}/${stored.model}@${stored.dim}` +
        ` vs runtime ${provider}/${model}@${dim}\n`,
      );
      process.stderr.write(`[embed-backfill] DROP TABLE IF EXISTS session_embedding_chunks\n`);
      db.exec("DROP TABLE IF EXISTS session_embedding_chunks");
      db.exec(
        `CREATE VIRTUAL TABLE session_embedding_chunks USING vec0(` +
        `chunk_id INTEGER PRIMARY KEY, ` +
        `embedding float[${dim}], ` +
        `+session_id TEXT, ` +
        `+chunk_idx INTEGER` +
        `)`,
      );
      db.exec("DELETE FROM session_chunk_map");
      process.stderr.write(`[embed-backfill] DROP TABLE IF EXISTS fact_embeddings\n`);
      db.exec("DROP TABLE IF EXISTS fact_embeddings");
      db.exec(
        `CREATE VIRTUAL TABLE fact_embeddings USING vec0(` +
        `fact_id TEXT PRIMARY KEY, ` +
        `embedding float[${dim}]` +
        `)`,
      );
      // Ignore the stale state file; start fresh for this config.
      stateData.done = new Set();
    }

    // Backfill every session with content; live ingest covers ongoing writes.
    // The state file dedupes across runs so partial completion resumes cleanly.
    const sql =
      "SELECT s.id, s.label, s.summary, s.body FROM sessions s " +
      "WHERE s.body IS NOT NULL OR s.summary IS NOT NULL OR s.label IS NOT NULL " +
      "ORDER BY s.started_at" +
      (opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : "");
    const rows = db.prepare<[], SessionRow>(sql).all();
    const total = rows.length;

    const done = stateData.done;

    const selectChunks = db.prepare<[string], { chunk_id: number }>(
      "SELECT chunk_id FROM session_chunk_map WHERE session_id = ?",
    );
    const delChunks = (sessionId: string): void => {
      const existing = selectChunks.all(sessionId);
      if (existing.length === 0) return;
      const placeholders = existing.map(() => "?").join(",");
      const ids = existing.map((r) => r.chunk_id);
      db.prepare(
        `DELETE FROM session_embedding_chunks WHERE chunk_id IN (${placeholders})`,
      ).run(...ids);
      db.prepare("DELETE FROM session_chunk_map WHERE session_id = ?").run(sessionId);
    };
    const insChunk = db.prepare(
      "INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)",
    );
    const insMap = db.prepare(
      "INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)",
    );

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

      // Per-chunk failure tolerance matches live ingest: one chunk hitting
      // the Ollama edge-cliff 500 must not zero out an entire session's
      // coverage. Single retry on LLMUnreachableError catches transient
      // failures; persistent ones are dropped. Session is "done" if any
      // chunk landed — partial max-pool coverage beats none.
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
        delChunks(row.id);
        for (const { idx: cidx, vec } of vectors) {
          const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
          // BigInt cast so vec0's aux chunk_idx column receives an INTEGER.
          const info = insChunk.run(blob, row.id, BigInt(cidx));
          insMap.run(Number(info.lastInsertRowid), row.id, cidx);
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

    // Reembed facts only when a rebuild happened. A same-config rerun stays
    // sessions-only, matching the live embedFacts population predicate
    // (superseded_by IS NULL AND retired_at IS NULL from sqlite-session-store.ts).
    let factsReembedded = 0;
    if (needsRebuild) {
      const factRows = db
        .prepare<[], FactRow>(
          "SELECT id, subject, predicate, value FROM facts" +
          " WHERE superseded_by IS NULL AND retired_at IS NULL",
        )
        .all();
      const insFactEmb = db.prepare(
        "INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)",
      );
      for (const fact of factRows) {
        const factText = `${fact.subject} ${fact.predicate} ${fact.value}`.trim();
        if (!factText) continue;
        try {
          const out = await opts.embedder.embed(factText, "document");
          const blob = Buffer.from(out.vector.buffer, out.vector.byteOffset, out.vector.byteLength);
          insFactEmb.run(fact.id, blob);
          factsReembedded += 1;
        } catch {
          // Best-effort: fact row survives; semantic recall misses it until re-run.
        }
      }
    }

    // Upsert prose config row on successful completion and persist final state.
    configStore.upsertLane(runtimeConfig, new Date().toISOString());
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
    db.close();
  }
}
