import type { Pool } from "pg";
import type { DreamSettingsStore } from "@ports/dream-settings-store.js";

interface DreamSettingsRow {
  settings: unknown;
}

/**
 * PG mirror of SqliteDreamSettingsStore (T1729). The column is JSONB, so the
 * driver hands the parsed document straight back; the write passes JSON text
 * with an explicit ::jsonb cast.
 */
export class PgDreamSettingsStore implements DreamSettingsStore {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<unknown> {
    const { rows } = await this.pool.query<DreamSettingsRow>(
      "SELECT settings FROM dream_settings WHERE id = 1",
    );
    return rows.length > 0 ? rows[0]!.settings : null;
  }

  async save(document: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO dream_settings (id, settings, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(document)],
    );
  }
}
