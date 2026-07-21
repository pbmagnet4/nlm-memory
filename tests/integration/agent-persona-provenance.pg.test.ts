/**
 * agent_persona / parent_session_id round-trip tests for PgSessionStore.
 * Mirrors agent-persona-provenance.test.ts. Requires NLM_PG_TEST_URL; skips
 * when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

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

describe.skipIf(!PG_TEST_URL)("agent_persona / parent_session_id provenance: PG", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });
  beforeEach(async () => { await pool.query(TRUNCATE_SQL); });

  it("round-trips persona + parent on fresh insert", async () => {
    await storage.sessions.insertSession(record({
      id: "persona_pg_1",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));

    const sess = await storage.sessions.getById("persona_pg_1");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });

  it("fresh insert without persona/parent writes NULLs", async () => {
    await storage.sessions.insertSession(record({ id: "persona_pg_2" }));

    const sess = await storage.sessions.getById("persona_pg_2");
    expect(sess?.agentPersona).toBeNull();
    expect(sess?.parentSessionId).toBeNull();
  });

  it("upsert with a new non-null value overwrites", async () => {
    await storage.sessions.insertSession(record({
      id: "persona_pg_3",
      agentPersona: "orchestrator",
    }));
    await storage.sessions.insertSession(record({
      id: "persona_pg_3",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-xyz",
    }));

    const sess = await storage.sessions.getById("persona_pg_3");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-xyz");
  });

  it("upsert omitting the fields preserves the prior stamp (COALESCE)", async () => {
    await storage.sessions.insertSession(record({
      id: "persona_pg_4",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));
    await storage.sessions.insertSession(record({ id: "persona_pg_4", label: "Re-classified label" }));

    const sess = await storage.sessions.getById("persona_pg_4");
    expect(sess?.label).toBe("Re-classified label");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });
});
