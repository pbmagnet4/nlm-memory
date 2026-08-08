import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import {
  embedFailureSnapshot,
  resetEmbedFailureForTests,
} from "../../src/core/health/embed-failure-state.js";
import { StubEmbedder, FixedEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const TENANT = "team_local";

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

describe("SQLite ingest embed-failure visibility", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    resetEmbedFailureForTests();
    tmp = mkdtempSync(join(tmpdir(), "nlm-embfail-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("counts chunk-embed failures, still commits the session", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_fail"), new StubEmbedder({ fail: true }));
    expect(embedFailureSnapshot().chunk).toBeGreaterThanOrEqual(1);
    const row = await storage.sessions.getById(TENANT, "sess_fail");
    expect(row).not.toBeNull();
  });

  it("records zero failures on the success path", async () => {
    await storage.sessions.insertSession(TENANT, makeRecord("sess_ok"), new FixedEmbedder());
    expect(embedFailureSnapshot().chunk).toBe(0);
  });
});
