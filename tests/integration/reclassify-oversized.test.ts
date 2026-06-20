/**
 * Integration test for reclassifyOversized: seeds a real in-memory SQLite
 * store with adapter_state rows that failed ingest, runs recovery, and
 * verifies sessions land + adapter_state is cleared.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { reclassifyOversized } from "../../src/core/ingest/reclassify-oversized.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { SessionChunk, TranscriptAdapter } from "../../src/ports/transcript-adapter.js";

const MIGRATIONS = resolve(process.cwd(), "migrations");

function fakeClassifier(result: ClassifyResult): LLMClient {
  return {
    classify: async () => result,
    embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
    rewriteForRecall: async () => { throw new Error("nope"); },
  } as LLMClient;
}

function fakeAdapter(chunk: SessionChunk): TranscriptAdapter {
  return {
    name: "claude-code",
    runtimeVersion: "test",
    transcriptKind: "claude-code-jsonl",
    detect: () => ({ adapterName: "claude-code", enabled: true, path: null, hint: null }),
    discover: async () => [],
    parseSession: async () => chunk,
  } as unknown as TranscriptAdapter;
}

describe("reclassifyOversized", () => {
  let dir: string, dbPath: string, srcPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-reclass-"));
    dbPath = join(dir, "t.sqlite");
    srcPath = join(dir, "big.jsonl");
    writeFileSync(srcPath, "x".repeat(120_000));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("re-parses a failed transcript, ingests it, and clears the failure row", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();

    db.prepare(
      `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
       VALUES ('claude-code', ?, 0, 120000, NULL, 3)`,
    ).run(srcPath);

    const chunk: SessionChunk = {
      id: "cc_big1",
      runtime: "claude-code",
      runtimeSessionId: "rs1",
      sourcePath: srcPath,
      startedAt: "2026-04-14T00:00:00.000Z",
      endedAt: "2026-04-14T01:00:00.000Z",
      durationMin: 60,
      turnCount: 10,
      byteRange: [0, 120000],
      projectDir: "/p",
      gitBranch: "main",
      text: "y".repeat(120_000),
      label: "raw",
    };

    const result: ClassifyResult = {
      label: "Big session",
      summary: "s",
      entities: ["DuckDB"],
      decisions: ["use wal"],
      open: [],
      confidence: 0.9,
      facts: [],
    };

    const out = await reclassifyOversized(
      {
        db,
        store: storage.sessions,
        factStore: storage.facts,
        embedder: fakeClassifier(result),
        classifier: fakeClassifier(result),
        adapters: [fakeAdapter(chunk)],
      },
      {},
    );

    expect(out.ingested).toBe(1);

    const sess = await storage.sessions.getById("cc_big1");
    expect(sess).not.toBeNull();
    expect(sess!.label).toBe("Big session");

    const ents = db
      .prepare("SELECT COUNT(*) AS n FROM session_entities WHERE session_id = ?")
      .get("cc_big1") as { n: number };
    expect(ents.n).toBe(1);

    const row = db
      .prepare("SELECT session_id, failure_count FROM adapter_state WHERE source_path = ?")
      .get(srcPath) as { session_id: string; failure_count: number };
    expect(row.session_id).toBe("cc_big1");
    expect(row.failure_count).toBe(0);
  });

  it("dry-run reports the candidate but writes nothing", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();

    db.prepare(
      `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
       VALUES ('claude-code', ?, 0, 120000, NULL, 3)`,
    ).run(srcPath);

    const chunk: SessionChunk = {
      id: "cc_x",
      runtime: "claude-code",
      runtimeSessionId: "r",
      sourcePath: srcPath,
      startedAt: "2026-04-14T00:00:00.000Z",
      endedAt: "2026-04-14T00:00:00.000Z",
      durationMin: 1,
      turnCount: 1,
      byteRange: [0, 1],
      projectDir: "/p",
      gitBranch: "m",
      text: "z".repeat(120_000),
      label: "r",
    };

    const result: ClassifyResult = {
      label: "x",
      summary: "s",
      entities: [],
      decisions: [],
      open: [],
      confidence: 0.9,
      facts: [],
    };

    const out = await reclassifyOversized(
      {
        db,
        store: storage.sessions,
        factStore: storage.facts,
        embedder: fakeClassifier(result),
        classifier: fakeClassifier(result),
        adapters: [fakeAdapter(chunk)],
      },
      { dryRun: true },
    );

    expect(out.attempted).toBe(1);
    expect(out.ingested).toBe(0);
    expect(await storage.sessions.getById("cc_x")).toBeNull();
  });

  it("skips ingest but resets failure_count when confidence is below floor", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();

    db.prepare(
      `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
       VALUES ('claude-code', ?, 0, 120000, NULL, 2)`,
    ).run(srcPath);

    const chunk: SessionChunk = {
      id: "cc_low",
      runtime: "claude-code",
      runtimeSessionId: "r2",
      sourcePath: srcPath,
      startedAt: "2026-04-14T00:00:00.000Z",
      endedAt: "2026-04-14T00:00:00.000Z",
      durationMin: 1,
      turnCount: 1,
      byteRange: [0, 1],
      projectDir: "/p",
      gitBranch: "m",
      text: "a".repeat(120_000),
      label: "r",
    };

    const result: ClassifyResult = {
      label: "Low confidence",
      summary: "s",
      entities: [],
      decisions: [],
      open: [],
      confidence: 0.1,
      facts: [],
    };

    const out = await reclassifyOversized(
      {
        db,
        store: storage.sessions,
        factStore: storage.facts,
        embedder: fakeClassifier(result),
        classifier: fakeClassifier(result),
        adapters: [fakeAdapter(chunk)],
      },
      {},
    );

    expect(out.skippedLowConfidence).toBe(1);
    expect(out.ingested).toBe(0);
    expect(await storage.sessions.getById("cc_low")).toBeNull();

    const row = db
      .prepare("SELECT failure_count FROM adapter_state WHERE source_path = ?")
      .get(srcPath) as { failure_count: number };
    expect(row.failure_count).toBe(0);
  });
});
