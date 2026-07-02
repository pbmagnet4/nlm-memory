import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeFact } from "../fixtures/facts.js";
import { runChecksOnSqlite } from "../../src/core/integrity/check-invariants.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: "sess_test",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "L",
    summary: "S",
    body: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    ...overrides,
  };
}

describe("session markSuperseded cascade -- embedding cleanup (sqlite)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let sessions: SqliteSessionStore;
  let factStore: SqliteFactStore;

  function embeddingExists(factId: string): boolean {
    const r = storage
      .rawDb()
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = ?",
      )
      .get(factId);
    return (r?.c ?? 0) > 0;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-t4-sqlite-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    sessions = storage.sessions;
    factStore = storage.facts;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("session markSuperseded cascade deletes embeddings of newly superseded facts", async () => {
    // Session A: fact (svc, framework) = Express, embedded.
    const fA = makeFact({
      id: "f_a",
      subject: "svc",
      predicate: "framework",
      value: "Express",
      sourceSessionId: "sess_a",
    });
    await sessions.insertSession(makeRecord({ id: "sess_a" }), null, null, {
      factStore,
      facts: [fA],
    });
    await factStore.upsertEmbedding("f_a", new Float32Array(768).fill(0.1));
    expect(embeddingExists("f_a")).toBe(true);

    // Session B: fact (svc, framework) = Hono, active.
    // Insert the session row via insertSession (not insertSessionForTest), then
    // insert the fact directly to avoid triggering ingest-time supersedence so
    // f_a still has its embedding when markSuperseded is called.
    await sessions.insertSession(makeRecord({ id: "sess_b" }));
    const fB = makeFact({
      id: "f_b",
      subject: "svc",
      predicate: "framework",
      value: "Hono",
      sourceSessionId: "sess_b",
    });
    await factStore.insert(fB);

    // f_a must still be active and embedded at this point.
    expect((await factStore.getById("f_a"))?.supersededBy).toBeNull();
    expect(embeddingExists("f_a")).toBe(true);

    await sessions.markSuperseded("sess_a", "sess_b");

    expect((await factStore.getById("f_a"))?.supersededBy).toBe("f_b");
    expect(embeddingExists("f_a")).toBe(false);
  });

  it("predecessor fact with no matching successor keeps its embedding and stays active", async () => {
    // Session A: fact (svc, framework) = Express, embedded.
    const fA = makeFact({
      id: "f_a",
      subject: "svc",
      predicate: "framework",
      value: "Express",
      sourceSessionId: "sess_a",
    });
    await sessions.insertSession(makeRecord({ id: "sess_a" }), null, null, {
      factStore,
      facts: [fA],
    });
    await factStore.upsertEmbedding("f_a", new Float32Array(768).fill(0.1));

    // Session B: fact with a DIFFERENT predicate -- no (svc, framework) match.
    await sessions.insertSession(makeRecord({ id: "sess_b" }));
    const fB = makeFact({
      id: "f_b",
      subject: "svc",
      predicate: "endpoint",
      value: ":3940",
      sourceSessionId: "sess_b",
    });
    await factStore.insert(fB);

    await sessions.markSuperseded("sess_a", "sess_b");

    // f_a has no matching successor so it must remain active with its embedding.
    expect((await factStore.getById("f_a"))?.supersededBy).toBeNull();
    expect(embeddingExists("f_a")).toBe(true);
  });

  it("intra-batch (subject,predicate) duplicate: loser gets no embedding, winner gets one, I7 clean", async () => {
    const fLoser = makeFact({
      id: "f_dup_loser",
      subject: "svc",
      predicate: "db",
      value: "Postgres",
      sourceSessionId: "sess_dup",
    });
    const fWinner = makeFact({
      id: "f_dup_winner",
      subject: "svc",
      predicate: "db",
      value: "SQLite",
      sourceSessionId: "sess_dup",
    });
    const embedder = new StubEmbedder();
    await sessions.insertSession(makeRecord({ id: "sess_dup" }), embedder, null, {
      factStore,
      facts: [fLoser, fWinner],
    });

    expect(embeddingExists("f_dup_winner")).toBe(true);
    expect(embeddingExists("f_dup_loser")).toBe(false);
    expect(runChecksOnSqlite(storage.rawDb()).find((v) => v.id === "I7")).toBeUndefined();
  });
});
