/**
 * TeamTokenStore / PgTeamTokenStore — CRUD over the `team_tokens` table
 * (program spec §2 M1, §3 M3). This IS the tenancy registry, not corpus
 * data: methods take no `tenantId` param by design, same pinned exception as
 * SourceRegistry.findByToken (src/core/sources/source-registry.ts) — the
 * whole point of this store is to RESOLVE a tenant from a presented token,
 * not to be scoped by one. team_tokens is TENANT-NEUTRAL and exempt from the
 * tenantClause guard (tests/integration/tenant-guard.test.ts) for the same
 * reason findByToken is exempt.
 */

import type Database from "better-sqlite3";
import type { Pool } from "pg";

export interface ResolvedTeamToken {
  readonly teamId: string;
}

export interface TeamTokenStorePort {
  /** AUTH lookup: resolves an active (non-revoked) token hash to its team. */
  findActiveByHash(hash: string): Promise<ResolvedTeamToken | null>;
  insert(hash: string, teamId: string): Promise<void>;
  revoke(hash: string): Promise<void>;
  /**
   * Idempotent insert-if-absent. Used for local-mode boot continuity (M3
   * §3): an existing NLM_MCP_TOKEN's hash is seeded once for the default
   * team so it keeps authenticating through the same resolveTeamByToken
   * path as any future per-team token. A no-op if the hash already has a
   * row (active OR revoked) — never resurrects a deliberately revoked token.
   */
  ensureActive(hash: string, teamId: string): Promise<void>;
}

interface TeamTokenDbRow {
  team_id: string;
}

export class TeamTokenStore implements TeamTokenStorePort {
  constructor(private readonly db: Database.Database) {}

  async findActiveByHash(hash: string): Promise<ResolvedTeamToken | null> {
    const row = this.db.prepare<[string], TeamTokenDbRow>(
      "SELECT team_id FROM team_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    ).get(hash);
    return row ? { teamId: row.team_id } : null;
  }

  async insert(hash: string, teamId: string): Promise<void> {
    this.db.prepare(
      "INSERT INTO team_tokens (token_hash, team_id) VALUES (?, ?)",
    ).run(hash, teamId);
  }

  async revoke(hash: string): Promise<void> {
    this.db.prepare(
      "UPDATE team_tokens SET revoked_at = datetime('now') WHERE token_hash = ?",
    ).run(hash);
  }

  async ensureActive(hash: string, teamId: string): Promise<void> {
    const existing = this.db.prepare<[string], { token_hash: string }>(
      "SELECT token_hash FROM team_tokens WHERE token_hash = ?",
    ).get(hash);
    if (existing) return;
    await this.insert(hash, teamId);
  }
}

export class PgTeamTokenStore implements TeamTokenStorePort {
  constructor(private readonly pool: Pool) {}

  async findActiveByHash(hash: string): Promise<ResolvedTeamToken | null> {
    const result = await this.pool.query<TeamTokenDbRow>(
      "SELECT team_id FROM team_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash],
    );
    return result.rows[0] ? { teamId: result.rows[0].team_id } : null;
  }

  async insert(hash: string, teamId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO team_tokens (token_hash, team_id) VALUES ($1, $2)",
      [hash, teamId],
    );
  }

  async revoke(hash: string): Promise<void> {
    await this.pool.query(
      "UPDATE team_tokens SET revoked_at = NOW() WHERE token_hash = $1",
      [hash],
    );
  }

  async ensureActive(hash: string, teamId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO team_tokens (token_hash, team_id) VALUES ($1, $2) ON CONFLICT (token_hash) DO NOTHING",
      [hash, teamId],
    );
  }
}
