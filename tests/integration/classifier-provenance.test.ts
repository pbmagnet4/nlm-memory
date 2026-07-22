/**
 * Classifier provenance round-trip tests for SqliteSessionStore.
 * Covers: fresh insert with provenance, upsert overwrite, no-descriptor writes NULLs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore, IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

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

describe("classifier provenance: SQLite", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-prov-sqlite-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips provenance on fresh insert", async () => {
    await store.insertSession("team_local", record({
      id: "prov_1",
      classifier: { provider: "ollama", model: "deepseek-r1:7b", confidence: 0.85 },
    }));

    const sess = await store.getById("team_local", "prov_1");
    expect(sess?.classifierProvider).toBe("ollama");
    expect(sess?.classifierModel).toBe("deepseek-r1:7b");
    expect(sess?.classifierConfidence).toBeCloseTo(0.85);
  });

  it("upsert overwrites provenance when re-ingested by a new model", async () => {
    await store.insertSession("team_local", record({
      id: "prov_2",
      classifier: { provider: "ollama", model: "old-model", confidence: 0.7 },
    }));
    await store.insertSession("team_local", record({
      id: "prov_2",
      classifier: { provider: "deepseek", model: "deepseek-chat", confidence: 0.95 },
    }));

    const sess = await store.getById("team_local", "prov_2");
    expect(sess?.classifierProvider).toBe("deepseek");
    expect(sess?.classifierModel).toBe("deepseek-chat");
    expect(sess?.classifierConfidence).toBeCloseTo(0.95);
  });

  it("record without classifier field writes NULLs", async () => {
    await store.insertSession("team_local", record({ id: "prov_3" }));

    const sess = await store.getById("team_local", "prov_3");
    expect(sess?.classifierProvider).toBeNull();
    expect(sess?.classifierModel).toBeNull();
    expect(sess?.classifierConfidence).toBeNull();
  });
});
