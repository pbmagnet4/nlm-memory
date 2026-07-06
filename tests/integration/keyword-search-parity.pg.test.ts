/**
 * keywordSearch semantics parity: pg must use OR semantics matching sqlite.
 *
 * websearch_to_tsquery (implicit AND) returns zero rows for a partial-match
 * multi-term query; to_tsquery with " | " joins returns the session when any
 * term appears.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

function makeRecord(id: string, body: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:30:00Z",
    durationMin: 30,
    label: "test session",
    summary: "test summary",
    body,
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: "/tmp/test.jsonl",
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe.skipIf(!PG_TEST_URL)("keywordSearch OR semantics parity (pg)", () => {
  let storage: PgStorage;

  beforeEach(async () => {
    if (!PG_TEST_URL) throw new Error("NLM_PG_TEST_URL not set");
    storage = PgStorage.create({
      connectionString: PG_TEST_URL,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    await storage.pgPool().query(TRUNCATE_SQL);
  });

  afterEach(async () => {
    await storage.close();
  });

  it("partial-match multi-term query returns the session (OR semantics, matching sqlite)", async () => {
    const store = storage.sessions;
    await store.insertSession(
      makeRecord("kw_parity_1", "discussion about pgvector index performance"),
    );

    const results = await store.keywordSearch("pgvector kubernetes deployment", 10);
    const ids = results.map((r) => r.sessionId);

    expect(ids).toContain("kw_parity_1");
    expect(results.find((r) => r.sessionId === "kw_parity_1")!.score).toBeGreaterThan(0);
  });

  it("no indexable tokens returns empty", async () => {
    const store = storage.sessions;
    await store.insertSession(makeRecord("kw_parity_2", "some content here"));

    const results = await store.keywordSearch("---", 10);
    expect(results).toEqual([]);
  });

  it("all-stopword query returns empty without throwing", async () => {
    const store = storage.sessions;
    await store.insertSession(makeRecord("kw_parity_3", "test content about something"));

    const results = await store.keywordSearch("the and is", 10);
    expect(results).toEqual([]);
  });

  it("multi-term OR behavior returns session when any term matches", async () => {
    const store = storage.sessions;
    await store.insertSession(
      makeRecord("kw_parity_4", "discussion about pgvector and kubernetes"),
    );

    const results = await store.keywordSearch("pgvector kubernetes deployment", 10);
    const ids = results.map((r) => r.sessionId);

    expect(ids).toContain("kw_parity_4");
    expect(results.find((r) => r.sessionId === "kw_parity_4")!.score).toBeGreaterThan(0);
  });
});
