/**
 * SqliteStorage — canonical Storage adapter for better-sqlite3 + sqlite-vec.
 *
 * Owns the connection. Builds SqliteSessionStore and SqliteFactStore over
 * that single connection so writes commit on one WAL writer (the SQLite
 * atomicity model).
 *
 * rawDb() is a deprecated escape hatch for callers that still use direct
 * better-sqlite3 — scheduler, http actions endpoints, backfill-facts,
 * source/provider registries. Tracked for removal in #215a.
 */

import type Database from "better-sqlite3";
import type { Storage } from "@ports/storage.js";
import { SqliteCodeExemplarStore } from "./sqlite-code-exemplar-store.js";
import { SqliteFactStore } from "./sqlite-fact-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import { SqliteSignalStore } from "./sqlite-signal-store.js";
import { SqliteWorkstreamStore } from "./sqlite-workstream-store.js";
import { SourceRegistry } from "@core/sources/source-registry.js";
import { ProviderRegistry } from "@core/providers/provider-registry.js";

export interface SqliteStorageOptions {
  readonly dbPath: string;
  readonly migrationsDir: string;
}

export class SqliteStorage implements Storage {
  readonly sessions: SqliteSessionStore;
  readonly facts: SqliteFactStore;
  readonly signals: SqliteSignalStore;
  readonly exemplars: SqliteCodeExemplarStore;
  readonly workstreams: SqliteWorkstreamStore;
  readonly sources: SourceRegistry;
  readonly providers: ProviderRegistry;

  private constructor(
    sessions: SqliteSessionStore,
    facts: SqliteFactStore,
    signals: SqliteSignalStore,
    exemplars: SqliteCodeExemplarStore,
    workstreams: SqliteWorkstreamStore,
    sources: SourceRegistry,
    providers: ProviderRegistry,
  ) {
    this.sessions = sessions;
    this.facts = facts;
    this.signals = signals;
    this.exemplars = exemplars;
    this.workstreams = workstreams;
    this.sources = sources;
    this.providers = providers;
  }

  static create(opts: SqliteStorageOptions): SqliteStorage {
    const sessions = new SqliteSessionStore(opts);
    const facts = new SqliteFactStore(sessions.rawDb());
    const signals = new SqliteSignalStore(sessions.rawDb());
    const exemplars = new SqliteCodeExemplarStore(sessions.rawDb());
    const workstreams = new SqliteWorkstreamStore(sessions.rawDb());
    const sources = new SourceRegistry(sessions.rawDb());
    const providers = new ProviderRegistry(sessions.rawDb());
    return new SqliteStorage(sessions, facts, signals, exemplars, workstreams, sources, providers);
  }

  async init(): Promise<void> {
    // SqliteSessionStore runs migrations in its constructor today; this is
    // a no-op for the SQLite adapter. Reserved for backends (Postgres)
    // that need explicit init.
  }

  async close(): Promise<void> {
    this.sessions.close();
  }

  /**
   * @deprecated SQLite-only escape hatch for callers not yet ported to the
   * Storage interface. Tracked for removal in #215a. Do not use in new code.
   */
  rawDb(): Database.Database {
    return this.sessions.rawDb();
  }
}
