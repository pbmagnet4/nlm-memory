import type Database from "better-sqlite3";
import type { DreamSettingsStore } from "@ports/dream-settings-store.js";

interface DreamSettingsRow {
  settings: string;
}

/**
 * The daemon's one stored dreaming-settings row (T1729). The document is
 * stored as JSON text and round-tripped untouched — a row whose JSON will not
 * parse rejects, which is how the caller (dream/settings.ts) decides to fall
 * back to the env seed.
 */
export class SqliteDreamSettingsStore implements DreamSettingsStore {
  constructor(private readonly db: Database.Database) {}

  async load(): Promise<unknown> {
    const row = this.db
      .prepare<[], DreamSettingsRow>("SELECT settings FROM dream_settings WHERE id = 1")
      .get();
    return row ? JSON.parse(row.settings) : null;
  }

  async save(document: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO dream_settings (id, settings, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           settings = excluded.settings, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(document), new Date().toISOString());
  }
}
