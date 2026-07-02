/**
 * PG ingest end-to-end: PgSessionStore.insertSession factSink (atomic
 * session+facts+supersedence) and a full ScanScheduler tick over the PG
 * backend. Proves the daemon's live-ingest path works on PostgreSQL, not
 * just SQLite.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when
 * absent. Tables are truncated between tests.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import { getFileSize } from "../../src/core/scheduler/scan-once.js";
import type {
  DetectionResult,
  SessionChunk,
  TranscriptAdapter,
} from "../../src/ports/transcript-adapter.js";
import type { ClassifyResult, LLMClient } from "../../src/ports/llm-client.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";
import type { Fact } from "../../src/shared/types.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { ingestSession } from "../../src/core/ingest/ingest-session.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL =
  "TRUNCATE TABLE sessions, facts, fact_embeddings, adapter_state RESTART IDENTITY CASCADE";

function fact(over: Partial<Fact>): Fact {
  return {
    id: `fact_${Math.abs(hash(over.id ?? over.value ?? "x"))}`,
    kind: "decision",
    subject: "ProjectAtlas",
    predicate: "framework",
    value: "Hono",
    sourceSessionId: "sess_1",
    sourceQuote: null,
    createdAt: "2026-05-19T10:00:00Z",
    supersededBy: null,
    confidence: 0.9,
    ...over,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function record(over: Partial<IngestRecord> & { id: string }): IngestRecord {
  return {
    runtime: "claude-code",
    runtimeSessionId: over.id,
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
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
    ...over,
  };
}


describe.skipIf(!PG_TEST_URL)("PgSessionStore.insertSession factSink (PG)", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });
  beforeEach(async () => { await pool.query(TRUNCATE_SQL); });

  it("commits session + facts atomically", async () => {
    const f = fact({ id: "fact_a", value: "Hono", sourceSessionId: "sess_1" });
    await storage.sessions.insertSession(
      record({ id: "sess_1" }), null, null,
      { factStore: storage.facts, facts: [f] },
    );

    const session = await storage.sessions.getById("sess_1");
    expect(session?.id).toBe("sess_1");
    const current = await storage.facts.findCurrent("ProjectAtlas", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.id).toBe("fact_a");
  });

  it("wires a 'continues' edge to a prior session with the same entity-set", async () => {
    await storage.sessions.insertSession(
      record({ id: "cont_a", startedAt: "2026-05-19T10:00:00Z", entities: ["ProjectAtlas"] }),
    );
    await storage.sessions.insertSession(
      record({ id: "cont_b", startedAt: "2026-05-20T10:00:00Z", entities: ["ProjectAtlas"] }),
    );

    const edges = await pool.query<{ from_session: string; to_session: string; kind: string }>(
      "SELECT from_session, to_session, kind FROM session_edges WHERE kind = 'continues'",
    );
    expect(edges.rows).toHaveLength(1);
    expect(edges.rows[0]!.from_session).toBe("cont_b");
    expect(edges.rows[0]!.to_session).toBe("cont_a");
  });

  it("does not wire a 'continues' edge when entity-sets differ", async () => {
    await storage.sessions.insertSession(
      record({ id: "diff_a", startedAt: "2026-05-19T10:00:00Z", entities: ["ProjectAtlas"] }),
    );
    await storage.sessions.insertSession(
      record({ id: "diff_b", startedAt: "2026-05-20T10:00:00Z", entities: ["OtherTopic"] }),
    );

    const edges = await pool.query<{ c: string }>(
      "SELECT COUNT(*) AS c FROM session_edges WHERE kind = 'continues'",
    );
    expect(Number(edges.rows[0]!.c)).toBe(0);
  });

  it("re-ingest with a new value supersedes the prior fact", async () => {
    await storage.sessions.insertSession(
      record({ id: "sess_1" }), null, null,
      { factStore: storage.facts, facts: [fact({ id: "fact_a", value: "Express", sourceSessionId: "sess_1" })] },
    );
    await storage.sessions.insertSession(
      record({ id: "sess_2" }), null, null,
      { factStore: storage.facts, facts: [fact({ id: "fact_b", value: "Hono", sourceSessionId: "sess_2" })] },
    );

    const current = await storage.facts.findCurrent("ProjectAtlas", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.id).toBe("fact_b");
    const prior = await storage.facts.getById("fact_a");
    expect(prior?.supersededBy).toBe("fact_b");
  });

  it("factSink intra-batch duplicate (subject,predicate) does not create a mutual supersedence cycle", async () => {
    const fa = fact({ id: "dup_a", value: "Express", sourceSessionId: "dup_sess" });
    const fb = fact({ id: "dup_b", value: "Hono", sourceSessionId: "dup_sess" });
    await storage.sessions.insertSession(
      record({ id: "dup_sess" }), null, null,
      { factStore: storage.facts, facts: [fa, fb] },
    );
    const rows = (await pool.query<{ id: string; superseded_by: string | null }>(
      "SELECT id, superseded_by FROM facts WHERE subject = 'ProjectAtlas' ORDER BY id",
    )).rows;
    // dup_a superseded by dup_b (last wins); dup_b active. No mutual cycle.
    expect(rows).toEqual([
      { id: "dup_a", superseded_by: "dup_b" },
      { id: "dup_b", superseded_by: null },
    ]);
  });
});

class FixtureAdapter implements TranscriptAdapter {
  readonly name = "claude-code";
  readonly runtimeVersion = "test";
  readonly transcriptKind = "claude-code";
  constructor(private readonly path: string, private readonly chunkId: string) {}
  detect(): DetectionResult {
    return { adapterName: this.name, enabled: true, path: this.path, hint: null };
  }
  async discover(): Promise<string[]> { return [this.path]; }
  async parseSession(sourcePath: string): Promise<SessionChunk | null> {
    return {
      id: this.chunkId,
      runtime: "claude-code",
      runtimeSessionId: this.chunkId,
      sourcePath,
      startedAt: "2026-05-19T10:00:00Z",
      endedAt: "2026-05-19T10:30:00Z",
      durationMin: 30,
      turnCount: 1,
      byteRange: [0, getFileSize(sourcePath) ?? 0] as const,
      projectDir: "project_a",
      gitBranch: "main",
      text: "session body text",
      label: "",
    };
  }
}

class FactClassifier implements LLMClient {
  async embed(): Promise<never> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<ClassifyResult> {
    return {
      label: "Stub label",
      summary: "Stub summary",
      entities: ["ProjectAtlas"],
      decisions: ["chose Hono"],
      open: [],
      confidence: 0.9,
      facts: [{ kind: "decision", subject: "ProjectAtlas", predicate: "framework", value: "Hono" }],
    };
  }
}

describe.skipIf(!PG_TEST_URL)("ScanScheduler tick over PG", () => {
  let storage: PgStorage;
  let pool: Pool;
  let tmp: string;
  let fixturePath: string;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    tmp = mkdtempSync(join(tmpdir(), "nlm-pgtick-"));
    fixturePath = join(tmp, "fixture.jsonl");
    writeFileSync(fixturePath, "line one\nline two\n");
    const old = (Date.now() - 60 * 60 * 1000) / 1000; // age past idle threshold
    utimesSync(fixturePath, old, old);
  });

  it("ingests a session + its facts into PG, records adapter_state", async () => {
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [new FixtureAdapter(fixturePath, "sess_tick_1")],
      classifier: new FactClassifier(),
      embedder: new StubEmbedder(),
      factStore: storage.facts,
      idleMinutes: 15,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const session = await storage.sessions.getById("sess_tick_1");
    expect(session?.label).toBe("Stub label");
    const current = await storage.facts.findCurrent("ProjectAtlas", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.sourceSessionId).toBe("sess_tick_1");

    // adapter_state advanced via recordClassifiedPg (proves the PG branch ran).
    const state = await pool.query<{ session_id: string | null }>(
      "SELECT session_id FROM adapter_state WHERE source_path = $1", [fixturePath],
    );
    expect(state.rows[0]?.session_id).toBe("sess_tick_1");
  });
});

// Drives the webhook push path — ingestSession() — over PG. Proves the
// `deps.store instanceof PgSessionStore` branch in ingest-session.ts runs at
// runtime and atomically persists session + facts (NLM #324).
describe.skipIf(!PG_TEST_URL)("ingestSession webhook path over PG", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });
  beforeEach(async () => { await pool.query(TRUNCATE_SQL); });

  it("classifies, persists session + facts through the PgSessionStore branch", async () => {
    const result = await ingestSession(
      {
        id: "webhook_pg_1",
        runtime: "webhook",
        text: "session body text",
        startedAt: "2026-05-19T10:00:00Z",
        sourceId: 1,
      },
      {
        classifier: new FactClassifier(),
        embedder: new StubEmbedder(),
        store: storage.sessions,
        factStore: storage.facts,
        log: () => {},
      },
    );

    expect(result.status).toBe("ingested");
    expect(result.id).toBe("webhook_pg_1");

    const session = await storage.sessions.getById("webhook_pg_1");
    expect(session?.label).toBe("Stub label");
    expect(session?.transcriptKind).toBe("webhook");
    const current = await storage.facts.findCurrent("ProjectAtlas", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.sourceSessionId).toBe("webhook_pg_1");
  });

  it("short-circuits below the confidence floor without persisting", async () => {
    class LowConfidence implements LLMClient {
      async embed(): Promise<never> { throw new Error("not used"); }
      async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
      nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
      async classify(): Promise<ClassifyResult> {
        return { label: "x", summary: "x", entities: [], decisions: [], open: [], confidence: 0.1, facts: [] };
      }
    }

    const result = await ingestSession(
      { id: "webhook_pg_low", runtime: "webhook", text: "noise", startedAt: "2026-05-19T10:00:00Z" },
      { classifier: new LowConfidence(), embedder: new StubEmbedder(), store: storage.sessions, factStore: storage.facts, log: () => {} },
    );

    expect(result.status).toBe("low_confidence");
    expect(await storage.sessions.getById("webhook_pg_low")).toBeNull();
  });
});
