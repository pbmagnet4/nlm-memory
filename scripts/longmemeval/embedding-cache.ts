/**
 * SHA256-keyed on-disk embedding cache. The LongMemEval-S haystack has
 * ~24K session bodies (~19K unique); embedding them via local Ollama takes
 * ~30 min the first time. Reruns must be instant — calibrating retrieval
 * parameters means dozens of re-evaluations, and re-embedding each time
 * would burn hours of wall clock for no signal.
 *
 * Backed by a small SQLite at $LONGMEMEVAL_CACHE_DIR/embeddings.sqlite.
 * Key = sha256(kind + ":" + text); value = Float32Array as BLOB.
 */

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbeddingKind, LLMClient } from "../../src/ports/llm-client.js";

const CREATE_SQL =
  "CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB NOT NULL)";

export interface EmbeddingCacheOptions {
  readonly dbPath: string;
  readonly llm: LLMClient;
}

export class EmbeddingCache {
  private readonly db: DB;
  private readonly llm: LLMClient;
  private readonly getStmt: ReturnType<DB["prepare"]>;
  private readonly putStmt: ReturnType<DB["prepare"]>;

  constructor(opts: EmbeddingCacheOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.prepare(CREATE_SQL).run();
    this.getStmt = this.db.prepare(
      "SELECT vector FROM embeddings WHERE key = @key",
    );
    this.putStmt = this.db.prepare(
      "INSERT OR REPLACE INTO embeddings (key, vector) VALUES (@key, @vector)",
    );
    this.llm = opts.llm;
  }

  async embed(text: string, kind: EmbeddingKind): Promise<Float32Array> {
    const key = createHash("sha256").update(`${kind}:${text}`).digest("hex");
    const row = this.getStmt.get({ key }) as { vector: Buffer } | undefined;
    if (row) {
      return new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
    }
    const result = await this.llm.embed(text, kind);
    const blob = Buffer.from(
      result.vector.buffer,
      result.vector.byteOffset,
      result.vector.byteLength,
    );
    this.putStmt.run({ key, vector: blob });
    return result.vector;
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
