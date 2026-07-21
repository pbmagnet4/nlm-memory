/**
 * agent_persona / parent_session_id round-trip tests for SqliteSessionStore.
 * Covers: fresh insert, upsert overwrite with a new non-null value, and the
 * COALESCE-preserve contract when a later write (e.g. reprocess, which has no
 * chunk to derive from) omits the fields entirely.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore, IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { ingestSession } from "../../src/core/ingest/ingest-session.js";
import type { ClassifyResult, LLMClient } from "../../src/ports/llm-client.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";

class StubWebhookClassifier implements LLMClient {
  async embed(): Promise<never> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<ClassifyResult> {
    return { label: "Stub label", summary: "Stub summary", entities: [], decisions: [], open: [], confidence: 0.9, facts: [] };
  }
}

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

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

describe("agent_persona / parent_session_id provenance: SQLite", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-persona-sqlite-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips persona + parent on fresh insert", async () => {
    await store.insertSession(record({
      id: "persona_1",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));

    const sess = await store.getById("persona_1");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });

  it("fresh insert without persona/parent writes NULLs", async () => {
    await store.insertSession(record({ id: "persona_2" }));

    const sess = await store.getById("persona_2");
    expect(sess?.agentPersona).toBeNull();
    expect(sess?.parentSessionId).toBeNull();
  });

  it("upsert with a new non-null value overwrites", async () => {
    await store.insertSession(record({
      id: "persona_3",
      agentPersona: "orchestrator",
    }));
    await store.insertSession(record({
      id: "persona_3",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-xyz",
    }));

    const sess = await store.getById("persona_3");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-xyz");
  });

  it("upsert omitting the fields preserves the prior stamp (COALESCE)", async () => {
    await store.insertSession(record({
      id: "persona_4",
      agentPersona: "code-reviewer",
      parentSessionId: "parent-abc",
    }));
    // Simulates reprocess.ts / reclassify-oversized.ts, which rebuild an
    // IngestRecord with no chunk to derive subagent lineage from.
    await store.insertSession(record({ id: "persona_4", label: "Re-classified label" }));

    const sess = await store.getById("persona_4");
    expect(sess?.label).toBe("Re-classified label");
    expect(sess?.agentPersona).toBe("code-reviewer");
    expect(sess?.parentSessionId).toBe("parent-abc");
  });

  it("webhook ingest path stamps agent_persona = runtime name, parent = null", async () => {
    const result = await ingestSession(
      { runtime: "hermes", text: "some webhook body", startedAt: "2026-06-01T10:00:00Z" },
      { classifier: new StubWebhookClassifier(), embedder: new StubEmbedder(), store, log: () => {} },
    );
    expect(result.status).toBe("ingested");

    const sess = await store.getById(result.id);
    expect(sess?.agentPersona).toBe("hermes");
    expect(sess?.parentSessionId).toBeNull();
  });

  // primary_model / total_tokens / skill (#352 phase 2, Task 5): same
  // insert/upsert/COALESCE contract as agent_persona/parent_session_id above.

  it("round-trips primary_model/total_tokens/skill on fresh insert", async () => {
    await store.insertSession(record({
      id: "transcript_1",
      primaryModel: "claude-opus-4-7",
      totalTokens: 1234,
      skill: "code-review",
    }));

    const sess = await store.getById("transcript_1");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(1234);
    expect(sess?.skill).toBe("code-review");
  });

  it("fresh insert without them writes NULLs", async () => {
    await store.insertSession(record({ id: "transcript_2" }));

    const sess = await store.getById("transcript_2");
    expect(sess?.primaryModel).toBeNull();
    expect(sess?.totalTokens).toBeNull();
    expect(sess?.skill).toBeNull();
  });

  it("upsert with new non-null values overwrites", async () => {
    await store.insertSession(record({
      id: "transcript_3",
      primaryModel: "claude-sonnet-4-5",
      totalTokens: 100,
      skill: "old-skill",
    }));
    await store.insertSession(record({
      id: "transcript_3",
      primaryModel: "claude-opus-4-7",
      totalTokens: 500,
      skill: "new-skill",
    }));

    const sess = await store.getById("transcript_3");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(500);
    expect(sess?.skill).toBe("new-skill");
  });

  it("upsert omitting the fields preserves the prior stamp (COALESCE)", async () => {
    await store.insertSession(record({
      id: "transcript_4",
      primaryModel: "claude-opus-4-7",
      totalTokens: 999,
      skill: "code-review",
    }));
    await store.insertSession(record({ id: "transcript_4", label: "Re-classified label" }));

    const sess = await store.getById("transcript_4");
    expect(sess?.label).toBe("Re-classified label");
    expect(sess?.primaryModel).toBe("claude-opus-4-7");
    expect(sess?.totalTokens).toBe(999);
    expect(sess?.skill).toBe("code-review");
  });
});
