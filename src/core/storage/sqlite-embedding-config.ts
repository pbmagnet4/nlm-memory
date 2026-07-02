import type Database from "better-sqlite3";
import type { EmbeddingConfigStore, EmbeddingLane, EmbeddingLaneConfig } from "@core/embedding/embedding-config.js";

type ConfigRow = {
  lane: EmbeddingLane;
  provider: string;
  model: string;
  dim: number;
  updated_at: string;
};

function rowToConfig(r: ConfigRow): EmbeddingLaneConfig {
  return { lane: r.lane, provider: r.provider, model: r.model, dim: r.dim };
}

export class SqliteEmbeddingConfigStore implements EmbeddingConfigStore {
  private readonly stmtGet: Database.Statement<[string], ConfigRow>;
  private readonly stmtUpsert: Database.Statement<[string, string, string, number, string]>;

  constructor(private readonly db: Database.Database) {
    this.stmtGet = db.prepare<[string], ConfigRow>(
      "SELECT lane, provider, model, dim, updated_at FROM embedding_config WHERE lane = ?",
    );
    this.stmtUpsert = db.prepare<[string, string, string, number, string]>(
      `INSERT INTO embedding_config (lane, provider, model, dim, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lane) DO UPDATE SET
         provider   = excluded.provider,
         model      = excluded.model,
         dim        = excluded.dim,
         updated_at = excluded.updated_at`,
    );
  }

  getLane(lane: EmbeddingLane): EmbeddingLaneConfig | null {
    const row = this.stmtGet.get(lane);
    return row ? rowToConfig(row) : null;
  }

  upsertLane(cfg: EmbeddingLaneConfig, updatedAtIso: string): void {
    this.stmtUpsert.run(cfg.lane, cfg.provider, cfg.model, cfg.dim, updatedAtIso);
  }
}
