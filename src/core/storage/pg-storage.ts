/**
 * PgStorage — canonical Storage adapter for PostgreSQL + pgvector.
 *
 * Implements the Storage port (init/close). Adapter methods manage atomicity
 * internally via explicit BEGIN/COMMIT on a PoolClient.
 *
 * pgPool() is a deprecated escape hatch for callers not yet ported to the
 * Storage interface. Tracked for removal in #215a (PG branch).
 */

import { Pool, TypeOverrides } from "pg";
import type { Storage } from "@ports/storage.js";
import { runMigrationsPg } from "./pg-migrate.js";
import { PgFactStore } from "./pg-fact-store.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgSignalStore } from "./pg-signal-store.js";
import { PgCodeExemplarStore } from "./pg-code-exemplar-store.js";
import { PgWorkstreamStore } from "./pg-workstream-store.js";
import { PgSourceRegistry } from "@core/sources/source-registry.js";
import { PgProviderRegistry } from "@core/providers/provider-registry.js";

export interface PgStorageOptions {
  readonly connectionString: string;
  readonly migrationsDir: string;
}

export class PgStorage implements Storage {
  readonly facts: PgFactStore;
  readonly sessions: PgSessionStore;
  readonly signals: PgSignalStore;
  readonly exemplars: PgCodeExemplarStore;
  readonly workstreams: PgWorkstreamStore;
  readonly sources: PgSourceRegistry;
  readonly providers: PgProviderRegistry;
  private readonly _pool: Pool;
  private readonly _migrationsDir: string;

  private constructor(pool: Pool, migrationsDir: string) {
    this._pool = pool;
    this._migrationsDir = migrationsDir;
    this.facts = new PgFactStore(pool);
    this.sessions = new PgSessionStore(pool);
    this.signals = new PgSignalStore(pool);
    this.exemplars = new PgCodeExemplarStore(pool);
    this.workstreams = new PgWorkstreamStore(pool);
    this.sources = new PgSourceRegistry(pool);
    this.providers = new PgProviderRegistry(pool);
  }

  static create(opts: PgStorageOptions): PgStorage {
    const types = new TypeOverrides();
    const isoParser = (val: string) => new Date(val).toISOString();
    types.setTypeParser(1184, isoParser); // TIMESTAMPTZ
    types.setTypeParser(1114, isoParser); // TIMESTAMP
    const pool = new Pool({ connectionString: opts.connectionString, types });
    return new PgStorage(pool, opts.migrationsDir);
  }

  async init(): Promise<void> {
    await runMigrationsPg(this._pool, this._migrationsDir);
  }

  async close(): Promise<void> {
    await this._pool.end();
  }

  /**
   * Raw pool accessor. The #215a escape-hatch callers (registries, actions,
   * scheduler, ingest, backfill) have all been ported to the Storage port /
   * adapter methods. The one remaining caller is `nlm check-invariants`, which
   * deliberately runs backend-specific invariant SQL through `runChecksOnPg` /
   * `applyFixOnPg` — a dual-backend diagnostic API, not an un-ported leak.
   */
  pgPool(): Pool {
    return this._pool;
  }
}
