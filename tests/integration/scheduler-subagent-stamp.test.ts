/**
 * Ingest write-path tests for Task #352 phase 2: the scheduler stamps
 * agent_persona + parent_session_id at classify time using
 * deriveSubagentMeta (claude-code) or the adapter's own name (every other
 * runtime). Queries the sqlite row directly rather than through
 * SessionStore.getById to keep this test focused on the write path itself.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import { StubClassifier, StubEmbedder } from "../fixtures/llm-stubs.js";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const FIXTURES = resolve(__dirname, "../fixtures/claude_code");

function ageFile(path: string, ageMs: number): void {
  const now = (Date.now() - ageMs) / 1000;
  utimesSync(path, now, now);
}

/** Minimal adapter stub for a non-claude-code runtime: one canned chunk, no subagent concept. */
class FakeAdapter implements TranscriptAdapter {
  readonly runtimeVersion = "hermes/1.0";
  readonly transcriptKind = "hermes-json";
  constructor(readonly name: string, private readonly filePath: string) {}
  detect(): DetectionResult {
    return { adapterName: this.name, enabled: true, path: this.filePath, hint: null };
  }
  async discover(_options?: DiscoverOptions): Promise<ReadonlyArray<string>> {
    return [this.filePath];
  }
  async parseSession(path: string): Promise<SessionChunk | null> {
    return {
      id: "fake_chunk_1",
      runtime: this.runtimeVersion,
      runtimeSessionId: "hermes-session-1",
      sourcePath: path,
      startedAt: "2026-06-01T10:00:00Z",
      endedAt: "2026-06-01T10:05:00Z",
      durationMin: 5,
      turnCount: 2,
      byteRange: [0, 100],
      projectDir: "/tmp/proj",
      gitBranch: "",
      text: "[user] hi\n\n[assistant] hello",
      label: "provisional label",
    };
  }
}

describe("ScanScheduler: agent_persona / parent_session_id stamping", () => {
  let tmp: string;
  let dbPath: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sched-subagent-"));
    dbPath = join(tmp, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  type PersonaRow = { id: string; agent_persona: string | null; parent_session_id: string | null };

  function readSessionRow(id?: string): PersonaRow[] {
    const db = new Database(dbPath);
    sqliteVec.load(db);
    const rows = id
      ? db
          .prepare<[string], PersonaRow>("SELECT id, agent_persona, parent_session_id FROM sessions WHERE id = ?")
          .all(id)
      : db.prepare<[], PersonaRow>("SELECT id, agent_persona, parent_session_id FROM sessions").all();
    db.close();
    return rows;
  }

  it("top-level claude-code session: persona=orchestrator, parent=null", async () => {
    const projects = join(tmp, "projects");
    mkdirSync(join(projects, "project_a"), { recursive: true });
    const file = join(projects, "project_a", "fixture.jsonl");
    copyFileSync(join(FIXTURES, "standard_iso.jsonl"), file);
    ageFile(file, 60 * 60 * 1000);

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const rows = readSessionRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_persona).toBe("orchestrator");
    expect(rows[0]?.parent_session_id).toBeNull();
  });

  it("claude-code subagent session: persona=slug, parent=runtime parent id", async () => {
    const projects = join(tmp, "projects");
    const subDir = join(projects, "project_a", "parent-uuid", "subagents");
    mkdirSync(subDir, { recursive: true });
    const file = join(subDir, "agent-sub-777.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "Do the thing" }, sessionId: "parent-999", agentId: "sub-777", slug: "code-reviewer", timestamp: "2026-06-01T10:00:00Z", cwd: "/tmp/proj" },
      { type: "assistant", message: { role: "assistant", content: "Done" }, sessionId: "parent-999", agentId: "sub-777", slug: "code-reviewer", timestamp: "2026-06-01T10:05:00Z" },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    ageFile(file, 60 * 60 * 1000);

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const rows = readSessionRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_persona).toBe("code-reviewer");
    expect(rows[0]?.parent_session_id).toBe("parent-999");
  });

  it("non-claude-code adapter: persona=adapter name, parent=null", async () => {
    const fakeFile = join(tmp, "fake-session.json");
    writeFileSync(fakeFile, "{}");
    ageFile(fakeFile, 60 * 60 * 1000);

    const adapter = new FakeAdapter("hermes", fakeFile);
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const rows = readSessionRow("fake_chunk_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_persona).toBe("hermes");
    expect(rows[0]?.parent_session_id).toBeNull();
  });
});
