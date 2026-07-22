/**
 * PG parity for scope stamping: session + fact scope via PgSessionStore
 * insertSession and ingestSessionFactsOnClient.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { makeFact } from "../fixtures/facts.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    code_exemplar_embeddings, code_exemplars, signals,
    workstream_entities, workstreams,
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

function makeRecord(id: string, scope: string | null): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: null,
    startedAt: "2026-06-01T10:00:00Z",
    endedAt: "2026-06-01T10:30:00Z",
    durationMin: 30,
    label: "scope parity",
    summary: "pg scope stamping",
    body: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope,
  };
}

describe.skipIf(!PG_TEST_URL)("pg scope stamping parity", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
  });

  it("insertSession stores the stamped scope and facts inherit it", async () => {
    const fact = makeFact({ id: "f_scope", subject: "db", predicate: "backend", value: "pg", sourceSessionId: "sess_scoped" });
    await storage.sessions.insertSession( "team_local",makeRecord("sess_scoped", "client-a"), null, null, {
      factStore: storage.facts,
      facts: [fact],
    });

    const sess = (await pool.query("SELECT scope FROM sessions WHERE id = 'sess_scoped'")).rows[0];
    expect(sess.scope).toBe("client-a");
    const factRow = (await pool.query("SELECT scope FROM facts WHERE id = 'f_scope'")).rows[0];
    expect(factRow.scope).toBe("client-a");
  });

  it("insertSession with null scope leaves session and fact scope NULL", async () => {
    const fact = makeFact({ id: "f_null", subject: "db", predicate: "backend", value: "pg", sourceSessionId: "sess_null" });
    await storage.sessions.insertSession( "team_local",makeRecord("sess_null", null), null, null, {
      factStore: storage.facts,
      facts: [fact],
    });

    const sess = (await pool.query("SELECT scope FROM sessions WHERE id = 'sess_null'")).rows[0];
    expect(sess.scope).toBeNull();
    const factRow = (await pool.query("SELECT scope FROM facts WHERE id = 'f_null'")).rows[0];
    expect(factRow.scope).toBeNull();
  });

  it("getSessionScopeById reads back the stored scope", async () => {
    await storage.sessions.insertSession("team_local", makeRecord("sess_read", "client-b"));
    expect(await storage.sessions.getSessionScopeById("team_local", "sess_read")).toBe("client-b");
    expect(await storage.sessions.getSessionScopeById("team_local", "sess_missing")).toBeNull();
  });

  it("re-ingest with a non-null scope updates the stored scope", async () => {
    await storage.sessions.insertSession("team_local", makeRecord("sess_upd", null));
    await storage.sessions.insertSession("team_local", makeRecord("sess_upd", "client-a"));
    const sess = (await pool.query("SELECT scope FROM sessions WHERE id = 'sess_upd'")).rows[0];
    expect(sess.scope).toBe("client-a");
  });

  it("re-ingest with null scope does not overwrite a previously stamped non-null scope (Fix A)", async () => {
    await storage.sessions.insertSession("team_local", makeRecord("sess_guard", "client-a"));
    await storage.sessions.insertSession("team_local", makeRecord("sess_guard", null));
    const sess = (await pool.query("SELECT scope FROM sessions WHERE id = 'sess_guard'")).rows[0];
    expect(sess.scope).toBe("client-a");
  });

  it("workstream create stores scope (pg)", async () => {
    const ws = await storage.workstreams.create({ id: "ws_pg_scope", label: "project-alpha", scope: "client-a" });
    expect(ws.scope).toBe("client-a");
    const row = (await pool.query("SELECT scope FROM workstreams WHERE id = 'ws_pg_scope'")).rows[0];
    expect(row.scope).toBe("client-a");

    const wsNull = await storage.workstreams.create({ id: "ws_pg_null", label: "project-beta", scope: null });
    expect(wsNull.scope).toBeNull();
  });

  it("signal insert stores scope (pg)", async () => {
    const { makeSignal } = await import("../fixtures/signals.js");
    await storage.signals.insert(makeSignal({ id: "sig_pg_scope", scope: "client-a" }));
    const row = (await pool.query("SELECT scope FROM signals WHERE id = 'sig_pg_scope'")).rows[0];
    expect(row.scope).toBe("client-a");

    await storage.signals.insert(makeSignal({ id: "sig_pg_null", scope: null }));
    const nullRow = (await pool.query("SELECT scope FROM signals WHERE id = 'sig_pg_null'")).rows[0];
    expect(nullRow.scope).toBeNull();
  });

  it("exemplar insert stores scope (pg)", async () => {
    await storage.exemplars.insert({
      installScope: "install-test",
      signalId: null,
      sessionId: null,
      repo: "proj",
      model: "m",
      lang: "ts",
      taskContext: "ctx",
      code: "const a = 1;\nconst b = 2;\nconst c = a + b;",
      codeHash: "hash-pg-scope",
      outcome: "pass",
      gitSha: null,
      survived: null,
      scope: "client-a",
      ts: "2026-06-01T10:00:00.000Z",
    });
    const row = (await pool.query("SELECT scope FROM code_exemplars")).rows[0];
    expect(row.scope).toBe("client-a");
  });
});
