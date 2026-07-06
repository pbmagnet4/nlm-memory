/**
 * Integration: `nlm scope coverage` reports per-table and recall-weighted scope fractions.
 *
 * All fixtures are synthetic (temp dirs, no ~/.nlm access).
 * Never touches the live canonical DB.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runScopeCoverage, formatCoverageResult } from "../../src/cli/scope-coverage.js";
import type { CoverageResult } from "../../src/cli/scope-coverage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("scope-coverage", () => {
  let tmpDir: string;
  let dbFilePath: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nlm-cov-"));
    dbFilePath = join(tmpDir, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath: dbFilePath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function db() {
    return storage.sessions.rawDb();
  }

  function insertSession(id: string, scope: string | null): void {
    db()
      .prepare(
        `INSERT INTO sessions (id, runtime, started_at, label, summary, status, scope)
         VALUES (?, 'test', '2026-01-01T10:00:00Z', 'L', 'S', 'active', ?)`,
      )
      .run(id, scope);
  }

  function insertFact(id: string, sessionId: string, scope: string | null): void {
    db()
      .prepare(
        `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, scope)
         VALUES (?, 'decision', 'subj', 'pred', 'val', ?, 0.9, ?)`,
      )
      .run(id, sessionId, scope);
  }

  function insertExemplar(id: string, scope: string | null): void {
    db()
      .prepare(
        `INSERT INTO code_exemplars (id, install_scope, session_id, repo, model, task_context, code, code_hash, outcome, ts, scope)
         VALUES (?, 'inst', NULL, 'repo-a', 'm', 'ctx', 'code', ?, 'pass', '2026-01-01T10:00:00Z', ?)`,
      )
      .run(id, `hash-${id}`, scope);
  }

  function insertSignal(id: string, scope: string | null): void {
    db()
      .prepare(
        `INSERT INTO signals (id, v, install_scope, kind, producer, outcome, model, repo, ts, session_id, scope, created_at)
         VALUES (?, 1, 'inst', 'gate', 'prod', 'pass', 'm', 'repo-a', '2026-01-01T10:00:00Z', NULL, ?, datetime('now'))`,
      )
      .run(id, scope);
  }

  function insertWorkstream(id: string, scope: string | null): void {
    db()
      .prepare("INSERT INTO workstreams (id, label, scope) VALUES (?, 'WS', ?)")
      .run(id, scope);
  }

  it("reports per-table totals, scoped counts, fractions, and by-scope breakdown", async () => {
    // sessions: 2 scope-a, 1 scope-b, 1 global, 1 null
    insertSession("s-a1", "/abs/client-a");
    insertSession("s-a2", "/abs/client-a");
    insertSession("s-b1", "/abs/client-b");
    insertSession("s-g1", "global");
    insertSession("s-n1", null);

    // facts: 1 scoped, 1 null
    insertFact("f-a1", "s-a1", "/abs/client-a");
    insertFact("f-n1", "s-n1", null);

    // code_exemplars: 2 scope-a, 1 null
    insertExemplar("e-a1", "/abs/client-a");
    insertExemplar("e-a2", "/abs/client-a");
    insertExemplar("e-n1", null);

    // signals: 1 scope-b, 1 null
    insertSignal("sig-b1", "/abs/client-b");
    insertSignal("sig-n1", null);

    // workstreams: 1 scope-a, 1 null
    insertWorkstream("ws-a1", "/abs/client-a");
    insertWorkstream("ws-n1", null);

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    // sessions
    expect(result.sessions.total).toBe(5);
    expect(result.sessions.stamped).toBe(4);
    expect(result.sessions.unstamped).toBe(1);
    expect(result.sessions.stamped_fraction).toBeCloseTo(4 / 5);
    expect(result.sessions.byScope["/abs/client-a"]).toBe(2);
    expect(result.sessions.byScope["/abs/client-b"]).toBe(1);
    expect(result.sessions.byScope["global"]).toBe(1);

    // facts
    expect(result.facts.total).toBe(2);
    expect(result.facts.stamped).toBe(1);
    expect(result.facts.unstamped).toBe(1);
    expect(result.facts.stamped_fraction).toBeCloseTo(0.5);

    // code_exemplars
    expect(result.code_exemplars.total).toBe(3);
    expect(result.code_exemplars.stamped).toBe(2);
    expect(result.code_exemplars.unstamped).toBe(1);
    expect(result.code_exemplars.byScope["/abs/client-a"]).toBe(2);

    // signals
    expect(result.signals.total).toBe(2);
    expect(result.signals.stamped).toBe(1);
    expect(result.signals.unstamped).toBe(1);
    expect(result.signals.byScope["/abs/client-b"]).toBe(1);

    // workstreams
    expect(result.workstreams.total).toBe(2);
    expect(result.workstreams.stamped).toBe(1);
    expect(result.workstreams.unstamped).toBe(1);
  });

  it("all-null corpus reports zero fractions with empty byScope", async () => {
    insertSession("s-null", null);
    insertFact("f-null", "s-null", null);

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    expect(result.sessions.stamped).toBe(0);
    expect(result.sessions.stamped_fraction).toBe(0);
    expect(Object.keys(result.sessions.byScope)).toHaveLength(0);
    expect(result.facts.stamped).toBe(0);
  });

  it("recall-weighted: counts distinct returned ids, found-in-db, and scoped fraction", async () => {
    insertSession("sess-a", "/abs/client-a");
    insertSession("sess-b", "/abs/client-b");
    insertSession("sess-null", null);
    // sess-missing intentionally absent from DB

    const logPath = join(tmpDir, "queries.jsonl");
    const lines = [
      {
        ts: "2026-06-01T10:00:00.000Z",
        source: "hook",
        runtime: null,
        query: "q1",
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        n_results: 2,
        returned_ids: ["sess-a", "sess-b"],
      },
      {
        ts: "2026-06-01T11:00:00.000Z",
        source: "hook",
        runtime: null,
        query: "q2",
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        n_results: 2,
        returned_ids: ["sess-null", "sess-missing"],
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    writeFileSync(logPath, lines);

    const result = await runScopeCoverage({ dbPath: dbFilePath, queryLogPath: logPath, window: 200 });

    expect(result.recallWeighted).not.toBeNull();
    const rw = result.recallWeighted!;
    expect(rw.distinctReturnedIds).toBe(4);
    expect(rw.foundInDb).toBe(3);
    expect(rw.scoped).toBe(2);
    expect(rw.fraction).toBeCloseTo(2 / 3);
    expect(result.queryLogNote).toBeNull();
  });

  it("recall-weighted: duplicate ids across log entries are deduplicated", async () => {
    insertSession("sess-dup", "/abs/client-a");

    const logPath = join(tmpDir, "queries.jsonl");
    const lines = [
      { ts: "2026-06-01T10:00:00.000Z", source: "hook", runtime: null, query: "q1", entity: null, kind: null, mode: "keyword", limit: 5, n_results: 1, returned_ids: ["sess-dup"] },
      { ts: "2026-06-01T11:00:00.000Z", source: "hook", runtime: null, query: "q2", entity: null, kind: null, mode: "keyword", limit: 5, n_results: 1, returned_ids: ["sess-dup"] },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    writeFileSync(logPath, lines);

    const result = await runScopeCoverage({ dbPath: dbFilePath, queryLogPath: logPath });

    expect(result.recallWeighted!.distinctReturnedIds).toBe(1);
    expect(result.recallWeighted!.foundInDb).toBe(1);
    expect(result.recallWeighted!.scoped).toBe(1);
    expect(result.recallWeighted!.fraction).toBeCloseTo(1);
  });

  it("recall-weighted: groups per surface by the log source field", async () => {
    insertSession("sess-hook", "/abs/client-a");
    insertSession("sess-mcp", null);

    const logPath = join(tmpDir, "queries.jsonl");
    const lines = [
      { ts: "2026-06-01T10:00:00.000Z", source: "hook", runtime: null, query: "q1", entity: null, kind: null, mode: "keyword", limit: 5, n_results: 1, returned_ids: ["sess-hook"] },
      { ts: "2026-06-01T11:00:00.000Z", source: "mcp", runtime: null, query: "q2", entity: null, kind: null, mode: "keyword", limit: 5, n_results: 1, returned_ids: ["sess-mcp"] },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    writeFileSync(logPath, lines);

    const result = await runScopeCoverage({ dbPath: dbFilePath, queryLogPath: logPath });

    const rw = result.recallWeighted!;
    expect(Object.keys(rw.bySurface).sort()).toEqual(["hook", "mcp"]);
    expect(rw.bySurface["hook"]).toEqual({ distinctReturnedIds: 1, foundInDb: 1, scoped: 1, fraction: 1 });
    expect(rw.bySurface["mcp"]).toEqual({ distinctReturnedIds: 1, foundInDb: 1, scoped: 0, fraction: 0 });
    expect(rw.fraction).toBeCloseTo(1 / 2);
  });

  it("recall-weighted: resolves fact and exemplar ids, not only session ids", async () => {
    insertSession("sess-src", "/abs/client-a");
    insertFact("fact-r", "sess-src", "/abs/client-a");
    insertExemplar("ex-r", null);

    const logPath = join(tmpDir, "queries.jsonl");
    const lines = [
      { ts: "2026-06-01T10:00:00.000Z", source: "mcp", runtime: null, query: "q1", entity: null, kind: null, mode: "keyword", limit: 5, n_results: 2, returned_ids: ["fact-r", "ex-r"] },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    writeFileSync(logPath, lines);

    const result = await runScopeCoverage({ dbPath: dbFilePath, queryLogPath: logPath });

    const rw = result.recallWeighted!;
    expect(rw.distinctReturnedIds).toBe(2);
    expect(rw.foundInDb).toBe(2);
    expect(rw.scoped).toBe(1);
    expect(rw.fraction).toBeCloseTo(1 / 2);
  });

  it("absent query log: succeeds with per-table output and a skipped note", async () => {
    insertSession("sess-x", "/abs/client-a");

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "nonexistent-queries.jsonl"),
    });

    expect(result.recallWeighted).toBeNull();
    expect(result.queryLogNote).toBeTruthy();
    expect(result.sessions.total).toBe(1);
    expect(result.sessions.stamped).toBe(1);
  });

  it("read-only guard: DB file bytes are identical before and after running coverage", async () => {
    insertSession("sess-guard", "/abs/client-a");

    const before = readFileSync(dbFilePath);

    await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    const after = readFileSync(dbFilePath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("--json shape: all five tables present with required numeric fields and byScope object", async () => {
    insertSession("sess-json", "/abs/client-a");
    insertFact("fact-json", "sess-json", "/abs/client-a");

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    const json = JSON.parse(JSON.stringify(result)) as CoverageResult;

    for (const key of ["sessions", "facts", "code_exemplars", "signals", "workstreams"] as const) {
      const t = json[key];
      expect(typeof t.total).toBe("number");
      expect(typeof t.stamped).toBe("number");
      expect(typeof t.unstamped).toBe("number");
      expect(typeof t.stamped_fraction).toBe("number");
      expect(typeof t.byScope).toBe("object");
      expect(t.total).toBe(t.stamped + t.unstamped);
    }

    expect(json.sessions.stamped).toBe(1);
    expect(json.sessions.byScope["/abs/client-a"]).toBe(1);
    expect(json.facts.stamped).toBe(1);
    expect(json.recallWeighted).toBeNull();
    expect(typeof json.queryLogNote).toBe("string");
  });

  it("human-readable format contains all five table names and recall-weighted section", async () => {
    insertSession("sess-fmt", "/abs/client-a");

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    const chunks: string[] = [];
    formatCoverageResult(result, (s) => chunks.push(s));
    const output = chunks.join("");

    for (const name of ["sessions", "facts", "code_exemplars", "signals", "workstreams"]) {
      expect(output).toContain(name);
    }
    expect(output).toContain("recall-weighted");
    expect(output).toContain("skipped");
  });

  it("empty DB: all tables report zero totals and zero fractions", async () => {
    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    for (const key of ["sessions", "facts", "code_exemplars", "signals", "workstreams"] as const) {
      expect(result[key].total).toBe(0);
      expect(result[key].stamped).toBe(0);
      expect(result[key].stamped_fraction).toBe(0);
    }
    expect(result.overall).toEqual({ total: 0, stamped: 0, unstamped: 0, stamped_fraction: 0 });
  });

  it("overall aggregates stamped and total across all five tables", async () => {
    insertSession("s-o1", "/abs/client-a");
    insertSession("s-o2", null);
    insertFact("f-o1", "s-o1", "/abs/client-a");
    insertExemplar("e-o1", null);
    insertSignal("g-o1", "/abs/client-a");
    insertWorkstream("w-o1", null);

    const result = await runScopeCoverage({
      dbPath: dbFilePath,
      queryLogPath: join(tmpDir, "no-log.jsonl"),
    });

    expect(result.overall.total).toBe(6);
    expect(result.overall.stamped).toBe(3);
    expect(result.overall.unstamped).toBe(3);
    expect(result.overall.stamped_fraction).toBeCloseTo(0.5);

    const chunks: string[] = [];
    formatCoverageResult(result, (s) => chunks.push(s));
    expect(chunks.join("")).toContain("overall");
  });

  it("rejects a non-positive or non-numeric window", async () => {
    for (const bad of [0, -5, Number.NaN]) {
      await expect(
        runScopeCoverage({ dbPath: dbFilePath, queryLogPath: join(tmpDir, "no-log.jsonl"), window: bad }),
      ).rejects.toThrow("invalid --window");
    }
  });
});
