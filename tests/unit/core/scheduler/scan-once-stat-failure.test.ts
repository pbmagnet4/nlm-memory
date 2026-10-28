import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { scanOnce } from "../../../../src/core/scheduler/scan-once.js";
import type { SessionChunk, SourceStat, TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");
const OLD = Date.now() - 60 * 60 * 1000;

/** Sources whose name contains "busy" throw from stat, like a locked DB. */
class BusyStatAdapter implements TranscriptAdapter {
  readonly name = "busy-db";
  readonly runtimeVersion = "test";
  readonly transcriptKind = "claude-code";
  constructor(private readonly sources: string[]) {}
  detect() {
    return { adapterName: this.name, enabled: true, path: "", hint: null };
  }
  async discover(): Promise<string[]> {
    return this.sources;
  }
  stat(source: string): SourceStat {
    if (source.includes("busy")) throw new Error("database is locked");
    return { mtimeMs: OLD, size: 10 };
  }
  async parseSession(sourcePath: string): Promise<SessionChunk | null> {
    return {
      id: sourcePath, runtime: "claude-code", runtimeSessionId: sourcePath, sourcePath,
      startedAt: "2026-05-19T10:00:00Z", endedAt: "2026-05-19T10:30:00Z", durationMin: 30,
      turnCount: 1, byteRange: [0, 10] as const, projectDir: "p", gitBranch: "main", text: "body", label: "",
    };
  }
}

describe("scanOnce stat failures", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-stat-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "t.db"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    writeFileSync(join(tmp, "x"), "x");
    utimesSync(join(tmp, "x"), OLD / 1000, OLD / 1000);
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips the failing sources, scans the rest, logs once per tick, records no state", async () => {
    const db = storage.sessions.rawDb();
    const logs: string[] = [];
    const adapter = new BusyStatAdapter(["busy-1", "ok-1", "busy-2", "ok-2"]);
    const results = await scanOnce(adapter, 15, db, Date.now(), (m) => logs.push(m));
    expect(results.map((r) => r.chunk.sourcePath)).toEqual(["ok-1", "ok-2"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("busy-db");
    expect(logs[0]).toContain("2 source(s)");
    const rows = db.prepare("SELECT source_path FROM adapter_state WHERE adapter_name = ?").all("busy-db");
    expect(rows).toEqual([]);
  });
});
