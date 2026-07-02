/**
 * PG variant: flag-gated workstream binding in the classify sweep.
 *
 * Case 1: NLM_WORKSTREAM_BIND=true + workstreams wired -> flushed session gets
 *         a non-null workstream_id and a workstreams row exists.
 * Case 2: flag unset -> workstream_id stays NULL, workstreams table unchanged.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a connection
 * string, e.g.:
 *   export NLM_PG_TEST_URL="postgresql://nlm_test:nlm_test@localhost:5432/nlm_test"
 *
 * Skips when the env var is absent.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    workstream_entities, workstreams,
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async nameWorkstream(): Promise<string | null> { return "NLM"; }
  async classify(): Promise<ClassifyResult> {
    return {
      label: "Workstream test session",
      summary: "Testing flag-gated workstream bind on pg",
      entities: ["nlm-memory"],
      decisions: ["chose postgres"],
      open: [],
      confidence: 0.9,
      facts: [],
    };
  }
}

class StubEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "stub" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async nameWorkstream(): Promise<string | null> { return null; }
  async classify(): Promise<ClassifyResult> { throw new Error("not used"); }
}

function buildFixture(projects: string): void {
  const projDir = join(projects, "proj");
  mkdirSync(projDir, { recursive: true });
  const jsonl =
    JSON.stringify({ type: "summary", summary: { sessionId: "ws-bind-pg-test-uuid-001" } }) + "\n" +
    JSON.stringify({ type: "user", message: { content: "add pg workstream binding" }, timestamp: "2026-06-01T10:00:00.000Z" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: "done" }, timestamp: "2026-06-01T10:01:00.000Z" }) + "\n";
  const file = join(projDir, "session.jsonl");
  writeFileSync(file, jsonl);
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(file, old, old);
}

describe.skipIf(!PG_TEST_URL)("ScanScheduler workstream bind pg (flag-gated)", () => {
  let storage: PgStorage;
  let projects: string;
  const prevFlag = process.env["NLM_WORKSTREAM_BIND"];

  beforeEach(async () => {
    if (!PG_TEST_URL) return;
    storage = PgStorage.create({ connectionString: PG_TEST_URL, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    await storage.pgPool().query(TRUNCATE_SQL);
    await storage.workstreams.create({ id: "ws_nlm_test", label: "NLM" });
    projects = mkdtempSync(join(tmpdir(), "nlm-ws-pg-bind-"));
    buildFixture(projects);
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (projects) rmSync(projects, { recursive: true, force: true });
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

    const pool = storage.pgPool();
    const sessRows = await pool.query<{ id: string; workstream_id: string | null }>(
      "SELECT id, workstream_id FROM sessions",
    );
    expect(sessRows.rows).toHaveLength(1);
    expect(sessRows.rows[0]?.workstream_id).toBe("ws_nlm_test");

    const wsCount = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM workstreams");
    expect(Number(wsCount.rows[0]?.n)).toBe(1);
  });

  it("leaves workstream_id NULL and workstreams count 1 when flag is off", async () => {
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

    const pool = storage.pgPool();
    const sessRows = await pool.query<{ workstream_id: string | null }>(
      "SELECT workstream_id FROM sessions",
    );
    expect(sessRows.rows).toHaveLength(1);
    expect(sessRows.rows[0]?.workstream_id).toBeNull();

    const wsCount = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM workstreams");
    expect(Number(wsCount.rows[0]?.n)).toBe(1);
  });
});
