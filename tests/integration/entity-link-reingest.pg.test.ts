/**
 * Entity-link replace semantics on re-ingest (PostgreSQL mirror).
 *
 * Mirrors entity-link-reingest.test.ts for the PG backend.
 * Requires NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import type { PgSessionStore } from "../../src/core/storage/pg-session-store.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL =
  "TRUNCATE TABLE sessions, entities, session_entities, markers, facts, fact_embeddings, adapter_state RESTART IDENTITY CASCADE";

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

async function entityLinks(pool: Pool, sessionId: string): Promise<string[]> {
  const res = await pool.query<{ entity_canonical: string }>(
    "SELECT entity_canonical FROM session_entities WHERE session_id = $1 ORDER BY entity_canonical",
    [sessionId],
  );
  return res.rows.map((r) => r.entity_canonical);
}

async function entityCount(pool: Pool, canonical: string): Promise<number | undefined> {
  const res = await pool.query<{ session_count: number }>(
    "SELECT session_count FROM entities WHERE canonical = $1",
    [canonical],
  );
  return res.rows[0]?.session_count;
}

describe.skipIf(!PG_TEST_URL)("entity-link replace on re-ingest (PG)", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
  });

  it("fresh ingest links all entities and sets session_count=1", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    expect(await entityLinks(pool, "sess_1")).toEqual(["Alpha", "Beta"]);
    expect(await entityCount(pool, "Alpha")).toBe(1);
    expect(await entityCount(pool, "Beta")).toBe(1);
  });

  it("re-ingest replaces entity links: removed entity loses link, new entity gains link", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(await entityLinks(pool, "sess_1")).toEqual(["Beta", "Gamma"]);
  });

  it("session_count is exact after re-ingest: removed=0, retained=1, added=1", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(await entityCount(pool, "Alpha")).toBe(0);
    expect(await entityCount(pool, "Beta")).toBe(1);
    expect(await entityCount(pool, "Gamma")).toBe(1);
  });

  it("repeated re-ingest is idempotent: third call produces same counts", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));
    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta", "Gamma"]));

    expect(await entityLinks(pool, "sess_1")).toEqual(["Beta", "Gamma"]);
    expect(await entityCount(pool, "Alpha")).toBe(0);
    expect(await entityCount(pool, "Beta")).toBe(1);
    expect(await entityCount(pool, "Gamma")).toBe(1);
  });

  it("session_count reflects truth across multiple sessions", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await storage.sessions.insertSession(makeRecord("sess_2", ["Beta", "Gamma"]));

    expect(await entityCount(pool, "Alpha")).toBe(1);
    expect(await entityCount(pool, "Beta")).toBe(2);
    expect(await entityCount(pool, "Gamma")).toBe(1);

    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta"]));

    expect(await entityCount(pool, "Alpha")).toBe(0);
    expect(await entityCount(pool, "Beta")).toBe(2);
    expect(await entityCount(pool, "Gamma")).toBe(1);
  });

  it("orphaned entity row is retained (not deleted) when session_count reaches 0", async () => {
    await storage.sessions.insertSession(makeRecord("sess_1", ["Alpha", "Beta"]));
    await storage.sessions.insertSession(makeRecord("sess_1", ["Beta"]));

    const res = await pool.query<{ canonical: string; session_count: number }>(
      "SELECT canonical, session_count FROM entities WHERE canonical = $1",
      ["Alpha"],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.session_count).toBe(0);
  });
});
