/**
 * embed-failure-pg.pg.test.ts
 *
 * Verifies that chunk-embed failures on the Postgres ingest path increment
 * the shared counter and still commit the session row (tolerate-and-continue).
 * Mirrors embed-failure-sqlite.test.ts on the SQLite path.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import {
  embedFailureSnapshot,
  resetEmbedFailureForTests,
} from "../../src/core/health/embed-failure-state.js";
import { StubEmbedder, FixedEmbedder } from "../fixtures/llm-stubs.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const TENANT = "team_local";

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

function makeRecord(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: null,
    startedAt: "2026-08-08T00:00:00Z",
    endedAt: "2026-08-08T00:05:00Z",
    durationMin: 5,
    label: "embed failure fixture",
    summary: "a session whose chunks fail to embed",
    body: "chunk one body text. chunk two body text. enough content to chunk.",
    status: "idle",
    transcriptKind: null,
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: ["NLM"],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe.skipIf(!PG_TEST_URL)("Postgres ingest embed-failure visibility", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({
      connectionString: pgUrl(),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    resetEmbedFailureForTests();
    await pool.query(TRUNCATE_SQL);
  });

  it("counts chunk-embed failures, still commits the session", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_pg_fail"), new StubEmbedder({ fail: true }));
    expect(embedFailureSnapshot().chunk).toBeGreaterThanOrEqual(1);
    const row = await storage.sessions.getById(TENANT, "sess_pg_fail");
    expect(row).not.toBeNull();
  });

  it("records zero failures on the success path", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_pg_ok"), new FixedEmbedder());
    expect(embedFailureSnapshot().chunk).toBe(0);
  });
});
