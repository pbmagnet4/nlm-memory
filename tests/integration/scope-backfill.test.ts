/**
 * Integration: `nlm scope backfill` derives scope for sessions/facts/exemplars/signals/workstreams.
 *
 * All paths and fixture data are synthetic (client-a/client-b, temp dirs).
 * Never touches ~/.nlm; all calls pass --db to a temp file.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runScopeBackfill } from "../../src/cli/scope-backfill.js";
import { resetAliasMapCache } from "../../src/core/scope/alias-map.js";
import type { AliasMap } from "../../src/core/scope/alias-map.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function emptyAliasMap(): AliasMap {
  return { named: [], global: [] };
}

function aliasMapWithGlobal(globalPaths: string[]): AliasMap {
  return { named: [], global: globalPaths };
}

function aliasMapWithNamed(name: string, paths: string[]): AliasMap {
  return { named: [{ scope: name, paths }], global: [] };
}

function makeSyntheticTranscript(cwd: string): string {
  return (
    JSON.stringify({ type: "summary", summary: { sessionId: "s1" }, cwd }) + "\n" +
    JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-01-01T10:00:00Z" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: "world" }, timestamp: "2026-01-01T10:01:00Z" }) + "\n"
  );
}

function makeMalformedTranscript(): string {
  return "not-json\n{ also not json\n";
}

describe("scope-backfill", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nlm-sb-"));
    dbPath = join(tmpDir, "canonical.sqlite");
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    resetAliasMapCache();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
    resetAliasMapCache();
  });

  function rawDb(): Database.Database {
    return storage.sessions.rawDb();
  }

  function insertSession(id: string, transcriptPath: string | null, scope: string | null = null): void {
    rawDb()
      .prepare(
        `INSERT INTO sessions (id, runtime, started_at, label, summary, status, transcript_path, scope)
         VALUES (?, 'test', '2026-01-01T10:00:00Z', 'L', 'S', 'active', ?, ?)`,
      )
      .run(id, transcriptPath, scope);
  }

  function insertFact(id: string, sessionId: string, scope: string | null = null): void {
    rawDb()
      .prepare(
        `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, scope)
         VALUES (?, 'decision', 'subj', 'pred', 'val', ?, 0.9, ?)`,
      )
      .run(id, sessionId, scope);
  }

  function insertExemplar(id: string, sessionId: string | null, scope: string | null = null): void {
    rawDb()
      .prepare(
        `INSERT INTO code_exemplars (id, install_scope, session_id, repo, model, task_context, code, code_hash, outcome, ts, scope)
         VALUES (?, 'inst', ?, 'repo-a', 'm', 'ctx', 'code', ?, 'pass', '2026-01-01T10:00:00Z', ?)`,
      )
      .run(id, sessionId, `hash-${id}`, scope);
  }

  function insertSignal(id: string, sessionId: string | null, scope: string | null = null): void {
    rawDb()
      .prepare(
        `INSERT INTO signals (id, v, install_scope, kind, producer, outcome, model, repo, ts, session_id, scope, created_at)
         VALUES (?, 1, 'inst', 'gate', 'prod', 'pass', 'm', 'repo-a', '2026-01-01T10:00:00Z', ?, ?, datetime('now'))`,
      )
      .run(id, sessionId, scope);
  }

  function insertWorkstream(id: string, scope: string | null = null): void {
    rawDb()
      .prepare("INSERT INTO workstreams (id, label, scope) VALUES (?, 'WS', ?)")
      .run(id, scope);
  }

  function bindSessionToWorkstream(sessionId: string, workstreamId: string): void {
    rawDb()
      .prepare("UPDATE sessions SET workstream_id = ? WHERE id = ?")
      .run(workstreamId, sessionId);
  }

  function getScope(table: string, id: string): string | null {
    const row = rawDb()
      .prepare<[string], { scope: string | null }>(`SELECT scope FROM ${table} WHERE id = ?`)
      .get(id);
    return row?.scope ?? null;
  }

  it("dry-run reports would-change counts without writing anything", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const transcriptPath = join(transcriptDir, "sess1.jsonl");
    writeFileSync(transcriptPath, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess1", transcriptPath);
    insertFact("fact1", "sess1");

    const dbSizeBefore = statSync(dbPath).size;

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: false,
      aliasMap: emptyAliasMap(),
    });

    const dbSizeAfter = statSync(dbPath).size;

    expect(result.dryRun).toBe(true);
    expect(result.sessions.total).toBe(1);
    expect(result.sessions.byScope["/abs/client-a/proj"]).toBe(1);
    expect(result.facts.total).toBe(1);

    expect(getScope("sessions", "sess1")).toBeNull();
    expect(getScope("facts", "fact1")).toBeNull();
    expect(dbSizeBefore).toBe(dbSizeAfter);
  });

  it("apply stamps sessions from transcript cwd and cascades to facts and exemplars", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const transcriptPath = join(transcriptDir, "sess1.jsonl");
    writeFileSync(transcriptPath, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess1", transcriptPath);
    insertFact("fact1", "sess1");
    insertExemplar("ex1", "sess1");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.dryRun).toBe(false);
    expect(result.sessions.total).toBe(1);
    expect(result.facts.total).toBe(1);
    expect(result.exemplars.total).toBe(1);

    expect(getScope("sessions", "sess1")).toBe("/abs/client-a/proj");
    expect(getScope("facts", "fact1")).toBe("/abs/client-a/proj");
    expect(getScope("code_exemplars", "ex1")).toBe("/abs/client-a/proj");
  });

  it("missing transcript session stays NULL and is counted as skipped", async () => {
    insertSession("sess-missing", "/nonexistent/path/session.jsonl");
    insertFact("fact-missing", "sess-missing");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.skipped.missingTranscript).toBe(1);
    expect(result.sessions.total).toBe(0);
    expect(getScope("sessions", "sess-missing")).toBeNull();
    expect(getScope("facts", "fact-missing")).toBeNull();
  });

  it("a transcript with no parseable JSON lines derives nothing and is not fatal", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const transcriptPath = join(transcriptDir, "bad.jsonl");
    writeFileSync(transcriptPath, makeMalformedTranscript());

    insertSession("sess-bad", transcriptPath);
    insertFact("fact-bad", "sess-bad");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.skipped.malformed).toBe(0);
    expect(result.skipped.missingTranscript).toBe(0);
    expect(result.skipped.noCwdFound).toBe(1);
    expect(result.sessions.total).toBe(0);
    expect(getScope("sessions", "sess-bad")).toBeNull();
  });

  it("signal inherits its session scope after session backfill", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const transcriptPath = join(transcriptDir, "sess1.jsonl");
    writeFileSync(transcriptPath, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess1", transcriptPath);
    insertSignal("sig1", "sess1");

    await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(getScope("signals", "sig1")).toBe("/abs/client-a/proj");
  });

  it("signal with no session_id stays NULL", async () => {
    insertSignal("sig-no-sess", null);

    await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(getScope("signals", "sig-no-sess")).toBeNull();
  });

  it("signal under a global-scoped session stays NULL (signals never take global)", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const transcriptPath = join(transcriptDir, "sess-global.jsonl");
    writeFileSync(transcriptPath, makeSyntheticTranscript("/abs/shared/workspace"));

    insertSession("sess-global", transcriptPath);
    insertSignal("sig-global", "sess-global");

    await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: aliasMapWithGlobal(["/abs/shared"]),
    });

    expect(getScope("sessions", "sess-global")).toBe("global");
    expect(getScope("signals", "sig-global")).toBeNull();
  });

  it("mixed-scope workstream stays NULL", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);

    const tp1 = join(transcriptDir, "s1.jsonl");
    const tp2 = join(transcriptDir, "s2.jsonl");
    writeFileSync(tp1, makeSyntheticTranscript("/abs/client-a/proj"));
    writeFileSync(tp2, makeSyntheticTranscript("/abs/client-b/proj"));

    insertSession("sess-a", tp1);
    insertSession("sess-b", tp2);
    insertWorkstream("ws-mixed");
    bindSessionToWorkstream("sess-a", "ws-mixed");
    bindSessionToWorkstream("sess-b", "ws-mixed");

    await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(getScope("sessions", "sess-a")).toBe("/abs/client-a/proj");
    expect(getScope("sessions", "sess-b")).toBe("/abs/client-b/proj");
    expect(getScope("workstreams", "ws-mixed")).toBeNull();
  });

  it("unanimous-scope workstream inherits the scope", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);

    const tp1 = join(transcriptDir, "s1.jsonl");
    const tp2 = join(transcriptDir, "s2.jsonl");
    writeFileSync(tp1, makeSyntheticTranscript("/abs/client-a/proj"));
    writeFileSync(tp2, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-1", tp1);
    insertSession("sess-2", tp2);
    insertWorkstream("ws-unanimous");
    bindSessionToWorkstream("sess-1", "ws-unanimous");
    bindSessionToWorkstream("sess-2", "ws-unanimous");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.workstreams.total).toBe(1);
    expect(getScope("workstreams", "ws-unanimous")).toBe("/abs/client-a/proj");
  });

  it("second apply is a no-op (idempotent)", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "sess.jsonl");
    writeFileSync(tp, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-idem", tp);
    insertFact("fact-idem", "sess-idem");
    insertSignal("sig-idem", "sess-idem");

    await runScopeBackfill({ db: rawDb(), apply: true, aliasMap: emptyAliasMap() });

    const result2 = await runScopeBackfill({ db: rawDb(), apply: true, aliasMap: emptyAliasMap() });

    expect(result2.sessions.total).toBe(0);
    expect(result2.facts.total).toBe(0);
    expect(result2.signals.total).toBe(0);
  });

  it("already-scoped rows are not overwritten", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "sess.jsonl");
    writeFileSync(tp, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-pre", tp, "pre-existing-scope");
    insertFact("fact-pre", "sess-pre", "pre-existing-scope");

    await runScopeBackfill({ db: rawDb(), apply: true, aliasMap: emptyAliasMap() });

    expect(getScope("sessions", "sess-pre")).toBe("pre-existing-scope");
    expect(getScope("facts", "fact-pre")).toBe("pre-existing-scope");
  });

  it("uses named alias from aliasMap instead of raw path", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "sess.jsonl");
    writeFileSync(tp, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-alias", tp);

    await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: aliasMapWithNamed("client-a", ["/abs/client-a"]),
    });

    expect(getScope("sessions", "sess-alias")).toBe("client-a");
  });

  it("dry-run leaves DB byte-identical (no scope writes)", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "sess.jsonl");
    writeFileSync(tp, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-dryrun", tp);
    insertFact("fact-dryrun", "sess-dryrun");

    const dbContentBefore = readFileSync(dbPath);

    await runScopeBackfill({ db: rawDb(), apply: false, aliasMap: emptyAliasMap() });

    const dbContentAfter = readFileSync(dbPath);
    expect(Buffer.compare(dbContentBefore, dbContentAfter)).toBe(0);
  });

  it("session with no cwd in transcript head stays NULL (no cwd = skip)", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "no-cwd.jsonl");
    writeFileSync(
      tp,
      JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-01-01T10:00:00Z" }) + "\n",
    );

    insertSession("sess-no-cwd", tp);

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.sessions.total).toBe(0);
    expect(result.skipped.missingTranscript).toBe(0);
    expect(result.skipped.noCwdFound).toBe(1);
    expect(getScope("sessions", "sess-no-cwd")).toBeNull();
  });

  it("a first line longer than the head-read cap fails closed to NULL", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "huge-first-line.jsonl");
    const padding = "x".repeat(9500);
    writeFileSync(
      tp,
      JSON.stringify({ type: "summary", padding, cwd: "/abs/client-a/proj" }) + "\n" +
        JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n",
    );

    insertSession("sess-huge", tp);

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.sessions.total).toBe(0);
    expect(result.skipped.missingTranscript).toBe(0);
    expect(result.skipped.malformed).toBe(0);
    expect(result.skipped.noCwdFound).toBe(1);
    expect(getScope("sessions", "sess-huge")).toBeNull();
  });

  it("a workstream with one scoped and one NULL-scoped member stays NULL", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tp = join(transcriptDir, "sess-ok.jsonl");
    writeFileSync(tp, makeSyntheticTranscript("/abs/client-a/proj"));

    insertSession("sess-ok", tp);
    insertSession("sess-lost", join(transcriptDir, "gone.jsonl"));
    insertWorkstream("ws-partial");
    bindSessionToWorkstream("sess-ok", "ws-partial");
    bindSessionToWorkstream("sess-lost", "ws-partial");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.sessions.total).toBe(1);
    expect(getScope("sessions", "sess-ok")).toBe("/abs/client-a/proj");
    expect(getScope("sessions", "sess-lost")).toBeNull();
    expect(result.workstreams.total).toBe(0);
    expect(getScope("workstreams", "ws-partial")).toBeNull();
  });

  it("dry-run and apply report identical counts for the same input", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);
    const tpA = join(transcriptDir, "a.jsonl");
    const tpB = join(transcriptDir, "b.jsonl");
    writeFileSync(tpA, makeSyntheticTranscript("/abs/client-a/proj"));
    writeFileSync(tpB, makeSyntheticTranscript("/abs/client-b/proj"));

    insertSession("sess-a", tpA);
    insertSession("sess-b", tpB);
    insertFact("fact-a", "sess-a");
    insertFact("fact-b", "sess-b");
    insertExemplar("ex-a", "sess-a");
    insertSignal("sig-a", "sess-a");
    insertWorkstream("ws-a");
    bindSessionToWorkstream("sess-a", "ws-a");

    const dry = await runScopeBackfill({ db: rawDb(), apply: false, aliasMap: emptyAliasMap() });
    const applied = await runScopeBackfill({ db: rawDb(), apply: true, aliasMap: emptyAliasMap() });

    for (const table of ["sessions", "facts", "exemplars", "signals", "workstreams"] as const) {
      expect(applied[table].total).toBe(dry[table].total);
      expect(applied[table].byScope).toEqual(dry[table].byScope);
    }
    expect(applied.skipped).toEqual(dry.skipped);
    expect(getScope("sessions", "sess-a")).toBe("/abs/client-a/proj");
    expect(getScope("workstreams", "ws-a")).toBe("/abs/client-a/proj");
  });

  it("workstream with no members stays NULL", async () => {
    insertWorkstream("ws-empty");

    await runScopeBackfill({ db: rawDb(), apply: true, aliasMap: emptyAliasMap() });

    expect(getScope("workstreams", "ws-empty")).toBeNull();
  });

  it("session with NULL transcript_path is not attempted", async () => {
    insertSession("sess-null-path", null);
    insertFact("fact-null-path", "sess-null-path");

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: true,
      aliasMap: emptyAliasMap(),
    });

    expect(result.sessions.total).toBe(0);
    expect(result.skipped.missingTranscript).toBe(0);
    expect(getScope("sessions", "sess-null-path")).toBeNull();
  });

  it("dry-run counts cover multiple scopes correctly", async () => {
    const transcriptDir = join(tmpDir, "transcripts");
    mkdirSync(transcriptDir);

    for (const [id, cwd] of [
      ["s-a1", "/abs/client-a/proj"],
      ["s-a2", "/abs/client-a/proj"],
      ["s-b1", "/abs/client-b/proj"],
    ] as const) {
      const tp = join(transcriptDir, `${id}.jsonl`);
      writeFileSync(tp, makeSyntheticTranscript(cwd));
      insertSession(id, tp);
      insertFact(`f-${id}`, id);
    }

    const result = await runScopeBackfill({
      db: rawDb(),
      apply: false,
      aliasMap: emptyAliasMap(),
    });

    expect(result.sessions.total).toBe(3);
    expect(result.sessions.byScope["/abs/client-a/proj"]).toBe(2);
    expect(result.sessions.byScope["/abs/client-b/proj"]).toBe(1);
    expect(result.facts.total).toBe(3);

    expect(getScope("sessions", "s-a1")).toBeNull();
    expect(getScope("sessions", "s-b1")).toBeNull();
  });
});
