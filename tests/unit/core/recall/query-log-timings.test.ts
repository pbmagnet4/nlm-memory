// T1770: timings_ms on the query log — write, parse back, and old lines
// (written before the field existed) must parse exactly as before.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logQuery, readQueryLog, type LogEntry } from "../../../../src/core/recall/query-log.js";

const base: LogEntry = {
  source: "hook",
  runtime: "claude-code",
  query: "pgvector cutover",
  entity: null,
  kind: null,
  mode: "hybrid",
  limit: 20,
  nResults: 1,
  returnedIds: ["s1"],
};

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-qlog-"));
  logPath = join(tmp, "query_log.jsonl");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("query log timings_ms round trip", () => {
  it("writes timings_ms and reads them back as timingsMs", async () => {
    const timingsMs = { keyword: 4, embed: 310, semantic: 55, total: 381 };
    await logQuery("team_local", { ...base, timingsMs }, logPath);
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.timings_ms).toEqual(timingsMs);
    const row = (await readQueryLog("team_local", 7, logPath))[0]!;
    expect(row.entry.timingsMs).toEqual(timingsMs);
  });

  it("absent timings write no timings_ms key and parse as before", async () => {
    await logQuery("team_local", base, logPath);
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect("timings_ms" in line).toBe(false);
    const row = (await readQueryLog("team_local", 7, logPath))[0]!;
    expect(row.entry.timingsMs).toBeUndefined();
    expect(row.entry.source).toBe("hook");
    expect(row.entry.mode).toBe("hybrid");
    expect(row.entry.returnedIds).toEqual(["s1"]);
  });

  it("a pre-T1770 line (no timings_ms) parses unchanged next to a new one", async () => {
    const legacy = {
      ts: new Date().toISOString(),
      source: "hook",
      runtime: null,
      query: "old query",
      entity: null,
      kind: null,
      mode: "keyword",
      limit: 5,
      n_results: 2,
      returned_ids: ["x", "y"],
      intent: "session",
    };
    writeFileSync(logPath, JSON.stringify(legacy) + "\n", "utf8");
    await logQuery("team_local", { ...base, timingsMs: { total: 12 } }, logPath);
    const rows = await readQueryLog("team_local", 7, logPath);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.entry.query === "old query")!;
    expect(old.entry.timingsMs).toBeUndefined();
    expect(old.entry.nResults).toBe(2);
    const fresh = rows.find((r) => r.entry.query === "pgvector cutover")!;
    expect(fresh.entry.timingsMs).toEqual({ total: 12 });
  });

  it("garbage timings_ms values are dropped; a fully-invalid object reads as absent", async () => {
    const mk = (timings: unknown) => JSON.stringify({
      ts: new Date().toISOString(),
      source: "hook",
      query: "q",
      timings_ms: timings,
    });
    writeFileSync(
      logPath,
      [mk({ keyword: 4, embed: "fast", bad: -1, ok: 7 }), mk([1, 2]), mk("nope")].join("\n") + "\n",
      "utf8",
    );
    const rows = await readQueryLog("team_local", 7, logPath);
    expect(rows[0]!.entry.timingsMs).toEqual({ keyword: 4, ok: 7 });
    expect(rows[1]!.entry.timingsMs).toBeUndefined();
    expect(rows[2]!.entry.timingsMs).toBeUndefined();
  });
});
