/**
 * SqliteStorage adapter: EntityStore contract + ingest-side variant lookup.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runEntityStoreContract,
  type EntityStoreContractHarness,
} from "../contract/entity-store.contract.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { Storage } from "../../src/ports/storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nlm-entity-store-"));
}

const harness: EntityStoreContractHarness = {
  name: "SqliteStorage",

  async setup(): Promise<Storage> {
    const tmp = makeTmpDir();
    const storage = SqliteStorage.create({
      dbPath: join(tmp, "test.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    (storage as unknown as { _tmp: string })._tmp = tmp;
    return storage;
  },

  async teardown(storage: Storage): Promise<void> {
    const tmp = (storage as unknown as { _tmp: string })._tmp;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  },

  async seedSession(storage: Storage, sessionId: string, startedAt: string): Promise<void> {
    const db = (storage as SqliteStorage).rawDb();
    db.prepare(
      `INSERT OR IGNORE INTO sessions
         (id, runtime, runtime_session_id, started_at, label, summary, body, status, transcript_kind)
       VALUES (?, 'test', ?, ?, 'lbl', 'sum', '', 'closed', 'claude-code-jsonl')`,
    ).run(sessionId, sessionId, startedAt);
  },

  async seedEntity(
    storage: Storage,
    canonical: string,
    opts: { sessionIds?: string[]; firstSeen?: string; lastSeen?: string; status?: string },
  ): Promise<void> {
    const db = (storage as SqliteStorage).rawDb();
    const status = opts.status ?? "candidate";
    const firstSeen = opts.firstSeen ?? opts.sessionIds?.[0] ?? null;
    const lastSeen = opts.lastSeen ?? opts.sessionIds?.[opts.sessionIds.length - 1] ?? null;
    db.prepare(
      `INSERT OR IGNORE INTO entities
         (canonical, type, status, first_seen_session, last_seen_session, session_count)
       VALUES (?, 'candidate', ?, ?, ?, 0)`,
    ).run(canonical, status, firstSeen, lastSeen);
    for (const sid of opts.sessionIds ?? []) {
      db.prepare(
        "INSERT OR IGNORE INTO session_entities (session_id, entity_canonical) VALUES (?, ?)",
      ).run(sid, canonical);
    }
    const count = (opts.sessionIds ?? []).length;
    db.prepare(
      "UPDATE entities SET session_count = ? WHERE canonical = ?",
    ).run(count, canonical);
  },

  async seedVariant(storage: Storage, variant: string, canonical: string): Promise<void> {
    const db = (storage as SqliteStorage).rawDb();
    db.prepare(
      "INSERT OR IGNORE INTO entity_variants (variant, canonical) VALUES (?, ?)",
    ).run(variant, canonical);
  },

  async getEntityRow(storage: Storage, canonical: string) {
    const db = (storage as SqliteStorage).rawDb();
    const row = db
      .prepare<
        [string],
        { status: string; session_count: number; first_seen_session: string | null; last_seen_session: string | null }
      >("SELECT status, session_count, first_seen_session, last_seen_session FROM entities WHERE canonical = ?")
      .get(canonical);
    if (!row) return null;
    return {
      status: row.status,
      sessionCount: row.session_count,
      firstSeenSession: row.first_seen_session,
      lastSeenSession: row.last_seen_session,
    };
  },

  async getVariantRow(storage: Storage, variant: string) {
    const db = (storage as SqliteStorage).rawDb();
    const row = db
      .prepare<[string], { canonical: string }>(
        "SELECT canonical FROM entity_variants WHERE variant = ?",
      )
      .get(variant);
    return row ?? null;
  },

  async getSessionEntityLinks(storage: Storage, entityCanonical: string) {
    const db = (storage as SqliteStorage).rawDb();
    return db
      .prepare<[string], { session_id: string }>(
        "SELECT session_id FROM session_entities WHERE entity_canonical = ?",
      )
      .all(entityCanonical)
      .map((r) => r.session_id);
  },
};

runEntityStoreContract(harness);

describe("ingest-side variant lookup (SQLite)", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = makeTmpDir();
    storage = SqliteStorage.create({
      dbPath: join(tmp, "test.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingest of a merged surface form links to the canonical entity", async () => {
    const db = storage.rawDb();

    db.prepare(
      `INSERT INTO sessions
         (id, runtime, runtime_session_id, started_at, label, summary, body, status, transcript_kind)
       VALUES ('sess_canonical', 'test', 'sess_canonical', '2026-01-01T00:00:00Z', 'lbl', 'sum', '', 'closed', 'claude-code-jsonl')`,
    ).run();
    db.prepare(
      `INSERT INTO entities (canonical, type, status, session_count)
       VALUES ('canonical-ent', 'candidate', 'candidate', 0)`,
    ).run();
    db.prepare(
      "INSERT INTO entity_variants (variant, canonical) VALUES ('old-spelling', 'canonical-ent')",
    ).run();

    await storage.sessions.insertSession("team_local", {
      id: "sess_new",
      runtime: "claude-code",
      runtimeSessionId: "sess_new",
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
      durationMin: null,
      label: "test",
      summary: "test",
      body: "test",
      status: "closed",
      transcriptKind: "claude-code-jsonl",
      transcriptPath: null,
      transcriptOffset: null,
      transcriptLength: null,
      entities: ["old-spelling"],
      decisions: [],
      openQuestions: [],
      scope: null,
    });

    const links = db
      .prepare<[string], { session_id: string }>(
        "SELECT session_id FROM session_entities WHERE entity_canonical = ?",
      )
      .all("canonical-ent")
      .map((r) => r.session_id);
    expect(links).toContain("sess_new");

    const retiredLinks = db
      .prepare<[string], { session_id: string }>(
        "SELECT session_id FROM session_entities WHERE entity_canonical = ?",
      )
      .all("old-spelling")
      .map((r) => r.session_id);
    expect(retiredLinks).toEqual([]);
  });
});
