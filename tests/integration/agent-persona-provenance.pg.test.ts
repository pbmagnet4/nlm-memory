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
    await storage.sessions.insertSession("team_local", record({
      id: "persona_pg_1",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));

    const sess = await storage.sessions.getById("team_local", "persona_pg_1");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });

  it("fresh insert without persona/parent writes NULLs", async () => {
    await storage.sessions.insertSession("team_local", record({ id: "persona_pg_2" }));

    const sess = await storage.sessions.getById("team_local", "persona_pg_2");
    expect(sess?.agentPersona).toBeNull();
    expect(sess?.parentSessionId).toBeNull();
  });

  it("upsert with a new non-null value overwrites", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "persona_pg_3",
      agentPersona: "orchestrator",
    }));
    await storage.sessions.insertSession("team_local", record({
      id: "persona_pg_3",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-xyz",
    }));

    const sess = await storage.sessions.getById("team_local", "persona_pg_3");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-xyz");
  });

  it("upsert omitting the fields preserves the prior stamp (COALESCE)", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "persona_pg_4",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));
    await storage.sessions.insertSession("team_local", record({ id: "persona_pg_4", label: "Re-classified label" }));

    const sess = await storage.sessions.getById("team_local", "persona_pg_4");
    expect(sess?.label).toBe("Re-classified label");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });

  // primary_model / total_tokens / skill (#352 phase 2, Task 5): same
  // insert/upsert/COALESCE contract as agent_persona/parent_session_id above.

  it("round-trips primary_model/total_tokens/skill on fresh insert", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "transcript_pg_1",
      primaryModel: "claude-opus-4-7",
      totalTokens: 1234,
      skill: "code-review",
    }));

    const sess = await storage.sessions.getById("team_local", "transcript_pg_1");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(1234);
    expect(sess?.skill).toBe("code-review");
  });

  it("fresh insert without them writes NULLs", async () => {
    await storage.sessions.insertSession("team_local", record({ id: "transcript_pg_2" }));

    const sess = await storage.sessions.getById("team_local", "transcript_pg_2");
    expect(sess?.primaryModel).toBeNull();
    expect(sess?.totalTokens).toBeNull();
    expect(sess?.skill).toBeNull();
  });

  it("upsert with new non-null values overwrites", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "transcript_pg_3",
      primaryModel: "claude-sonnet-4-5",
      totalTokens: 100,
      skill: "old-skill",
    }));
    await storage.sessions.insertSession("team_local", record({
      id: "transcript_pg_3",
      primaryModel: "claude-opus-4-7",
      totalTokens: 500,
      skill: "new-skill",
    }));

    const sess = await storage.sessions.getById("team_local", "transcript_pg_3");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(500);
    expect(sess?.skill).toBe("new-skill");
  });

  it("upsert omitting the fields preserves the prior stamp (COALESCE)", async () => {
    await storage.sessions.insertSession("team_local", record({
      id: "transcript_pg_4",
      primaryModel: "claude-opus-4-7",
      totalTokens: 999,
      skill: "code-review",
    }));
    await storage.sessions.insertSession("team_local", record({ id: "transcript_pg_4", label: "Re-classified label" }));

    const sess = await storage.sessions.getById("team_local", "transcript_pg_4");
    expect(sess?.label).toBe("Re-classified label");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(999);
    expect(sess?.skill).toBe("code-review");
  });
});
