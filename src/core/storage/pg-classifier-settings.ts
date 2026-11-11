import type { Pool } from "pg";
import {
  applySettingsUpdate,
  type ClassifierSettingsStore,
  type ClassifierSettingsUpdate,
  type ClassifierThinking,
  type StoredClassifierSettings,
} from "@ports/classifier-settings-store.js";

interface SettingsRow {
  thinking: ClassifierThinking | null;
  timeout_ms: number | null;
  max_tokens: number | null;
}

export class PgClassifierSettingsStore implements ClassifierSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<StoredClassifierSettings> {
    const { rows } = await this.pool.query<SettingsRow>(
      "SELECT thinking, timeout_ms, max_tokens FROM classifier_settings WHERE id = 1",
    );
    const row = rows[0];
    return row
      ? { thinking: row.thinking, timeoutMs: row.timeout_ms, maxTokens: row.max_tokens }
      : { thinking: null, timeoutMs: null, maxTokens: null };
  }

  async update(patch: ClassifierSettingsUpdate): Promise<StoredClassifierSettings> {
    const next = applySettingsUpdate(await this.get(), patch);
    await this.pool.query(
      `INSERT INTO classifier_settings (id, thinking, timeout_ms, max_tokens, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET
         thinking = EXCLUDED.thinking, timeout_ms = EXCLUDED.timeout_ms,
         max_tokens = EXCLUDED.max_tokens, updated_at = EXCLUDED.updated_at`,
      [next.thinking, next.timeoutMs, next.maxTokens],
    );
    return next;
  }
}
