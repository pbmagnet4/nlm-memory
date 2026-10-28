import type Database from "better-sqlite3";
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

export class SqliteClassifierSettingsStore implements ClassifierSettingsStore {
  constructor(private readonly db: Database.Database) {}

  async get(): Promise<StoredClassifierSettings> {
    const row = this.db
      .prepare<[], SettingsRow>("SELECT thinking, timeout_ms, max_tokens FROM classifier_settings WHERE id = 1")
      .get();
    return row
      ? { thinking: row.thinking, timeoutMs: row.timeout_ms, maxTokens: row.max_tokens }
      : { thinking: null, timeoutMs: null, maxTokens: null };
  }

  async update(patch: ClassifierSettingsUpdate): Promise<StoredClassifierSettings> {
    const next = applySettingsUpdate(await this.get(), patch);
    this.db
      .prepare(
        `INSERT INTO classifier_settings (id, thinking, timeout_ms, max_tokens, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           thinking = excluded.thinking, timeout_ms = excluded.timeout_ms,
           max_tokens = excluded.max_tokens, updated_at = excluded.updated_at`,
      )
      .run(next.thinking, next.timeoutMs, next.maxTokens, new Date().toISOString());
    return next;
  }
}
