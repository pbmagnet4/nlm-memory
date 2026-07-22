/**
 * Classifier provenance round-trip tests for PgSessionStore.
 * Covers: fresh insert with provenance, upsert overwrite, no-descriptor writes NULLs.
 *
 * Requires NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const TRUNCATE_SQL =
  "TRUNCATE TABLE sessions, facts, fact_embeddings, adapter_state RESTART IDENTITY CASCADE";

function record(over: Partial<IngestRecord> & { id: string }): IngestRecord {
  return {
    runtime: "claude-code",
    runtimeSessionId: over.id,
    startedAt: "2026-06-01T10:00:00Z",
    endedAt: "2026-06-01T10:30:00Z",
    durationMin: 30,
    label: "Stub label",
    summary: "Stub summary",
    body: "session body text",
    status: "closed",
    transcriptKind: "claude-code",
    transcriptPath: "/tmp/x.jsonl",
    transcriptOffset: 0,
    transcriptLength: 10,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
    ...over,
  };
}

describe.skipIf(!PG_TEST_URL)("classifier provenance: PG", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });
  beforeEach(async () => { await pool.query(TRUNCATE_SQL); });

  it("round-trips provenance on fresh insert", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "prov_pg_1",
      classifier: { provider: "ollama", model: "deepseek-r1:7b", confidence: 0.85 },
    }));

    const sess = await storage.sessions.getById("team_local", "prov_pg_1");
    expect(sess?.classifierProvider).toBe("ollama");
    expect(sess?.classifierModel).toBe("deepseek-r1:7b");
    expect(Number(sess?.classifierConfidence)).toBeCloseTo(0.85);
  });

  it("upsert overwrites provenance when re-ingested by a new model", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "prov_pg_2",
      classifier: { provider: "ollama", model: "old-model", confidence: 0.7 },
    }));
    await storage.sessions.insertSession("team_local", record({
      id: "prov_pg_2",
      classifier: { provider: "deepseek", model: "deepseek-chat", confidence: 0.95 },
    }));

    const sess = await storage.sessions.getById("team_local", "prov_pg_2");
    expect(sess?.classifierProvider).toBe("deepseek");
    expect(sess?.classifierModel).toBe("deepseek-chat");
    expect(Number(sess?.classifierConfidence)).toBeCloseTo(0.95);
  });

  it("record without classifier field writes NULLs", async () => {
    await storage.sessions.insertSession("team_local", record({ id: "prov_pg_3" }));

    const sess = await storage.sessions.getById("team_local", "prov_pg_3");
    expect(sess?.classifierProvider).toBeNull();
    expect(sess?.classifierModel).toBeNull();
    expect(sess?.classifierConfidence).toBeNull();
  });
});
