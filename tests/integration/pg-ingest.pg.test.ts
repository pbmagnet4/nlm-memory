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
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Fact } from "../../src/shared/types.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";

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
    subject: "PolySignal",
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

class StubEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "stub" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async classify(): Promise<never> { throw new Error("not used"); }
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
    const current = await storage.facts.findCurrent("PolySignal", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.id).toBe("fact_a");
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

    const current = await storage.facts.findCurrent("PolySignal", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.id).toBe("fact_b");
    const prior = await storage.facts.getById("fact_a");
    expect(prior?.supersededBy).toBe("fact_b");
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
  async classify(): Promise<ClassifyResult> {
    return {
      label: "Stub label",
      summary: "Stub summary",
      entities: ["PolySignal"],
      decisions: ["chose Hono"],
      open: [],
      confidence: 0.9,
      facts: [{ kind: "decision", subject: "PolySignal", predicate: "framework", value: "Hono" }],
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
    const current = await storage.facts.findCurrent("PolySignal", "framework");
    expect(current?.value).toBe("Hono");
    expect(current?.sourceSessionId).toBe("sess_tick_1");

    // adapter_state advanced via recordClassifiedPg (proves the PG branch ran).
    const state = await pool.query<{ session_id: string | null }>(
      "SELECT session_id FROM adapter_state WHERE source_path = $1", [fixturePath],
    );
    expect(state.rows[0]?.session_id).toBe("sess_tick_1");
  });
});
