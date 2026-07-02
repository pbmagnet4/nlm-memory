/**
 * Entity-link replace semantics on re-ingest (SQLite).
 *
 * Covers the reprocess-amplification defect: INSERT OR IGNORE kept stale links
 * forever and blind session_count++ double-counted on every re-ingest.
 * Fix: DELETE + re-INSERT session_entities on re-ingest, recompute session_count
 * exactly from COUNT(*) for every entity in (old union new).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestRecord, SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(id: string, entities: string[]): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "Test session",
    summary: "Test summary",
    body: "body text",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities,
    decisions: [],
    openQuestions: [],
  };
}

function entityLinks(store: SqliteSessionStore, sessionId: string): string[] {
  return store
    .rawDb()
    .prepare<[string], { entity_canonical: string }>(
      "SELECT entity_canonical FROM session_entities WHERE session_id = ? ORDER BY entity_canonical",
    )
    .all(sessionId)
    .map((r) => r.entity_canonical);
}

function entityCount(store: SqliteSessionStore, canonical: string): number | undefined {
  return store
    .rawDb()
    .prepare<[string], { session_count: number }>(
      "SELECT session_count FROM entities WHERE canonical = ?",
    )
    .get(canonical)?.session_count;
}

describe("entity-link replace on re-ingest (SQLite)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-entlink-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "test.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fresh ingest links all entities and sets session_count=1", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    expect(entityLinks(store, "sess_1")).toEqual(["Alpha", "Beta"]);
    expect(entityCount(store, "Alpha")).toBe(1);
    expect(entityCount(store, "Beta")).toBe(1);
  });

  it("re-ingest replaces entity links: removed entity loses link, new entity gains link", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await store.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(entityLinks(store, "sess_1")).toEqual(["Beta", "Gamma"]);
  });

  it("session_count is exact after re-ingest: removed=0, retained=1, added=1", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await store.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(entityCount(store, "Alpha")).toBe(0);
    expect(entityCount(store, "Beta")).toBe(1);
    expect(entityCount(store, "Gamma")).toBe(1);
  });

  it("repeated re-ingest is idempotent: third call produces same counts", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await store.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));
    await store.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(entityLinks(store, "sess_1")).toEqual(["Beta", "Gamma"]);
    expect(entityCount(store, "Alpha")).toBe(0);
    expect(entityCount(store, "Beta")).toBe(1);
    expect(entityCount(store, "Gamma")).toBe(1);
  });

  it("session_count reflects truth across multiple sessions", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await store.insertSession(makeRecord("sess_2", ["Beta", "Gamma"]));

    expect(entityCount(store, "Alpha")).toBe(1);
    expect(entityCount(store, "Beta")).toBe(2);
    expect(entityCount(store, "Gamma")).toBe(1);

    // Re-ingest sess_1 dropping Alpha: Beta stays in both sessions, count stays 2
    await store.insertSession(makeRecord("sess_1", ["Beta"]));

    expect(entityCount(store, "Alpha")).toBe(0);
    expect(entityCount(store, "Beta")).toBe(2);
    expect(entityCount(store, "Gamma")).toBe(1);
  });

  it("orphaned entity row is retained (not deleted) when session_count reaches 0", async () => {
    await store.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await store.insertSession(makeRecord("sess_1", ["Beta"]));

    const row = store
      .rawDb()
      .prepare<[string], { canonical: string; session_count: number }>(
        "SELECT canonical, session_count FROM entities WHERE canonical = ?",
      )
      .get("Alpha");
    expect(row).toBeDefined();
    expect(row!.session_count).toBe(0);
  });
});
