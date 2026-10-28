/**
 * Session-chunk embedding retry sweep. A chunk whose embed failed at ingest is
 * recorded in chunk_embed_pending; each tick retries those whose backoff
 * elapsed, a few at a time, under the shared embed in-flight cap (a saturated
 * cap stops the batch and counts as shed, not as a failure). After
 * MAX_CHUNK_EMBED_ATTEMPTS failures a chunk is no longer retried but stays in
 * the table, and `nlm doctor` reports it.
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";
import type { LLMClient } from "@ports/llm-client.js";
import { tryAcquire, release } from "@core/health/embed-inflight.js";

export const MAX_CHUNK_EMBED_ATTEMPTS = 5;

export interface ChunkRef {
  readonly sessionId: string;
  readonly chunkIdx: number;
}

export interface StuckChunk extends ChunkRef {
  readonly attempts: number;
  readonly lastError: string | null;
}

/** Storage side of the sweep, implemented by the SQLite and Postgres session stores. */
export interface ChunkRetryStore {
  listChunksDueForEmbedding(limit: number, now?: Date): ReadonlyArray<ChunkRef> | Promise<ReadonlyArray<ChunkRef>>;
  chunkText(sessionId: string, chunkIdx: number): string | null | Promise<string | null>;
  insertChunkEmbedding(sessionId: string, chunkIdx: number, vector: Float32Array): void | Promise<void>;
  markChunkEmbedPending(sessionId: string, chunkIdx: number, error: string, now?: Date): void | Promise<void>;
  clearChunkEmbedPending(sessionId: string, chunkIdx: number): void | Promise<void>;
}

export interface ChunkSweepReport {
  readonly attempted: number;
  readonly repaired: number;
  readonly failed: number;
  readonly shed: boolean;
}

export interface ChunkSweepOptions {
  readonly store: ChunkRetryStore;
  readonly embedder: LLMClient;
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export async function sweepChunkEmbeddings(opts: ChunkSweepOptions): Promise<ChunkSweepReport> {
  const now = opts.now ?? (() => new Date());
  const due = await opts.store.listChunksDueForEmbedding(opts.batchSize ?? 10, now());
  let attempted = 0;
  let repaired = 0;
  let failed = 0;
  let shed = false;
  for (const { sessionId, chunkIdx } of due) {
    const text = await opts.store.chunkText(sessionId, chunkIdx);
    if (text === null) {
      // The session was rewritten shorter; there is no such chunk to embed.
      await opts.store.clearChunkEmbedPending(sessionId, chunkIdx);
      continue;
    }
    if (!tryAcquire()) {
      shed = true;
      break;
    }
    attempted += 1;
    try {
      const { vector } = await opts.embedder.embed(text, "document");
      await opts.store.insertChunkEmbedding(sessionId, chunkIdx, vector);
      repaired += 1;
    } catch (err) {
      failed += 1;
      await opts.store.markChunkEmbedPending(sessionId, chunkIdx, String(err), now());
    } finally {
      release();
    }
  }
  return { attempted, repaired, failed, shed };
}

const STUCK_SQL = `
  SELECT session_id, chunk_idx, attempts, last_error
  FROM chunk_embed_pending
  WHERE attempts >= ${MAX_CHUNK_EMBED_ATTEMPTS}
  ORDER BY session_id, chunk_idx
`;

interface StuckRow { session_id: string; chunk_idx: number; attempts: number; last_error: string | null }

const toStuck = (r: StuckRow): StuckChunk => ({
  sessionId: r.session_id,
  chunkIdx: r.chunk_idx,
  attempts: r.attempts,
  lastError: r.last_error,
});

export function stuckChunksOnSqlite(db: Database.Database): StuckChunk[] {
  return db.prepare<[], StuckRow>(STUCK_SQL).all().map(toStuck);
}

export async function stuckChunksOnPg(pool: Pool): Promise<StuckChunk[]> {
  return (await pool.query<StuckRow>(STUCK_SQL)).rows.map(toStuck);
}
