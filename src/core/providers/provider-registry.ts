/**
 * ProviderRegistry — CRUD over the `providers` table.
 *
 * One row per LLM endpoint the user has configured. The classifier reads
 * this at boot to pick a provider/model; the UI lets users add their own.
 *
 * API keys live in the `api_key` column today. Phase 2 (Tauri shell)
 * migrates them to the OS keychain; the API shape stays identical so this
 * module's consumers don't change.
 *
 * `redact()` strips secrets on the way out — every HTTP response sends
 * redacted rows, with the key only retrievable via getSecret() inside the
 * daemon process.
 */

import type Database from "better-sqlite3";

export type ProviderKind =
  | "deepseek"
  | "ollama"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-compatible";

export interface ProviderRow {
  readonly id: number;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl: string | null;
  /** Always `null` on rows returned by `list()` / `get()`. Use `getSecret()`. */
  readonly apiKey: string | null;
  readonly hasApiKey: boolean;
  readonly defaultModel: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderInsert {
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl?: string | null;
  readonly apiKey?: string | null;
  readonly defaultModel?: string | null;
  readonly enabled?: boolean;
}

export interface ProviderUpdate {
  readonly name?: string;
  readonly baseUrl?: string | null;
  readonly apiKey?: string | null;
  readonly defaultModel?: string | null;
  readonly enabled?: boolean;
}

interface ProviderDbRow {
  id: number;
  kind: string;
  name: string;
  base_url: string | null;
  api_key: string | null;
  default_model: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowFromDb(r: ProviderDbRow, includeSecret: boolean): ProviderRow {
  return {
    id: r.id,
    kind: r.kind as ProviderKind,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: includeSecret ? r.api_key : null,
    hasApiKey: r.api_key !== null && r.api_key.length > 0,
    defaultModel: r.default_model,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DEFAULT_BASE_URLS: Record<ProviderKind, string | null> = {
  deepseek: "https://api.deepseek.com",
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
  "openai-compatible": null,
};

const DEFAULT_MODELS: Record<ProviderKind, string | null> = {
  deepseek: "deepseek-v4-flash",
  ollama: "qwen3.5:4b",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "anthropic/claude-haiku-4-5",
  "openai-compatible": null,
};

export class ProviderRegistry {
  constructor(private readonly db: Database.Database) {}

  list(): ProviderRow[] {
    const rows = this.db.prepare<[], ProviderDbRow>(
      `SELECT * FROM providers ORDER BY id ASC`,
    ).all();
    return rows.map((r) => rowFromDb(r, false));
  }

  get(id: number): ProviderRow | null {
    const row = this.db.prepare<[number], ProviderDbRow>(
      `SELECT * FROM providers WHERE id = ?`,
    ).get(id);
    return row ? rowFromDb(row, false) : null;
  }

  getByName(name: string): ProviderRow | null {
    const row = this.db.prepare<[string], ProviderDbRow>(
      `SELECT * FROM providers WHERE name = ?`,
    ).get(name);
    return row ? rowFromDb(row, false) : null;
  }

  /** Returns the secret. Use only inside the daemon — never echo to HTTP. */
  getSecret(id: number): string | null {
    const row = this.db.prepare<[number], ProviderDbRow>(
      `SELECT * FROM providers WHERE id = ?`,
    ).get(id);
    return row?.api_key ?? null;
  }

  insert(input: ProviderInsert): ProviderRow {
    const baseUrl = input.baseUrl ?? DEFAULT_BASE_URLS[input.kind];
    const defaultModel = input.defaultModel ?? DEFAULT_MODELS[input.kind];
    const result = this.db.prepare(`
      INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled)
      VALUES (@kind, @name, @base_url, @api_key, @default_model, @enabled)
    `).run({
      kind: input.kind,
      name: input.name,
      base_url: baseUrl ?? null,
      api_key: input.apiKey ?? null,
      default_model: defaultModel ?? null,
      enabled: input.enabled === false ? 0 : 1,
    });
    const id = Number(result.lastInsertRowid);
    const row = this.get(id);
    if (!row) throw new Error(`ProviderRegistry.insert: row ${id} not found after insert`);
    return row;
  }

  update(id: number, patch: ProviderUpdate): ProviderRow | null {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) { fields.push("name = @name"); params["name"] = patch.name; }
    if (patch.baseUrl !== undefined) { fields.push("base_url = @url"); params["url"] = patch.baseUrl; }
    if (patch.apiKey !== undefined) { fields.push("api_key = @key"); params["key"] = patch.apiKey; }
    if (patch.defaultModel !== undefined) { fields.push("default_model = @m"); params["m"] = patch.defaultModel; }
    if (patch.enabled !== undefined) { fields.push("enabled = @en"); params["en"] = patch.enabled ? 1 : 0; }
    if (fields.length === 0) return this.get(id);
    fields.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE providers SET ${fields.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Seed defaults on an empty registry. Bridges from the legacy env-var
   * setup: if DEEPSEEK_API_KEY is present, the DeepSeek row carries it
   * forward; Ollama is always seeded since it needs no key.
   */
  seedDefaults(): void {
    const count = this.db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM providers`).get();
    if ((count?.c ?? 0) > 0) return;

    this.insert({
      kind: "ollama",
      name: "Ollama (local)",
      baseUrl: process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434",
    });

    const deepseekKey = process.env["DEEPSEEK_API_KEY"];
    this.insert({
      kind: "deepseek",
      name: "DeepSeek",
      apiKey: deepseekKey ?? null,
      enabled: Boolean(deepseekKey),
    });
  }
}

import type { Pool } from "pg";

/**
 * PgProviderRegistry — CRUD over `providers` for the PG storage path.
 * API mirrors ProviderRegistry exactly.
 */
export class PgProviderRegistry {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ProviderRow[]> {
    const result = await this.pool.query<{
      id: number; kind: ProviderKind; name: string; base_url: string | null;
      api_key: string | null; default_model: string | null; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at
       FROM providers ORDER BY id`,
    );
    return result.rows.map((r) => ({
      id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url,
      apiKey: null, hasApiKey: r.api_key !== null && r.api_key.length > 0,
      defaultModel: r.default_model, enabled: r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  async get(id: number): Promise<ProviderRow | null> {
    const result = await this.pool.query<{
      id: number; kind: ProviderKind; name: string; base_url: string | null;
      api_key: string | null; default_model: string | null; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at
       FROM providers WHERE id = $1`,
      [id],
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url,
      apiKey: null, hasApiKey: r.api_key !== null && r.api_key.length > 0,
      defaultModel: r.default_model, enabled: r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async getByName(name: string): Promise<ProviderRow | null> {
    const result = await this.pool.query<{
      id: number; kind: ProviderKind; name: string; base_url: string | null;
      api_key: string | null; default_model: string | null; enabled: boolean;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at
       FROM providers WHERE name = $1`,
      [name],
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url,
      apiKey: null, hasApiKey: r.api_key !== null && r.api_key.length > 0,
      defaultModel: r.default_model, enabled: r.enabled,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async getSecret(id: number): Promise<string | null> {
    const result = await this.pool.query<{ api_key: string | null }>(
      "SELECT api_key FROM providers WHERE id = $1", [id],
    );
    return result.rows[0]?.api_key ?? null;
  }

  async insert(input: ProviderInsert): Promise<ProviderRow> {
    const result = await this.pool.query<{ id: number; created_at: string; updated_at: string }>(
      `INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at, updated_at`,
      [input.kind, input.name, input.baseUrl ?? null, input.apiKey ?? null, input.defaultModel ?? null, input.enabled ?? true],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PgProviderRegistry.insert: RETURNING yielded no row");
    return {
      id: row.id, kind: input.kind, name: input.name, baseUrl: input.baseUrl ?? null,
      apiKey: null, hasApiKey: (input.apiKey ?? "").length > 0,
      defaultModel: input.defaultModel ?? null, enabled: input.enabled ?? true,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async update(id: number, patch: ProviderUpdate): Promise<ProviderRow | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); params.push(patch.name); }
    if (patch.baseUrl !== undefined) { sets.push(`base_url = $${idx++}`); params.push(patch.baseUrl); }
    if (patch.apiKey !== undefined) { sets.push(`api_key = $${idx++}`); params.push(patch.apiKey); }
    if (patch.defaultModel !== undefined) { sets.push(`default_model = $${idx++}`); params.push(patch.defaultModel); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(patch.enabled); }
    if (sets.length === 1) return this.get(id);
    params.push(id);
    await this.pool.query(`UPDATE providers SET ${sets.join(", ")} WHERE id = $${idx}`, params);
    return this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM providers WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
