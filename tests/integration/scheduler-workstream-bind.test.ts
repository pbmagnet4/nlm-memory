/**
 * Integration test: flag-gated workstream binding in the classify sweep.
 *
 * Case 1: NLM_WORKSTREAM_BIND=true + workstreams wired → flushed session gets
 *         a non-null workstream_id and a workstreams row exists.
 * Case 2: flag unset → workstream_id stays NULL, workstreams table empty.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async nameWorkstream(): Promise<string | null> { return "NLM"; }
  async classify(): Promise<ClassifyResult> {
    return {
      label: "Workstream test session",
      summary: "Testing flag-gated workstream bind",
      entities: ["nlm-memory"],
      decisions: ["chose sqlite"],
      open: [],
      confidence: 0.9,
      facts: [],
    };
  }
}


function buildFixture(projects: string): void {
  const projDir = join(projects, "proj");
  mkdirSync(projDir, { recursive: true });
  const jsonl =
    JSON.stringify({ type: "summary", summary: { sessionId: "ws-bind-test-uuid-001" } }) + "\n" +
    JSON.stringify({ type: "user", message: { content: "add workstream binding" }, timestamp: "2026-06-01T10:00:00.000Z" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: "done" }, timestamp: "2026-06-01T10:01:00.000Z" }) + "\n";
  const file = join(projDir, "session.jsonl");
  writeFileSync(file, jsonl);
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(file, old, old);
}

describe("ScanScheduler workstream bind (flag-gated)", () => {
  let storage: SqliteStorage;
  let dbDir: string;
  let projects: string;
  const prevFlag = process.env["NLM_WORKSTREAM_BIND"];

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "nlm-ws-bind-"));
    storage = SqliteStorage.create({
      dbPath: join(dbDir, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    // Pre-seed "NLM" workstream so the stub classifier can match it.
    await storage.workstreams.create({ id: "ws_nlm_test", label: "NLM" });
    projects = mkdtempSync(join(tmpdir(), "nlm-ws-projects-"));
    buildFixture(projects);
  });

  afterEach(async () => {
    await storage.close();
    for (const d of [dbDir, projects]) rmSync(d, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env["NLM_WORKSTREAM_BIND"];
    else process.env["NLM_WORKSTREAM_BIND"] = prevFlag;
  });

  it("binds the session to a workstream when flag is on and workstreams is wired", async () => {
    process.env["NLM_WORKSTREAM_BIND"] = "true";

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 1 });
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      workstreams: storage.workstreams,
      idleMinutes: 1,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const db = new Database(join(dbDir, "canonical.sqlite"), { readonly: true });
    try {
      const sess = db
        .prepare<[], { id: string; workstream_id: string | null }>(
          "SELECT id, workstream_id FROM sessions",
        )
        .all();
      expect(sess).toHaveLength(1);
      expect(sess[0]?.workstream_id).toBe("ws_nlm_test");

      const wsCount = db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM workstreams")
        .get();
      expect(wsCount?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("leaves workstream_id NULL and workstreams empty when flag is off", async () => {
    delete process.env["NLM_WORKSTREAM_BIND"];

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 1 });
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      workstreams: storage.workstreams,
      idleMinutes: 1,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const db = new Database(join(dbDir, "canonical.sqlite"), { readonly: true });
    try {
      const sess = db
        .prepare<[], { workstream_id: string | null }>(
          "SELECT workstream_id FROM sessions",
        )
        .all();
      expect(sess).toHaveLength(1);
      expect(sess[0]?.workstream_id).toBeNull();

      // Only the pre-seeded workstream exists; no new ones were created.
      const wsCount = db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM workstreams")
        .get();
      expect(wsCount?.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
