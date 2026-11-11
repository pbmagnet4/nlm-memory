import type Database from "better-sqlite3";
import type { EmbeddingLane } from "@core/embedding/embedding-config.js";
import {
  applyEmbedderUpdate,
  NO_STORED_EMBEDDER,
  type EmbedderLaneUpdate,
  type EmbedderSettingsStore,
  type StoredEmbedderLane,
} from "@ports/embedder-settings-store.js";

interface SettingsRow {
  provider: string | null;
  base_url: string | null;
  model: string | null;
  api_key: string | null;
}

export class SqliteEmbedderSettingsStore implements EmbedderSettingsStore {
  constructor(private readonly db: Database.Database) {}

  async get(lane: EmbeddingLane): Promise<StoredEmbedderLane> {
    const row = this.db
      .prepare<[string], SettingsRow>("SELECT provider, base_url, model, api_key FROM embedder_settings WHERE lane = ?")
      .get(lane);
    return row
      ? { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey: row.api_key }
      : NO_STORED_EMBEDDER;
  }

  async update(lane: EmbeddingLane, patch: EmbedderLaneUpdate): Promise<StoredEmbedderLane> {
    const next = applyEmbedderUpdate(await this.get(lane), patch);
    this.db
      .prepare(
        `INSERT INTO embedder_settings (lane, provider, base_url, model, api_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lane) DO UPDATE SET
           provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
           api_key = excluded.api_key, updated_at = excluded.updated_at`,
      )
      .run(lane, next.provider, next.baseUrl, next.model, next.apiKey, new Date().toISOString());
    return next;
  }
}
