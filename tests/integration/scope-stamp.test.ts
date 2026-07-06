/**
 * Integration: NLM_SCOPE_STAMP=1 stamps scope across all five corpus tables.
 *
 * All paths are synthetic (/abs/..., /tmp/...) or test-local temp dirs.
 * Signals never take "global" scope. Flag off = byte-identical to today.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAliasMapCache } from "../../src/core/scope/alias-map.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import type { SignalStore, SignalAggregationFilter } from "../../src/ports/signal-store.js";
import type { Signal } from "../../src/shared/types.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { PiAdapter } from "../../src/core/adapters/pi.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import { StubEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async nameWorkstream(): Promise<string | null> { return "project-alpha"; }
  async classify(): Promise<ClassifyResult> {
    return {
      label: "scope stamp test",
      summary: "testing scope stamping",
      entities: [],
      decisions: ["use sqlite"],
      open: [],
      confidence: 0.9,
      facts: [{ kind: "decision", subject: "db", predicate: "backend", value: "sqlite" }],
    };
  }
}

function fakeSignalStore(): SignalStore & { rows: Signal[] } {
  const rows: Signal[] = [];
  return {
    rows,
    async insert(s) { if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async insertMany(ss) { for (const s of ss) if (!rows.some((r) => r.id === s.id)) rows.push(s); },
    async listForAggregation(_f: SignalAggregationFilter) { return rows; },
    async countSince() { return rows.length; },
    async pruneOlderThan() { return 0; },
  };
}

function signalApp(signalStore: SignalStore, sessionScopeReader?: { getSessionScopeById(id: string): Promise<string | null> }) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {} as never,
    signalStore,
    installScope: "install-test",
    ...(sessionScopeReader ? { sessionScopeReader } : {}),
  } as never);
}

async function postSignal(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request("/api/signal", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3940" },
    body: JSON.stringify({
      kind: "gate", producer: "qg", outcome: "fail", model: "m",
      ts: "2026-06-01T10:00:00.000Z", ...body,
    }),
  });
}

function buildChunkFixture(projectsRoot: string, sessionId: string, opts: { cwd?: string | false } = {}): string {
  const projDir = join(projectsRoot, "proj");
  mkdirSync(projDir, { recursive: true });
  const cwd = opts.cwd === false ? undefined : (opts.cwd ?? projDir);
  const jsonl =
    JSON.stringify({ type: "summary", summary: { sessionId }, ...(cwd ? { cwd } : {}) }) + "\n" +
    JSON.stringify({ type: "user", message: { content: "add scope stamping" }, timestamp: "2026-06-01T10:00:00.000Z" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: "done" }, timestamp: "2026-06-01T10:01:00.000Z" }) + "\n";
  const file = join(projDir, "session.jsonl");
  writeFileSync(file, jsonl);
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(file, old, old);
  return projDir;
}

function withScopesJson(homeDir: string, scopes: Record<string, string[]>): void {
  mkdirSync(join(homeDir, ".nlm"), { recursive: true });
  writeFileSync(join(homeDir, ".nlm", "scopes.json"), JSON.stringify(scopes));
  resetAliasMapCache();
}

describe("scope stamping (NLM_SCOPE_STAMP flag)", () => {
  let dbDir: string;
  let projectsDir: string;
  let storage: SqliteStorage;
  const prevStampFlag = process.env["NLM_SCOPE_STAMP"];
  const prevBindFlag = process.env["NLM_WORKSTREAM_BIND"];
  const prevHome = process.env["HOME"];

  function makeScheduler(withWorkstreams = false) {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projectsDir, idleMinutes: 1 });
    return new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      factStore: storage.facts,
      ...(withWorkstreams ? { workstreams: storage.workstreams } : {}),
      idleMinutes: 1,
      logger: () => {},
    });
  }

  function readDb<T>(fn: (db: Database.Database) => T): T {
    const db = new Database(join(dbDir, "canonical.sqlite"), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "nlm-scope-stamp-"));
    projectsDir = mkdtempSync(join(tmpdir(), "nlm-scope-projects-"));
    storage = SqliteStorage.create({
      dbPath: join(dbDir, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    resetAliasMapCache();
  });

  afterEach(async () => {
    await storage.close();
    for (const d of [dbDir, projectsDir]) rmSync(d, { recursive: true, force: true });
    if (prevStampFlag === undefined) delete process.env["NLM_SCOPE_STAMP"];
    else process.env["NLM_SCOPE_STAMP"] = prevStampFlag;
    if (prevBindFlag === undefined) delete process.env["NLM_WORKSTREAM_BIND"];
    else process.env["NLM_WORKSTREAM_BIND"] = prevBindFlag;
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    resetAliasMapCache();
  });

  describe("flag off (default behavior)", () => {
    it("session and fact scope stay null when NLM_SCOPE_STAMP is unset", async () => {
      delete process.env["NLM_SCOPE_STAMP"];
      buildChunkFixture(projectsDir, "scope-off-sess-001");
      const report = await makeScheduler().tick();
      expect(report.inserted).toBe(1);

      readDb((db) => {
        const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
        expect(sess?.scope).toBeNull();
        const facts = db.prepare<[], { scope: string | null }>("SELECT scope FROM facts").all();
        for (const fact of facts) expect(fact.scope).toBeNull();
      });
    });

    it("binds a session to an existing workstream regardless of scope when the flag is off (N4)", async () => {
      delete process.env["NLM_SCOPE_STAMP"];
      process.env["NLM_WORKSTREAM_BIND"] = "true";
      buildChunkFixture(projectsDir, "scope-off-bind-002");
      await storage.workstreams.create({ id: "ws_scope_b", label: "project-alpha", scope: "scope-b" });

      await makeScheduler(true).tick();

      readDb((db) => {
        const sess = db
          .prepare<[], { workstream_id: string | null }>("SELECT workstream_id FROM sessions")
          .get();
        expect(sess?.workstream_id).toBe("ws_scope_b");
        const wsCount = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM workstreams").get();
        expect(wsCount?.n).toBe(1);
      });
    });
  });

  describe("upsert scope-downgrade guard (Fix A)", () => {
    function makeRecord(id: string, scope: string | null): IngestRecord {
      return {
        id,
        runtime: "claude-code",
        runtimeSessionId: null,
        startedAt: "2026-06-01T10:00:00Z",
        endedAt: "2026-06-01T10:30:00Z",
        durationMin: 30,
        label: "scope guard test",
        summary: "testing upsert guard",
        body: null,
        status: "closed",
        transcriptKind: null,
        transcriptPath: null,
        transcriptOffset: null,
        transcriptLength: null,
        entities: [],
        decisions: [],
        openQuestions: [],
        scope,
      };
    }

    it("re-ingest with null scope does not overwrite a previously stamped non-null scope", async () => {
      await storage.sessions.insertSession(makeRecord("scope-guard-sess-050", "client-a"));
      await storage.sessions.insertSession(makeRecord("scope-guard-sess-050", null));

      readDb((db) => {
        const sess = db.prepare<[string], { scope: string | null }>("SELECT scope FROM sessions WHERE id = ?").get("scope-guard-sess-050");
        expect(sess?.scope).toBe("client-a");
      });
    });

    it("re-ingest with a non-null scope updates the stored scope", async () => {
      await storage.sessions.insertSession(makeRecord("scope-guard-sess-051", "client-a"));
      await storage.sessions.insertSession(makeRecord("scope-guard-sess-051", "client-b"));

      readDb((db) => {
        const sess = db.prepare<[string], { scope: string | null }>("SELECT scope FROM sessions WHERE id = ?").get("scope-guard-sess-051");
        expect(sess?.scope).toBe("client-b");
      });
    });
  });

  describe("flag on: session and fact stamping", () => {
    it("stamps a path-based scope on the session and its facts when projectDir has no alias", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const projDir = buildChunkFixture(projectsDir, "scope-on-sess-002");
      const report = await makeScheduler().tick();
      expect(report.inserted).toBe(1);

      readDb((db) => {
        const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
        expect(sess?.scope).toBe(realpathSync(projDir));
        const facts = db.prepare<[], { scope: string | null }>("SELECT scope FROM facts").all();
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) expect(fact.scope).toBe(sess?.scope);
      });
    });

    it("stamps the named scope from the alias map", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const projDir = buildChunkFixture(projectsDir, "scope-alias-sess-003");
      process.env["HOME"] = dbDir;
      withScopesJson(dbDir, { "client-a": [projDir] });

      await makeScheduler().tick();

      readDb((db) => {
        const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
        expect(sess?.scope).toBe("client-a");
      });
    });

    it("stamps global on the session and its facts, but NULL on a signal from the same path", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const projDir = buildChunkFixture(projectsDir, "scope-global-sess-004");
      process.env["HOME"] = dbDir;
      withScopesJson(dbDir, { global: [projectsDir] });

      await makeScheduler().tick();

      readDb((db) => {
        const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
        expect(sess?.scope).toBe("global");
        const facts = db.prepare<[], { scope: string | null }>("SELECT scope FROM facts").all();
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) expect(fact.scope).toBe("global");
      });

      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store), { repo: "proj", repo_path: projDir });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });

    it("stamps NULL on a session with an empty projectDir", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      buildChunkFixture(projectsDir, "scope-empty-sess-005", { cwd: false });

      await makeScheduler().tick();

      readDb((db) => {
        const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
        expect(sess?.scope).toBeNull();
      });
    });
  });

  describe("flag on: workstream scope isolation", () => {
    it("creates a new workstream in the session scope instead of binding cross-scope", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      process.env["NLM_WORKSTREAM_BIND"] = "true";
      const projDir = buildChunkFixture(projectsDir, "scope-isolation-sess-006");
      await storage.workstreams.create({ id: "ws_scope_b", label: "project-alpha", scope: "scope-b" });

      await makeScheduler(true).tick();

      const expectedScope = realpathSync(projDir);
      readDb((db) => {
        const sess = db
          .prepare<[], { workstream_id: string | null; scope: string | null }>(
            "SELECT workstream_id, scope FROM sessions",
          )
          .get();
        expect(sess?.workstream_id).not.toBeNull();
        expect(sess?.workstream_id).not.toBe("ws_scope_b");

        const newWs = db
          .prepare<[string], { label: string; scope: string | null }>(
            "SELECT label, scope FROM workstreams WHERE id = ?",
          )
          .get(sess!.workstream_id!);
        expect(newWs?.label).toBe("project-alpha");
        expect(newWs?.scope).toBe(expectedScope);
        expect(sess?.scope).toBe(expectedScope);
      });
    });

    it("binds to the same-scope workstream and creates nothing new", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      process.env["NLM_WORKSTREAM_BIND"] = "true";
      const projDir = buildChunkFixture(projectsDir, "scope-bind-sess-007");
      const expectedScope = realpathSync(projDir);
      await storage.workstreams.create({ id: "ws_scope_a", label: "project-alpha", scope: expectedScope });

      await makeScheduler(true).tick();

      readDb((db) => {
        const sess = db
          .prepare<[], { workstream_id: string | null }>("SELECT workstream_id FROM sessions")
          .get();
        expect(sess?.workstream_id).toBe("ws_scope_a");
        const wsCount = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM workstreams").get();
        expect(wsCount?.n).toBe(1);
      });
    });

    it("binds a null-scope session only to a null-scope workstream", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      process.env["NLM_WORKSTREAM_BIND"] = "true";
      buildChunkFixture(projectsDir, "scope-null-sess-008", { cwd: false });
      await storage.workstreams.create({ id: "ws_null_scope", label: "project-alpha", scope: null });
      await storage.workstreams.create({ id: "ws_some_scope", label: "project-alpha", scope: "scope-x" });

      await makeScheduler(true).tick();

      readDb((db) => {
        const sess = db
          .prepare<[], { workstream_id: string | null }>("SELECT workstream_id FROM sessions")
          .get();
        expect(sess?.workstream_id).toBe("ws_null_scope");
      });
    });
  });

  describe("flag on: exemplar stamping", () => {
    it("stores the scope stamped on the exemplar input", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      await storage.exemplars.insert({
        installScope: "install-test",
        signalId: null,
        sessionId: "sess_x",
        repo: "proj",
        model: "m",
        lang: "ts",
        taskContext: "ctx",
        code: "const a = 1;\nconst b = 2;\nconst c = a + b;",
        codeHash: "hash-scope-1",
        outcome: "pass",
        gitSha: null,
        survived: null,
        scope: "client-a",
        ts: "2026-06-01T10:00:00.000Z",
      });

      readDb((db) => {
        const row = db.prepare<[], { scope: string | null }>("SELECT scope FROM code_exemplars").get();
        expect(row?.scope).toBe("client-a");
      });
    });

    it("stamps the chunk scope on an exemplar captured by a real scheduler tick", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const prevExemplars = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
      const repoDir = mkdtempSync(join(tmpdir(), "nlm-scope-repo-"));
      try {
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
        git("init", "-q");
        git("config", "user.email", "t@t.test");
        git("config", "user.name", "t");
        writeFileSync(join(repoDir, "t.ts"), "export const t = () => {\n  const v = 2 + 2;\n  return v;\n};\n");
        git("add", "t.ts");
        git("commit", "-q", "-m", "add t");
        const sha = git("rev-parse", "--short", "HEAD");

        const projDir = join(projectsDir, "proj");
        mkdirSync(projDir, { recursive: true });
        const jsonl =
          JSON.stringify({ type: "user", cwd: repoDir, timestamp: "2026-06-01T10:00:00.000Z", message: { role: "user", content: "add t" } }) + "\n" +
          JSON.stringify({ type: "assistant", cwd: repoDir, timestamp: "2026-06-01T10:01:00.000Z", message: { role: "assistant", content: `committed: [main ${sha}] add t` } }) + "\n";
        const file = join(projDir, "session.jsonl");
        writeFileSync(file, jsonl);
        const old = (Date.now() - 60 * 60 * 1000) / 1000;
        utimesSync(file, old, old);

        const adapter = new ClaudeCodeAdapter({ projectsPath: projectsDir, idleMinutes: 1 });
        const scheduler = new ScanScheduler({
          store: storage.sessions,
          adapters: [adapter],
          classifier: new StubClassifier(),
          embedder: new StubEmbedder(),
          installScope: "install-test",
          exemplarStore: storage.exemplars,
          idleMinutes: 1,
          logger: () => {},
        });
        await scheduler.tick();

        const expectedScope = realpathSync(repoDir);
        readDb((db) => {
          const row = db.prepare<[], { scope: string | null }>("SELECT scope FROM code_exemplars").get();
          expect(row?.scope).toBe(expectedScope);
          const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
          expect(sess?.scope).toBe(expectedScope);
        });
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        if (prevExemplars === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
        else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prevExemplars;
      }
    });
  });

  describe("flag on: embedded chunk signals through the scheduler (drainSignals)", () => {
    function buildPiFixture(sessionsRoot: string, cwd: string, sessionId: string): void {
      const slugDir = join(sessionsRoot, "proj-slug");
      mkdirSync(slugDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: "session", id: sessionId, cwd }),
        JSON.stringify({ type: "message", message: { role: "user", content: "run gate", timestamp: "2026-06-01T10:00:00.000Z" } }),
        JSON.stringify({ type: "custom", customType: "nlm.signal", data: { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "proj", detail: { step: "types" }, ts: "2026-06-01T10:01:00.000Z" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "done", timestamp: "2026-06-01T10:02:00.000Z" } }),
      ];
      const file = join(slugDir, "2026-06-01T10-00-00_abc.jsonl");
      writeFileSync(file, lines.join("\n"));
      const old = (Date.now() - 60 * 60 * 1000) / 1000;
      utimesSync(file, old, old);
    }

    function makePiScheduler(sessionsRoot: string) {
      return new ScanScheduler({
        store: storage.sessions,
        adapters: [new PiAdapter({ sessionsPath: sessionsRoot, idleMinutes: 1 })],
        classifier: new StubClassifier(),
        embedder: new StubEmbedder(),
        factStore: storage.facts,
        signalStore: storage.signals,
        installScope: "install-test",
        idleMinutes: 1,
        logger: () => {},
      });
    }

    it("stamps the chunk scope on an embedded signal drained by a real tick", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const piRoot = mkdtempSync(join(tmpdir(), "nlm-scope-pi-"));
      try {
        const projDir = join(projectsDir, "proj");
        mkdirSync(projDir, { recursive: true });
        buildPiFixture(piRoot, projDir, "pi_scope_sig_1");
        await makePiScheduler(piRoot).tick();

        const expected = realpathSync(projDir);
        readDb((db) => {
          const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
          expect(sess?.scope).toBe(expected);
          const sig = db.prepare<[], { scope: string | null }>("SELECT scope FROM signals").get();
          expect(sig).toBeDefined();
          expect(sig?.scope).toBe(expected);
        });
      } finally {
        rmSync(piRoot, { recursive: true, force: true });
      }
    });

    it("stamps NULL on an embedded signal whose chunk scope is global (signals never take global)", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      process.env["HOME"] = dbDir;
      withScopesJson(dbDir, { global: [projectsDir] });
      const piRoot = mkdtempSync(join(tmpdir(), "nlm-scope-pi-"));
      try {
        const projDir = join(projectsDir, "proj");
        mkdirSync(projDir, { recursive: true });
        buildPiFixture(piRoot, projDir, "pi_scope_sig_2");
        await makePiScheduler(piRoot).tick();

        readDb((db) => {
          const sess = db.prepare<[], { scope: string | null }>("SELECT scope FROM sessions").get();
          expect(sess?.scope).toBe("global");
          const sig = db.prepare<[], { scope: string | null }>("SELECT scope FROM signals").get();
          expect(sig).toBeDefined();
          expect(sig?.scope).toBeNull();
        });
      } finally {
        rmSync(piRoot, { recursive: true, force: true });
      }
    });
  });

  describe("signal scope via HTTP handler", () => {
    it("stamps scope from repo_path when flag is on", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store), {
        repo: "proj", repo_path: "/abs/client-a/proj", session: "sess_1",
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBe("/abs/client-a/proj");
    });

    it("stamps NULL when repo_path maps to the global scope", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      process.env["HOME"] = dbDir;
      withScopesJson(dbDir, { global: ["/abs/shared"] });
      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store), {
        repo: "tools", repo_path: "/abs/shared/tools",
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });

    it("gives two signals with the same repo basename but different repo_paths different scopes", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      const app = signalApp(store);
      await postSignal(app, { repo: "proj", repo_path: "/abs/client-a/proj", ts: "2026-06-01T10:00:00.000Z" });
      await postSignal(app, { repo: "proj", repo_path: "/abs/client-b/proj", ts: "2026-06-01T10:00:01.000Z" });
      expect(store.rows).toHaveLength(2);
      expect(store.rows[0]?.scope).toBe("/abs/client-a/proj");
      expect(store.rows[1]?.scope).toBe("/abs/client-b/proj");
      expect(store.rows[0]?.scope).not.toBe(store.rows[1]?.scope);
    });

    it("inherits scope from the session via sessionScopeReader when repo_path is absent", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      const reader = { getSessionScopeById: async (_id: string) => "client-a" };
      const res = await postSignal(signalApp(store, reader), {
        repo: "proj", session: "sess_1",
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBe("client-a");
    });

    it("inherits from a real stamped session row through the production reader", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const projDir = buildChunkFixture(projectsDir, "scope-inherit-sess-020");
      await makeScheduler().tick();
      const expectedScope = realpathSync(projDir);
      const sessionId = readDb((db) =>
        db.prepare<[], { id: string }>("SELECT id FROM sessions").get()!.id,
      );

      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store, storage.sessions), {
        repo: "proj", session: sessionId,
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBe(expectedScope);
    });

    it("stamps NULL when the inherited session scope is global (signals never take global)", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      const reader = { getSessionScopeById: async (_id: string) => "global" };
      const res = await postSignal(signalApp(store, reader), {
        repo: "proj", session: "sess_g",
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });

    it("never derives from the stored repo basename (N1 guard)", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      // repo carries an absolute-path-shaped value; if any code path fed it
      // to deriveScope, the scope would come back non-null.
      const res = await postSignal(signalApp(store), { repo: "/abs/client-a/proj" });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });

    it("stays NULL with flag on when neither repo_path nor session is present", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store), { repo: "proj" });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });

    it("signal scope is null when flag is off", async () => {
      delete process.env["NLM_SCOPE_STAMP"];
      const store = fakeSignalStore();
      const res = await postSignal(signalApp(store), {
        repo: "proj", repo_path: "/abs/client-a/proj", session: "sess_2", outcome: "pass",
      });
      expect(res.status).toBe(202);
      expect(store.rows[0]?.scope).toBeNull();
    });
  });

  describe("exemplar scope via HTTP handler (Fix B)", () => {
    const prevExemplars = process.env["NLM_CODE_EXEMPLARS_ENABLED"];

    function fakeExemplarStore() {
      const inserted: Array<{ scope: string | null }> = [];
      return {
        inserted,
        async insert(inp: { scope: string | null }) {
          inserted.push({ scope: inp.scope });
          return { id: "ex_test", skipped: false };
        },
        async insertMany() { return 0; },
        async upsertEmbedding() {},
        async searchByVector() { return []; },
        async getById() { return null; },
        async applyBucketCap() { return 0; },
        async pruneReverted() { return 0; },
        async pruneOlderThan() { return 0; },
        async setVerdict() { return { status: "applied" as const }; },
        async listBySessions() { return []; },
      };
    }

    const EXEMPLAR_BODY = {
      repo: "proj",
      model: "m",
      lang: "ts",
      taskContext: "add two numbers",
      code: "function add(a: number, b: number): number {\n  return a + b;\n}",
      outcome: "pass",
    };

    function exemplarApp(store: ReturnType<typeof fakeExemplarStore>) {
      return createApp({
        recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
        store: {} as never,
        exemplarStore: store as never,
        installScope: "install-test",
      } as never);
    }

    async function postExemplar(app: ReturnType<typeof createApp>, extra: Record<string, unknown> = {}) {
      return app.request("/api/exemplar", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3940" },
        body: JSON.stringify({ ...EXEMPLAR_BODY, ...extra }),
      });
    }

    beforeEach(() => { process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1"; });
    afterEach(() => {
      if (prevExemplars === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
      else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prevExemplars;
    });

    it("drops caller-supplied scope when flag is off", async () => {
      delete process.env["NLM_SCOPE_STAMP"];
      const store = fakeExemplarStore();
      const res = await postExemplar(exemplarApp(store), { scope: "client-a" });
      expect(res.status).toBe(202);
      expect(store.inserted[0]?.scope).toBeNull();
    });

    it("preserves caller-supplied scope when flag is on", async () => {
      process.env["NLM_SCOPE_STAMP"] = "1";
      const store = fakeExemplarStore();
      const res = await postExemplar(exemplarApp(store), { scope: "client-a" });
      expect(res.status).toBe(202);
      expect(store.inserted[0]?.scope).toBe("client-a");
    });
  });
});
