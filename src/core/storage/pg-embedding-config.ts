import type { Pool } from "pg";
import type {
  EmbeddingConfigStore,
  EmbeddingLane,
  EmbeddingLaneConfig,
} from "@core/embedding/embedding-config.js";

type ConfigRow = {
  lane: string;
  provider: string;
  model: string;
  dim: number;
};

function rowToConfig(r: ConfigRow): EmbeddingLaneConfig {
  return { lane: r.lane as EmbeddingLane, provider: r.provider, model: r.model, dim: r.dim };
}

/**
 * Postgres implementation of EmbeddingConfigStore.
 *
 * The EmbeddingConfigStore port has synchronous methods (getLane / upsertLane)
 * to match the SQLite twin. This implementation satisfies the port via an
 * in-memory write-through cache:
 *   - load() preloads all rows from pg (called by PgStorage.init).
 *   - getLane() reads from the cache synchronously.
 *   - upsertLane() updates the cache synchronously and fires an async pg write.
 *
 * The fire-and-forget write logs errors but does not throw, consistent with
 * the "best-effort tracking" semantics of the embedding config lane.
 */
export class PgEmbeddingConfigStore implements EmbeddingConfigStore {
  private readonly cache = new Map<EmbeddingLane, EmbeddingLaneConfig>();

  constructor(private readonly pool: Pool) {}

  async load(): Promise<void> {
    const { rows } = await this.pool.query<ConfigRow>(
      "SELECT lane, provider, model, dim FROM embedding_config",
    );
    for (const row of rows) {
      this.cache.set(row.lane as EmbeddingLane, rowToConfig(row));
    }
  }

  getLane(lane: EmbeddingLane): EmbeddingLaneConfig | null {
    return this.cache.get(lane) ?? null;
  }

  /**
   * The pg write is fire-and-forget. Short-lived callers (CLI commands) must
   * not route their final config write through this method and then call
   * pool.end() in the same tick, or the write can be rejected before it
   * acquires a connection; issue an awaited pool.query() directly instead.
   */
  upsertLane(cfg: EmbeddingLaneConfig, updatedAtIso: string): void {
    this.cache.set(cfg.lane, cfg);
    void this.pool
      .query(
        `INSERT INTO embedding_config (lane, provider, model, dim, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lane) DO UPDATE SET
           provider   = EXCLUDED.provider,
           model      = EXCLUDED.model,
           dim        = EXCLUDED.dim,
           updated_at = EXCLUDED.updated_at`,
        [cfg.lane, cfg.provider, cfg.model, cfg.dim, updatedAtIso],
      )
      .catch((err: unknown) => {
        console.error("nlm-memory: pg upsert embedding_config failed:", err);
      });
  }
}
