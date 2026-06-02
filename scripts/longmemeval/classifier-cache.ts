/**
 * SHA256-keyed on-disk classifier cache. Mirrors EmbeddingCache.
 *
 * Classifying ~19K unique haystack bodies takes hours per model (local
 * Ollama ~30-40s per session × 19K = ~9 days). The cache makes the
 * per-classifier benchmark a one-time cost per (model, body) pair.
 *
 * Key = sha256(provider + ":" + model + ":" + body)
 * Value = ClassifyResult JSON, OR an error record (so persistent failures
 * are not retried indefinitely).
 *
 * Backed by $LONGMEMEVAL_CACHE_DIR/classifier.sqlite.
 */

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClassifyResult } from "../../src/ports/llm-client.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS classifications (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  elapsed_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export interface ClassifierClient {
  classify(transcript: string): Promise<ClassifyResult>;
}

export interface ClassifierCacheEntry {
  readonly result: ClassifyResult | null;
  readonly failed: boolean;
  readonly error: string | null;
  readonly elapsedMs: number | null;
}

export interface ClassifierCacheOptions {
  readonly dbPath: string;
  readonly provider: string;
  readonly model: string;
  readonly client: ClassifierClient;
}

function keyFor(provider: string, model: string, body: string): string {
  return createHash("sha256").update(`${provider}:${model}:${body}`).digest("hex");
}

export class ClassifierCache {
  private readonly db: DB;
  private readonly provider: string;
  private readonly model: string;
  private readonly client: ClassifierClient;
  private readonly getStmt: ReturnType<DB["prepare"]>;
  private readonly putStmt: ReturnType<DB["prepare"]>;

  constructor(opts: ClassifierCacheOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.prepare(CREATE_SQL).run();
    this.getStmt = this.db.prepare(
      "SELECT result_json, failed, error, elapsed_ms FROM classifications WHERE key = @key",
    );
    this.putStmt = this.db.prepare(
      `INSERT OR REPLACE INTO classifications (key, provider, model, result_json, failed, error, elapsed_ms)
       VALUES (@key, @provider, @model, @result_json, @failed, @error, @elapsed_ms)`,
    );
    this.provider = opts.provider;
    this.model = opts.model;
    this.client = opts.client;
  }

  async classify(body: string): Promise<ClassifierCacheEntry> {
    const key = keyFor(this.provider, this.model, body);
    const row = this.getStmt.get({ key }) as
      | { result_json: string | null; failed: number; error: string | null; elapsed_ms: number | null }
      | undefined;
    if (row) {
      if (row.failed === 1) {
        return { result: null, failed: true, error: row.error, elapsedMs: row.elapsed_ms };
      }
      return {
        result: row.result_json ? (JSON.parse(row.result_json) as ClassifyResult) : null,
        failed: false,
        error: null,
        elapsedMs: row.elapsed_ms,
      };
    }
    const t0 = Date.now();
    try {
      const result = await this.client.classify(body);
      const elapsedMs = Date.now() - t0;
      this.putStmt.run({
        key,
        provider: this.provider,
        model: this.model,
        result_json: JSON.stringify(result),
        failed: 0,
        error: null,
        elapsed_ms: elapsedMs,
      });
      return { result, failed: false, error: null, elapsedMs };
    } catch (e) {
      const elapsedMs = Date.now() - t0;
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.putStmt.run({
        key,
        provider: this.provider,
        model: this.model,
        result_json: null,
        failed: 1,
        error: errMsg.slice(0, 500),
        elapsed_ms: elapsedMs,
      });
      return { result: null, failed: true, error: errMsg, elapsedMs };
    }
  }

  stats(): { total: number; ok: number; failed: number; meanElapsedMs: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END) AS failed,
                AVG(elapsed_ms) AS mean_elapsed
         FROM classifications
         WHERE provider = @provider AND model = @model`,
      )
      .get({ provider: this.provider, model: this.model }) as {
      total: number;
      ok: number;
      failed: number;
      mean_elapsed: number | null;
    };
    return {
      total: row.total,
      ok: row.ok ?? 0,
      failed: row.failed ?? 0,
      meanElapsedMs: row.mean_elapsed === null ? null : Math.round(row.mean_elapsed),
    };
  }

  close(): void {
    this.db.close();
  }
}
