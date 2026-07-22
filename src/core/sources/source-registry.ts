/**
 * SourceRegistry — CRUD over the `sources` table.
 *
 * A "source" is any transcript origin the daemon scans (Claude Code's
 * projects dir, Hermes's sessions dir, pi.dev, a user-defined JSONL
 * directory, or a webhook).
 *
 * The three legacy adapters (claude-code, hermes, pi) seed as preset rows
 * pointing at fixed `path_or_url` values. The generic JSONL adapter and
 * webhook ingest piggy-back on this same table — the scheduler chooses
 * which adapter to dispatch by reading `kind`.
 *
 * See docs/plans/desktop-product.md (Phase 0).
 *
 * Tenancy (program spec §4, M2 plan Wave B5): `sources` is a STAMP table.
 * Every method except `findByToken` takes `tenantId` as its non-optional
 * first parameter and routes its WHERE fragment through `tenantClause`;
 * INSERTs stamp `tenant_id`. `findByToken` is the one pinned exception — it
 * is an AUTH lookup, not a corpus read: it takes no tenantId because its job
 * is to RESOLVE the tenant from the bearer token. The returned row carries
 * its own `tenantId` field so callers (M4 ingest attribution) derive the
 * tenant from the resolved row rather than being handed one.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { tenantClause, tenantClausePg } from "@core/tenancy/tenant-clause.js";
import { defaultHistoryFile as defaultAiderHistoryFile } from "../adapters/aider.js";
import { defaultDbPath as defaultCursorDbPath } from "../adapters/cursor.js";
import { defaultDbPath as defaultHermesAgentDbPath } from "../adapters/hermes-agent.js";
import { defaultDbPath as defaultOpenCodeDbPath } from "../adapters/opencode.js";
import { defaultUserDir as defaultWindsurfUserDir } from "../adapters/windsurf.js";

export type SourceKind = "claude-code" | "codex" | "hermes" | "hermes-agent" | "aider" | "cursor" | "windsurf" | "opencode" | "pi" | "jsonl-generic" | "webhook";

export interface SourceRow {
  readonly id: number;
  readonly tenantId: string;
  readonly kind: SourceKind;
  readonly name: string;
  readonly pathOrUrl: string | null;
  readonly runtimeLabel: string;
  readonly parseConfig: Record<string, unknown>;
  readonly enabled: boolean;
  /** Only populated on the response from `insert()` for webhook sources.
   *  Always `null` from `list()` / `get()`. Use `getToken()` inside the daemon. */
  readonly token: string | null;
  readonly hasToken: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SourceInsert {
  readonly kind: SourceKind;
  readonly name: string;
  readonly pathOrUrl?: string | null;
  readonly runtimeLabel: string;
  readonly parseConfig?: Record<string, unknown>;
  readonly enabled?: boolean;
}

export interface SourceUpdate {
  readonly name?: string;
  readonly pathOrUrl?: string | null;
  readonly runtimeLabel?: string;
  readonly parseConfig?: Record<string, unknown>;
  readonly enabled?: boolean;
}

interface SourceDbRow {
  id: number;
  tenant_id: string;
  kind: string;
  name: string;
  path_or_url: string | null;
  runtime_label: string;
  parse_config: string;
  enabled: number;
  token: string | null;
  created_at: string;
  updated_at: string;
}

function rowFromDb(r: SourceDbRow, revealedToken: string | null = null): SourceRow {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = r.parse_config ? (JSON.parse(r.parse_config) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind as SourceKind,
    name: r.name,
    pathOrUrl: r.path_or_url,
    runtimeLabel: r.runtime_label,
    parseConfig: parsed,
    enabled: r.enabled === 1,
    token: revealedToken,
    hasToken: r.token !== null && r.token.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mintToken(): string {
  return `nlm_${randomBytes(24).toString("hex")}`;
}

/**
 * SourceRegistryPort — the backend-agnostic source-registry contract that
 * SqliteStorage and PgStorage expose as `storage.sources`. Async across both
 * backends (the SQLite impl declares async methods with sync bodies, matching
 * the SignalStore/FactStore convention). `getToken` is intentionally NOT on the
 * port — only the not-yet-ported scheduler reads it, via rawDb directly.
 */
export interface SourceRegistryPort {
  list(tenantId: string): Promise<SourceRow[]>;
  get(tenantId: string, id: number): Promise<SourceRow | null>;
  getByName(tenantId: string, name: string): Promise<SourceRow | null>;
  insert(tenantId: string, input: SourceInsert): Promise<SourceRow>;
  /** AUTH lookup, not a corpus read — resolves the tenant, takes none. */
  findByToken(token: string): Promise<SourceRow | null>;
  regenerateToken(tenantId: string, id: number): Promise<string | null>;
  update(tenantId: string, id: number, patch: SourceUpdate): Promise<SourceRow | null>;
  delete(tenantId: string, id: number): Promise<boolean>;
  seedDefaults(tenantId: string): Promise<void>;
}

export class SourceRegistry implements SourceRegistryPort {
  constructor(private readonly db: Database.Database) {}

  async list(tenantId: string): Promise<SourceRow[]> {
    const tc = tenantClause(tenantId);
    const rows = this.db.prepare<unknown[], SourceDbRow>(
      `SELECT * FROM sources WHERE ${tc.sql} ORDER BY id ASC`,
    ).all(tc.param);
    return rows.map((r) => rowFromDb(r));
  }

  async get(tenantId: string, id: number): Promise<SourceRow | null> {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], SourceDbRow>(
      `SELECT * FROM sources WHERE id = ? AND ${tc.sql}`,
    ).get(id, tc.param);
    return row ? rowFromDb(row) : null;
  }

  async getByName(tenantId: string, name: string): Promise<SourceRow | null> {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], SourceDbRow>(
      `SELECT * FROM sources WHERE name = ? AND ${tc.sql}`,
    ).get(name, tc.param);
    return row ? rowFromDb(row) : null;
  }

  async insert(tenantId: string, input: SourceInsert): Promise<SourceRow> {
    const token = input.kind === "webhook" ? mintToken() : null;
    const stmt = this.db.prepare(`
      INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled, token, tenant_id)
      VALUES (@kind, @name, @path_or_url, @runtime_label, @parse_config, @enabled, @token, @tenant_id)
    `);
    const result = stmt.run({
      kind: input.kind,
      name: input.name,
      path_or_url: input.pathOrUrl ?? null,
      runtime_label: input.runtimeLabel,
      parse_config: JSON.stringify(input.parseConfig ?? {}),
      enabled: input.enabled === false ? 0 : 1,
      token,
      tenant_id: tenantId,
    });
    const id = Number(result.lastInsertRowid);
    const dbRow = this.db.prepare<[number], SourceDbRow>(
      `SELECT * FROM sources WHERE id = ?`,
    ).get(id);
    if (!dbRow) throw new Error(`SourceRegistry.insert: row ${id} not found after insert`);
    // Reveal the token on the insert response only — this is the user's
    // one chance to copy it. Subsequent list/get redact.
    return rowFromDb(dbRow, token);
  }

  /**
   * Daemon-internal: resolve a bearer token to its owning source. AUTH
   * lookup, not a corpus read — no tenantId param by design (program spec
   * §3, M2 plan Wave B5 pinned semantics): this RESOLVES the tenant. The
   * returned row's `tenantId` field is the caller's derivation point.
   */
  async findByToken(token: string): Promise<SourceRow | null> {
    if (!token) return null;
    const row = this.db.prepare<[string], SourceDbRow>(
      `SELECT * FROM sources WHERE token = ?`,
    ).get(token);
    return row ? rowFromDb(row) : null;
  }

  /** Daemon-internal: returns the raw token. Never echo to HTTP responses.
   *  Not on SourceRegistryPort — only the (unported) scheduler reads it. */
  getToken(tenantId: string, id: number): string | null {
    const tc = tenantClause(tenantId);
    const row = this.db.prepare<unknown[], { token: string | null }>(
      `SELECT token FROM sources WHERE id = ? AND ${tc.sql}`,
    ).get(id, tc.param);
    return row?.token ?? null;
  }

  /** Mint a fresh token, invalidating any previous one. */
  async regenerateToken(tenantId: string, id: number): Promise<string | null> {
    const current = await this.get(tenantId, id);
    if (!current || current.kind !== "webhook") return null;
    const token = mintToken();
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE sources SET token = ?, updated_at = datetime('now') WHERE id = ? AND ${tc.sql}`)
      .run(token, id, tc.param);
    return token;
  }

  async update(tenantId: string, id: number, patch: SourceUpdate): Promise<SourceRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.pathOrUrl !== undefined) { fields.push("path_or_url = ?"); params.push(patch.pathOrUrl); }
    if (patch.runtimeLabel !== undefined) { fields.push("runtime_label = ?"); params.push(patch.runtimeLabel); }
    if (patch.parseConfig !== undefined) { fields.push("parse_config = ?"); params.push(JSON.stringify(patch.parseConfig)); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (fields.length === 0) return this.get(tenantId, id);
    fields.push("updated_at = datetime('now')");
    const tc = tenantClause(tenantId);
    this.db.prepare(`UPDATE sources SET ${fields.join(", ")} WHERE id = ? AND ${tc.sql}`).run(...params, id, tc.param);
    return this.get(tenantId, id);
  }

  async delete(tenantId: string, id: number): Promise<boolean> {
    const tc = tenantClause(tenantId);
    const result = this.db.prepare(`DELETE FROM sources WHERE id = ? AND ${tc.sql}`).run(id, tc.param);
    return result.changes > 0;
  }

  /**
   * Seed the three legacy adapter presets on first boot of an empty
   * registry. Subsequent boots are no-ops. Respects per-runtime env
   * overrides so existing installs don't lose their custom paths.
   */
  async seedDefaults(tenantId: string): Promise<void> {
    const tc = tenantClause(tenantId);
    const count = this.db.prepare<unknown[], { c: number }>(`SELECT COUNT(*) AS c FROM sources WHERE ${tc.sql}`).get(tc.param);
    if ((count?.c ?? 0) > 0) return;

    const claudePath = process.env["NLM_CLAUDE_PROJECTS_PATH"]
      ?? join(homedir(), ".claude", "projects");
    const codexPath = process.env["NLM_CODEX_SESSIONS_PATH"]
      ?? join(homedir(), ".codex", "sessions");
    const hermesPath = process.env["NLM_HERMES_SESSIONS_PATH"]
      ?? join(homedir(), ".hermes", "sessions");
    const piPath = process.env["PI_SESSIONS_PATH"]
      ?? join(homedir(), ".pi", "agent", "sessions");

    const openCodeDbPath = defaultOpenCodeDbPath();
    const hermesAgentDbPath = defaultHermesAgentDbPath();
    const aiderHistoryFile = defaultAiderHistoryFile();
    const cursorDbPath = defaultCursorDbPath();
    const windsurfUserDir = defaultWindsurfUserDir();

    const presets: SourceInsert[] = [
      {
        kind: "claude-code",
        name: "Claude Code",
        pathOrUrl: claudePath,
        runtimeLabel: "claude-code/1.0",
        enabled: existsSync(claudePath),
      },
      {
        kind: "codex",
        name: "Codex",
        pathOrUrl: codexPath,
        runtimeLabel: "codex/1.0",
        enabled: existsSync(codexPath),
      },
      {
        kind: "hermes",
        name: "Hermes",
        pathOrUrl: hermesPath,
        runtimeLabel: "hermes/1.0",
        enabled: existsSync(hermesPath),
      },
      {
        kind: "hermes-agent",
        name: "Hermes Agent",
        pathOrUrl: hermesAgentDbPath,
        runtimeLabel: "hermes-agent/1.0",
        enabled: existsSync(hermesAgentDbPath),
      },
      {
        kind: "aider",
        name: "Aider",
        pathOrUrl: aiderHistoryFile,
        runtimeLabel: "aider/1.0",
        enabled: existsSync(aiderHistoryFile),
      },
      {
        kind: "cursor",
        name: "Cursor",
        pathOrUrl: cursorDbPath,
        runtimeLabel: "cursor/1.0",
        enabled: existsSync(cursorDbPath),
      },
      {
        kind: "windsurf",
        name: "Windsurf",
        pathOrUrl: windsurfUserDir,
        runtimeLabel: "windsurf/1.0",
        enabled: existsSync(windsurfUserDir),
      },
      {
        kind: "opencode",
        name: "OpenCode",
        pathOrUrl: openCodeDbPath,
        runtimeLabel: "opencode/1.0",
        enabled: existsSync(openCodeDbPath),
      },
      {
        kind: "pi",
        name: "pi.dev",
        pathOrUrl: piPath,
        runtimeLabel: "pi/1.0",
        enabled: existsSync(piPath),
      },
    ];
    for (const p of presets) await this.insert(tenantId, p);
  }
}

import type { Pool } from "pg";

interface PgSourceDbRow {
  id: number; tenant_id: string; kind: SourceKind; name: string; path_or_url: string | null;
  runtime_label: string; parse_config: string; enabled: boolean;
  token: string | null; created_at: string; updated_at: string;
}

function pgRowToSource(r: PgSourceDbRow): SourceRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    name: r.name,
    pathOrUrl: r.path_or_url,
    runtimeLabel: r.runtime_label,
    parseConfig: (() => { try { return JSON.parse(r.parse_config) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })(),
    enabled: r.enabled,
    token: null,
    hasToken: r.token !== null && r.token.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PG_SOURCE_COLUMNS = `id, tenant_id, kind, name, path_or_url, runtime_label, parse_config,
              enabled, token, created_at, updated_at`;

/**
 * PgSourceRegistry — CRUD over `sources` for the PG storage path.
 * Takes a pg.Pool instead of better-sqlite3.Database.
 * API mirrors SourceRegistry exactly so callers swap the constructor arg.
 */
export class PgSourceRegistry implements SourceRegistryPort {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string): Promise<SourceRow[]> {
    const tc = tenantClausePg(tenantId, 1);
    const result = await this.pool.query<PgSourceDbRow>(
      `SELECT ${PG_SOURCE_COLUMNS} FROM sources WHERE ${tc.sql} ORDER BY id`,
      [tc.param],
    );
    return result.rows.map(pgRowToSource);
  }

  async get(tenantId: string, id: number): Promise<SourceRow | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<PgSourceDbRow>(
      `SELECT ${PG_SOURCE_COLUMNS} FROM sources WHERE id = $1 AND ${tc.sql}`,
      [id, tc.param],
    );
    if (!result.rows[0]) return null;
    return pgRowToSource(result.rows[0]);
  }

  async getByName(tenantId: string, name: string): Promise<SourceRow | null> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query<PgSourceDbRow>(
      `SELECT ${PG_SOURCE_COLUMNS} FROM sources WHERE name = $1 AND ${tc.sql}`,
      [name, tc.param],
    );
    return result.rows[0] ? pgRowToSource(result.rows[0]) : null;
  }

  /**
   * Daemon-internal: resolve a bearer token to its owning source. AUTH
   * lookup, not a corpus read — no tenantId param by design (program spec
   * §3, M2 plan Wave B5 pinned semantics): this RESOLVES the tenant. The
   * returned row's `tenantId` field is the caller's derivation point.
   */
  async findByToken(token: string): Promise<SourceRow | null> {
    if (!token) return null;
    const result = await this.pool.query<PgSourceDbRow>(
      `SELECT ${PG_SOURCE_COLUMNS} FROM sources WHERE token = $1`,
      [token],
    );
    return result.rows[0] ? pgRowToSource(result.rows[0]) : null;
  }

  /** Mint a fresh token, invalidating any previous one. Webhook sources only. */
  async regenerateToken(tenantId: string, id: number): Promise<string | null> {
    const current = await this.get(tenantId, id);
    if (!current || current.kind !== "webhook") return null;
    const token = mintToken();
    const tc = tenantClausePg(tenantId, 3);
    await this.pool.query(
      `UPDATE sources SET token = $1, updated_at = NOW() WHERE id = $2 AND ${tc.sql}`,
      [token, id, tc.param],
    );
    return token;
  }

  async insert(tenantId: string, input: SourceInsert): Promise<SourceRow> {
    // Webhook sources get a token minted at insert time — revealed once on the
    // insert response only. Subsequent list()/get() always return token: null.
    const token = input.kind === "webhook" ? mintToken() : null;
    const result = await this.pool.query<{ id: number; created_at: string; updated_at: string }>(
      `INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled, token, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at, updated_at`,
      [
        input.kind, input.name, input.pathOrUrl ?? null, input.runtimeLabel,
        JSON.stringify(input.parseConfig ?? {}), input.enabled ?? true, token, tenantId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PgSourceRegistry.insert: RETURNING yielded no row");
    return {
      id: row.id, tenantId, kind: input.kind, name: input.name, pathOrUrl: input.pathOrUrl ?? null,
      runtimeLabel: input.runtimeLabel,
      parseConfig: input.parseConfig ?? {},
      enabled: input.enabled ?? true,
      token, hasToken: token !== null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async update(tenantId: string, id: number, patch: SourceUpdate): Promise<SourceRow | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name = $${idx++}`); params.push(patch.name); }
    if (patch.pathOrUrl !== undefined) { sets.push(`path_or_url = $${idx++}`); params.push(patch.pathOrUrl); }
    if (patch.runtimeLabel !== undefined) { sets.push(`runtime_label = $${idx++}`); params.push(patch.runtimeLabel); }
    if (patch.parseConfig !== undefined) { sets.push(`parse_config = $${idx++}`); params.push(JSON.stringify(patch.parseConfig)); }
    if (patch.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(patch.enabled); }
    if (sets.length === 1) return this.get(tenantId, id);
    params.push(id);
    const tc = tenantClausePg(tenantId, idx + 1);
    params.push(tc.param);
    await this.pool.query(
      `UPDATE sources SET ${sets.join(", ")} WHERE id = $${idx} AND ${tc.sql}`,
      params,
    );
    return this.get(tenantId, id);
  }

  async delete(tenantId: string, id: number): Promise<boolean> {
    const tc = tenantClausePg(tenantId, 2);
    const result = await this.pool.query(`DELETE FROM sources WHERE id = $1 AND ${tc.sql}`, [id, tc.param]);
    return (result.rowCount ?? 0) > 0;
  }

  async seedDefaults(tenantId: string): Promise<void> {
    const presets: Array<{ kind: SourceKind; name: string; path_or_url: string | null; runtime_label: string }> = [
      { kind: "claude-code", name: "claude-code", path_or_url: null, runtime_label: "claude-code" },
      { kind: "hermes", name: "hermes", path_or_url: null, runtime_label: "hermes" },
      { kind: "pi", name: "pi", path_or_url: null, runtime_label: "pi" },
    ];
    for (const p of presets) {
      await this.pool.query(
        `INSERT INTO sources (kind, name, path_or_url, runtime_label, parse_config, enabled, tenant_id)
         VALUES ($1, $2, $3, $4, '{}', TRUE, $5)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [p.kind, p.name, p.path_or_url, p.runtime_label, tenantId],
      );
    }
  }
}
