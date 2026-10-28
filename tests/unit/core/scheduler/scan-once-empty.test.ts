import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionChunk, TranscriptAdapter } from "../../../../src/ports/transcript-adapter.js";
import { classifyOutcomesSnapshot, resetClassifyOutcomes } from "../../../../src/core/health/classify-outcomes.js";
import { scanOnce } from "../../../../src/core/scheduler/scan-once.js";

let dir: string;
let db: Database.Database;
let path: string;
let parseCalls: number;
let parse: (p: string) => SessionChunk | null;

const adapter = {
  name: "pi",
  discover: async () => [path],
  parseSession: async (p: string) => {
    parseCalls += 1;
    return parse(p);
  },
} as unknown as TranscriptAdapter;

const chunk = { id: "s1", sourcePath: "" } as SessionChunk;

function write(content: string): void {
  writeFileSync(path, content);
  const old = (Date.now() - 3_600_000) / 1000;
  utimesSync(path, old, old);
}

const rows = () =>
  db.prepare("SELECT file_size, session_id, failure_count FROM adapter_state WHERE source_path = ?").all(path);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nlm-scan-"));
  path = join(dir, "t.jsonl");
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE adapter_state (adapter_name TEXT, source_path TEXT, last_offset INTEGER, file_size INTEGER, session_id TEXT, failure_count INTEGER, last_processed_at TEXT, PRIMARY KEY (adapter_name, source_path))",
  );
  parseCalls = 0;
  resetClassifyOutcomes();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scanOnce with a transcript that parses to null", () => {
  it("records an empty transcript by size, skips it until it grows, then rescans it", async () => {
    write("meta");
    parse = () => null;
    expect(await scanOnce(adapter, 15, db)).toEqual([]);
    expect(rows()).toEqual([{ file_size: 4, session_id: null, failure_count: 0 }]);
    expect(classifyOutcomesSnapshot().lastProgressAt).not.toBeNull();

    await scanOnce(adapter, 15, db);
    expect(parseCalls).toBe(1);

    write("meta plus a real turn");
    parse = () => chunk;
    expect(await scanOnce(adapter, 15, db)).toHaveLength(1);
    expect(parseCalls).toBe(2);
  });

  it("does not record a source it could not read, so it is retried", async () => {
    write("x");
    parse = () => {
      rmSync(path);
      return null;
    };
    await scanOnce(adapter, 15, db);
    expect(rows()).toEqual([]);
    expect(classifyOutcomesSnapshot().lastProgressAt).toBeNull();
  });
});
