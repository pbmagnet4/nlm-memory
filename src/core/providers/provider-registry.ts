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
 *
 * Tenancy (program spec §4, M2 plan Wave B5): `providers` is a STAMP table.
 * Every method takes `tenantId` as its non-optional first parameter and
 * routes its WHERE fragment through `tenantClause`; INSERTs stamp
 * `tenant_id`. `getSecret` is the top-risk-3 surface (spec §4.5): a
 * tenant-mismatched id returns the same not-found shape (`null`) as a
 * missing row — no existence oracle, and no plaintext key crosses a tenant
 * boundary via an id an attacker merely guessed.
 */

import type Database from "better-sqlite3";
import { tenantClause, tenantClausePg } from "@core/tenancy/tenant-clause.js";

export type ProviderKind =
  | "deepseek"
  | "ollama"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "openai-compatible";

export interface ProviderRow {
  readonly id: number;
  readonly tenantId: string;
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
  tenant_id: string;
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
    tenantId: r.tenant_id,
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

/**
 * ProviderRegistryPort — the backend-agnostic provider-registry contract that
 * SqliteStorage and PgStorage expose as `storage.providers`. Async across both
 * backends (the SQLite impl declares async methods with sync bodies, matching
 * the SignalStore/FactStore convention). `seedDefaults` is intentionally NOT on
 * the port: it bridges from the local `DEEPSEEK_API_KEY` env, which is a
 * single-user SQLite concern — seeding a hosted multi-tenant PG from one
 * operator's env would be wrong, so the PG adapter never seeds providers.
 */
export interface ProviderRegistryPort {
  list(tenantId: string): Promise<ProviderRow[]>;
  get(tenantId: string, id: number): Promise<ProviderRow | null>;
  getByName(tenantId: string, name: string): Promise<ProviderRow | null>;
  getSecret(tenantId: string, id: number): Promise<string | null>;
  insert(tenantId: string, input: ProviderInsert): Promise<ProviderRow>;
  update(tenantId: string, id: number, patch: ProviderUpdate): Promise<ProviderRow | null>;
  delete(tenantId: string, id: number): Promise<boolean>;
}

export class ProviderRegistry implements ProviderRegistryPort {
  constructor(private readonly db: Database.Database) {}

  async list(tenantId: string): Promise<ProviderRow[]> {
    const tc = tenantClause(tenantId);
    const rows = this.db.prepare<unknown[], ProviderDbRow>(
      `SELECT * FROM providers WHERE ${tc.sql} ORDER BY id ASC`,
    ).all(tc.param);
    return rows.map((r) => rowFromDb(r, false));
  }

  async get(tenantId: string, id: number): Promise<ProviderRow | null> {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], ProviderDbRow>(
      `SELECT * FROM providers WHERE id = ? AND ${tc.sql}`,
    ).get(id, tc.param);
    return row ? rowFromDb(row, false) : null;
  }

  async getByName(tenantId: string, name: string): Promise<ProviderRow | null> {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], ProviderDbRow>(
      `SELECT * FROM providers WHERE name = ? AND ${tc.sql}`,
    ).get(name, tc.param);
    return row ? rowFromDb(row, false) : null;
  }

  /**
   * Returns the secret. Use only inside the daemon — never echo to HTTP.
   * A tenant-mismatched id returns null, identical to a missing row (top
   * risk 3, spec §4.5) — no existence oracle, no cross-tenant key leak.
   */
  async getSecret(tenantId: string, id: number): Promise<string | null> {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], ProviderDbRow>(
      `SELECT * FROM providers WHERE id = ? AND ${tc.sql}`,
    ).get(id, tc.param);
    return row?.api_key ?? null;
  }

  async insert(tenantId: string, input: ProviderInsert): Promise<ProviderRow> {
    const baseUrl = input.baseUrl ?? DEFAULT_BASE_URLS[input.kind];
    const defaultModel = input.defaultModel ?? DEFAULT_MODELS[input.kind];
    const result = this.db.prepare(`
      INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled, tenant_id)
      VALUES (@kind, @name, @base_url, @api_key, @default_model, @enabled, @tenant_id)
    `).run({
      kind: input.kind,
      name: input.name,
      base_url: baseUrl ?? null,
      api_key: input.apiKey ?? null,
      default_model: defaultModel ?? null,
      enabled: input.enabled === false ? 0 : 1,
      tenant_id: tenantId,
    });
    const id = Number(result.lastInsertRowid);
    const row = await this.get(tenantId, id);
    if (!row) throw new Error(`ProviderRegistry.insert: row ${id} not found after insert`);
    return row;
  }

  async update(tenantId: string, id: number, patch: ProviderUpdate): Promise<ProviderRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.baseUrl !== undefined) { fields.push("base_url = ?"); params.push(patch.baseUrl); }
    if (patch.apiKey !== undefined) { fields.push("api_key = ?"); params.push(patch.apiKey); }
    if (patch.defaultModel !== undefined) { fields.push("default_model = ?"); params.push(patch.defaultModel); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return this.get(tenantId, id);
    fields.push("updated_at = datetime('now')");
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE providers SET ${fields.join(", ")} WHERE id = ? AND ${tc.sql}`).run(...params, id, tc.param);
    return this.get(tenantId, id);
  }

  async delete(tenantId: string, id: number): Promise<boolean> {
    const tc = tenantClause(tenantId);
    const result = this.db.prepare(`DELETE FROM providers WHERE id = ? AND ${tc.sql}`).run(id, tc.param);
    return result.changes > 0;
  }

  /**
   * Seed defaults on an empty registry. Bridges from the legacy env-var
   * setup: if DEEPSEEK_API_KEY is present, the DeepSeek row carries it
   * forward; Ollama is always seeded since it needs no key. SQLite-only —
   * not on ProviderRegistryPort (see the port's doc comment).
   */
  async seedDefaults(tenantId: string): Promise<void> {
    const tc = tenantClause(tenantId);
    const count = this.db.prepare<unknown[], { c: number }>(`SELECT COUNT(*) AS c FROM providers WHERE ${tc.sql}`).get(tc.param);
    if ((count?.c ?? 0) > 0) return;

    await this.insert(tenantId, {
      kind: "ollama",
      name: "Ollama (local)",
      baseUrl: process.env["NLM_OLLAMA_URL"] ?? "http://localhost:11434",
    });

    const deepseekKey = process.env["DEEPSEEK_API_KEY"];
    await this.insert(tenantId, {
      kind: "deepseek",
      name: "DeepSeek",
      apiKey: deepseekKey ?? null,
      enabled: Boolean(deepseekKey),
    });
  }
}

import type { Pool } from "pg";

interface PgProviderDbRow {
  id: number; tenant_id: string; kind: ProviderKind; name: string; base_url: string | null;
  api_key: string | null; default_model: string | null; enabled: boolean;
  created_at: string; updated_at: string;
}

function pgRowToProvider(r: PgProviderDbRow): ProviderRow {
  return {
    id: r.id, tenantId: r.tenant_id, kind: r.kind, name: r.name, baseUrl: r.base_url,
    apiKey: null, hasApiKey: r.api_key !== null && r.api_key.length > 0,
    defaultModel: r.default_model, enabled: r.enabled,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const PG_PROVIDER_COLUMNS = `id, tenant_id, kind, name, base_url, api_key, default_model, enabled, created_at, updated_at`;

/**
 * PgProviderRegistry — CRUD over `providers` for the PG storage path.
 * API mirrors ProviderRegistry exactly.
 */
export class PgProviderRegistry implements ProviderRegistryPort {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<ProviderRow[]> {
    const tc = tenantClausePg(tenantId, 1);
    const result = await this.pool.query<PgProviderDbRow>(
      `SELECT ${PG_PROVIDER_COLUMNS} FROM providers WHERE ${tc.sql} ORDER BY id`,
      [tc.param],
    );
    return result.rows.map(pgRowToProvider);
  }

  async get(tenantId: string, id: number): Promise<ProviderRow | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<PgProviderDbRow>(
      `SELECT ${PG_PROVIDER_COLUMNS} FROM providers WHERE id = $1 AND ${tc.sql}`,
      [id, tc.param],
    );
    return result.rows[0] ? pgRowToProvider(result.rows[0]) : null;
  }

  async getByName(tenantId: string, name: string): Promise<ProviderRow | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<PgProviderDbRow>(
      `SELECT ${PG_PROVIDER_COLUMNS} FROM providers WHERE name = $1 AND ${tc.sql}`,
      [name, tc.param],
    );
    return result.rows[0] ? pgRowToProvider(result.rows[0]) : null;
  }

  /**
   * A tenant-mismatched id returns null, identical to a missing row (top
   * risk 3, spec §4.5) — no existence oracle, no cross-tenant key leak.
   */
  async getSecret(tenantId: string, id: number): Promise<string | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<{ api_key: string | null }>(
      `SELECT api_key FROM providers WHERE id = $1 AND ${tc.sql}`, [id, tc.param],
    );
    return result.rows[0]?.api_key ?? null;
  }

  async insert(tenantId: string, input: ProviderInsert): Promise<ProviderRow> {
    const result = await this.pool.query<{ id: number; created_at: string; updated_at: string }>(
      `INSERT INTO providers (kind, name, base_url, api_key, default_model, enabled, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at, updated_at`,
      [input.kind, input.name, input.baseUrl ?? null, input.apiKey ?? null, input.defaultModel ?? null, input.enabled ?? true, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PgProviderRegistry.insert: RETURNING yielded no row");
    return {
      id: row.id, tenantId, kind: input.kind, name: input.name, baseUrl: input.baseUrl ?? null,
      apiKey: null, hasApiKey: (input.apiKey ?? "").length > 0,
      defaultModel: input.defaultModel ?? null, enabled: input.enabled ?? true,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async update(tenantId: string, id: number, patch: ProviderUpdate): Promise<ProviderRow | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); params.push(patch.name); }
    if (patch.baseUrl !== undefined) { sets.push(`base_url = $${idx++}`); params.push(patch.baseUrl); }
    if (patch.apiKey !== undefined) { sets.push(`api_key = $${idx++}`); params.push(patch.apiKey); }
    if (patch.defaultModel !== undefined) { sets.push(`default_model = $${idx++}`); params.push(patch.defaultModel); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(patch.enabled); }
    if (sets.length === 1) return this.get(tenantId, id);
    params.push(id);
    const tc = tenantClausePg(tenantId, idx + 1);
    params.push(tc.param);
    await this.pool.query(`UPDATE providers SET ${sets.join(", ")} WHERE id = $${idx} AND ${tc.sql}`, params);
    return this.get(tenantId, id);
  }

  async delete(tenantId: string, id: number): Promise<boolean> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query(`DELETE FROM providers WHERE id = $1 AND ${tc.sql}`, [id, tc.param]);
    return (result.rowCount ?? 0) > 0;
  }
}
