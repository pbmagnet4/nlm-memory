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
      .prepare("SELECT session_id, failure_count, last_offset FROM adapter_state WHERE source_path = ?")
      .get(srcPath) as { session_id: string; failure_count: number; last_offset: number };
    expect(row.session_id).toBe("cc_big1");
    expect(row.failure_count).toBe(0);
    expect(row.last_offset).toBe(120000);
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

  it("classifier throw on first chunk does not abort batch — second chunk still ingests", async () => {
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS });
    const db = storage.rawDb();

    const srcPath2 = join(dir, "big2.jsonl");
    writeFileSync(srcPath2, "x".repeat(120_000));

    // Two failure rows — ordered by file_size DESC; both are 120000 so insertion order wins
    db.prepare(
      `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
       VALUES ('claude-code', ?, 0, 120000, NULL, 2)`,
    ).run(srcPath);
    db.prepare(
      `INSERT INTO adapter_state (adapter_name, source_path, last_offset, file_size, session_id, failure_count)
       VALUES ('claude-code', ?, 0, 120000, NULL, 2)`,
    ).run(srcPath2);

    const FAIL_MARKER = "FAIL_ME";

    const chunkFor = (id: string, path: string, text: string): SessionChunk => ({
      id,
      runtime: "claude-code",
      runtimeSessionId: id,
      sourcePath: path,
      startedAt: "2026-04-14T00:00:00.000Z",
      endedAt: "2026-04-14T01:00:00.000Z",
      durationMin: 60,
      turnCount: 10,
      byteRange: [0, 120000],
      projectDir: "/p",
      gitBranch: "main",
      text,
      label: "raw",
    });

    // Adapter returns distinct chunk per path
    const adapter: TranscriptAdapter = {
      name: "claude-code",
      runtimeVersion: "test",
      transcriptKind: "claude-code-jsonl",
      detect: () => ({ adapterName: "claude-code", enabled: true, path: null, hint: null }),
      discover: async () => [],
      parseSession: async (p: string) =>
        p === srcPath
          ? chunkFor("cc_iso1", srcPath, FAIL_MARKER + "x".repeat(120_000 - FAIL_MARKER.length))
          : chunkFor("cc_iso2", srcPath2, "y".repeat(120_000)),
    } as unknown as TranscriptAdapter;

    const successResult: ClassifyResult = {
      label: "Isolated",
      summary: "s",
      entities: [],
      decisions: [],
      open: [],
      confidence: 0.9,
      facts: [],
    };

    // Classifier throws on the first chunk (text starts with FAIL_MARKER), succeeds on all other chunks.
    // With per-chunk tolerance (Task 2), cc_iso1's surviving chunks (2 of 3) produce a result — so
    // both sessions ingest. Neither batch entry counts as failed.
    const throwingClassifier: LLMClient = {
      classify: async (text: string) => {
        if (text.startsWith(FAIL_MARKER)) throw new Error("simulated classify timeout");
        return successResult;
      },
      embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as LLMClient;

    const out = await reclassifyOversized(
      {
        db,
        store: storage.sessions,
        factStore: storage.facts,
        embedder: fakeClassifier(successResult),
        classifier: throwingClassifier,
        adapters: [adapter],
      },
      {},
    );

    // Per-chunk tolerance: one bad chunk in cc_iso1 doesn't sink the session — surviving
    // chunks produce a valid ClassifyResult, so both sessions are ingested.
    expect(out.failed).toBe(0);
    expect(out.ingested).toBe(2);

    const first = await storage.sessions.getById("cc_iso1");
    expect(first).not.toBeNull();
    expect(first!.label).toBe("Isolated");

    const second = await storage.sessions.getById("cc_iso2");
    expect(second).not.toBeNull();
    expect(second!.label).toBe("Isolated");
  });
});
