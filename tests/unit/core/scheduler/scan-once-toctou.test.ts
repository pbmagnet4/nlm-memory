import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { scanOnce, recordClassified } from "../../../../src/core/scheduler/scan-once.js";
import type {
  DetectionResult,
  SessionChunk,
  TranscriptAdapter,
} from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

class FixtureAdapter implements TranscriptAdapter {
  readonly name = "claude-code";
  readonly runtimeVersion = "test";
  readonly transcriptKind = "claude-code";
  constructor(
    private readonly path: string,
    private readonly chunkId: string,
  ) {}
  detect(): DetectionResult {
    return { adapterName: this.name, enabled: true, path: this.path, hint: null };
  }
  async discover(): Promise<string[]> {
    return [this.path];
  }
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
      byteRange: [0, 10] as const,
      projectDir: "project_a",
      gitBranch: "main",
      text: "stub body",
      label: "",
    };
  }
}

function backdateMtime(path: string): void {
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(path, old, old);
}

describe("scan-once TOCTOU: parse-time file size threading (sqlite)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let db: Database.Database;
  let fixturePath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-toctou-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "t.db"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    db = storage.sessions.rawDb();
    fixturePath = join(tmp, "fixture.jsonl");
    writeFileSync(fixturePath, "line one\n");
    backdateMtime(fixturePath);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ScanResult carries the parse-time file size", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    const results = await scanOnce(adapter, 15, db);
    expect(results).toHaveLength(1);
    const parseSize = statSync(fixturePath).size;
    expect(results[0]!.fileSize).toBe(parseSize);
  });

  it("records parse-time size, not commit-time size, so appended bytes are re-scanned next tick", async () => {
    const adapter = new FixtureAdapter(fixturePath, "sess_1");
    const results = await scanOnce(adapter, 15, db);
    expect(results).toHaveLength(1);
    const parseSize = results[0]!.fileSize;

    appendFileSync(fixturePath, "line two\n");
    const grownSize = statSync(fixturePath).size;
    expect(grownSize).toBeGreaterThan(parseSize);

    recordClassified(db, adapter.name, fixturePath, "sess_1", parseSize);

    const row = db
      .prepare<[string, string], { file_size: number }>(
        "SELECT file_size FROM adapter_state WHERE adapter_name = ? AND source_path = ?",
      )
      .get(adapter.name, fixturePath);
    expect(row?.file_size).toBe(parseSize);
    expect(row?.file_size).not.toBe(grownSize);

    backdateMtime(fixturePath);
    const next = await scanOnce(adapter, 15, db);
    expect(next).toHaveLength(1);
  });
});
