import type { Pool } from "pg";
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

export class PgEmbedderSettingsStore implements EmbedderSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(lane: EmbeddingLane): Promise<StoredEmbedderLane> {
    const { rows } = await this.pool.query<SettingsRow>(
      "SELECT provider, base_url, model, api_key FROM embedder_settings WHERE lane = $1",
      [lane],
    );
    const row = rows[0];
    return row
      ? { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey: row.api_key }
      : NO_STORED_EMBEDDER;
  }

  async update(lane: EmbeddingLane, patch: EmbedderLaneUpdate): Promise<StoredEmbedderLane> {
    const next = applyEmbedderUpdate(await this.get(lane), patch);
    await this.pool.query(
      `INSERT INTO embedder_settings (lane, provider, base_url, model, api_key, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (lane) DO UPDATE SET
         provider = EXCLUDED.provider, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
         api_key = EXCLUDED.api_key, updated_at = EXCLUDED.updated_at`,
      [lane, next.provider, next.baseUrl, next.model, next.apiKey],
    );
    return next;
  }
}
