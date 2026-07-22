/**
 * Integration tests for the Phase D Scheduler. Drives a tick against a
 * fixture-backed adapter through real SqliteSessionStore + sqlite-vec,
 * with fake LLMClients standing in for classifier and embedder.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import { MAX_CLASSIFY_FAILURES } from "../../src/core/scheduler/scan-once.js";
import { StubClassifier, StubEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const FIXTURES = resolve(__dirname, "../fixtures/claude_code");

function ageFiles(dir: string, ageMs: number): void {
  const now = (Date.now() - ageMs) / 1000;
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) ageFiles(full, ageMs);
    else if (statSync(full).isFile()) utimesSync(full, now, now);
  }
}


describe("ScanScheduler.tick", () => {
  let tmp: string;
  let dbPath: string;
  let projects: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sched-"));
    dbPath = join(tmp, "canonical.sqlite");
    projects = join(tmp, "projects");
    mkdirSync(join(projects, "project_a"), { recursive: true });
    copyFileSync(
      join(FIXTURES, "standard_iso.jsonl"),
      join(projects, "project_a", "fixture.jsonl"),
    );
    // make it look idle so scanOnce picks it up
    ageFiles(projects, 60 * 60 * 1000);
    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingests a discovered chunk: row + markers + entity link + embedding + adapter_state", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const embedder = new StubEmbedder();
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier,
      embedder,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.chunksSeen).toBe(1);
    expect(report.inserted).toBe(1);
    expect(report.skippedLowConfidence).toBe(0);
    expect(classifier.calls).toBe(1);
    expect(embedder.calls).toBe(1);

    const db = new Database(dbPath);
    sqliteVec.load(db);
    const sess = db.prepare<[], { id: string; label: string; status: string }>(
      "SELECT id, label, status FROM sessions",
    ).all();
    expect(sess).toHaveLength(1);
    expect(sess[0]?.label).toBe("Stub label");
    expect(sess[0]?.status).toBe("closed");

    const markers = db.prepare<[string], { kind: string; text: string }>(
      "SELECT kind, text FROM markers WHERE session_id = ?",
    ).all(sess[0]!.id);
    expect(markers.find((m) => m.kind === "decision")?.text).toBe("chose Hono");

    const ent = db.prepare<[string], { entity_canonical: string }>(
      "SELECT entity_canonical FROM session_entities WHERE session_id = ?",
    ).all(sess[0]!.id);
    expect(ent[0]?.entity_canonical).toBe("NLM");

    const emb = db.prepare<[string], { c: number }>(
      "SELECT COUNT(*) AS c FROM session_chunk_map WHERE session_id = ?",
    ).get(sess[0]!.id);
    expect(emb?.c).toBeGreaterThanOrEqual(1);

    const state = db.prepare<[], { source_path: string; session_id: string }>(
      "SELECT source_path, session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
    ).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.session_id).toBe(sess[0]!.id);
    db.close();
  });

  it("a second tick is a no-op when the file is unchanged", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const embedder = new StubEmbedder();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder, logger: () => {},
    });

    await scheduler.tick();
    const report = await scheduler.tick();
    expect(report.chunksSeen).toBe(0);
    expect(report.inserted).toBe(0);
  });

  it("skips chunks below the confidence floor", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "x", summary: "y", entities: [], decisions: [], open: [], confidence: 0.1, facts: [],
    });
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.skippedLowConfidence).toBe(1);
    expect(report.inserted).toBe(0);
  });

  it("low-confidence: records adapter_state so second tick is a no-op", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "x", summary: "y", entities: [], decisions: [], open: [], confidence: 0.1, facts: [],
    });
    const messages: string[] = [];
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null,
      logger: (m) => messages.push(m),
    });

    // Tick 1: file is new, classifier returns low-confidence
    const tick1 = await scheduler.tick();
    expect(tick1.chunksSeen).toBe(1);
    expect(tick1.skippedLowConfidence).toBe(1);
    expect(messages.some((m) => m.includes("low-confidence"))).toBe(true);

    // adapter_state must have been written (file_size set, session_id NULL)
    const state = store.rawDb()
      .prepare<[], { file_size: number; session_id: string | null }>(
        "SELECT file_size, session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get();
    expect(state).not.toBeNull();
    expect(state?.session_id).toBeNull();
    expect(state?.file_size).toBeGreaterThan(0);

    // Tick 2: unchanged file — must not re-attempt (chunksSeen = 0)
    const tick2 = await scheduler.tick();
    expect(tick2.chunksSeen).toBe(0);
  });

  it("low-confidence: re-attempted when file grows", async () => {
    const lowClassifier = new StubClassifier({
      label: "x", summary: "y", entities: [], decisions: [], open: [], confidence: 0.1, facts: [],
    });
    const highClassifier = new StubClassifier();
    let classifier: StubClassifier = lowClassifier;
    // Proxy that delegates to whichever classifier is active
    const proxy: import("../../src/ports/llm-client.js").LLMClient = {
      embed: async () => { throw new Error("not used"); },
      rewriteForRecall: async () => { throw new Error("not used"); },
      nameWorkstream: async () => { throw new Error("stub"); },
      classify: async (_text) => classifier.classify(),
    };

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier: proxy, embedder: null, logger: () => {},
    });

    // Tick 1: low-confidence, file_size recorded
    const tick1 = await scheduler.tick();
    expect(tick1.skippedLowConfidence).toBe(1);

    // Grow the file + re-age it
    const fixturePath = join(projects, "project_a", "fixture.jsonl");
    const { readFileSync: rfs, writeFileSync: wfs, utimesSync: uts } = require("node:fs") as typeof import("node:fs");
    wfs(fixturePath, rfs(fixturePath, "utf8") +
      JSON.stringify({ type: "user", message: { content: "more" }, timestamp: "2026-05-19T11:00:00Z" }) + "\n");
    const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
    uts(fixturePath, oldT, oldT);

    // Switch to high-confidence classifier and re-tick
    classifier = highClassifier;
    const tick2 = await scheduler.tick();
    expect(tick2.chunksSeen).toBe(1);
    expect(tick2.inserted).toBe(1);
  });

  it("low-confidence: prior session_id preserved in adapter_state after file grows + low-conf again", async () => {
    // Establish a prior successful classify (session_id = S)
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const goodClassifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier: goodClassifier, embedder: null, logger: () => {},
    });
    const tick1 = await scheduler.tick();
    expect(tick1.inserted).toBe(1);

    const db = store.rawDb();
    const priorSessionId = db
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;
    expect(priorSessionId).toBeTruthy();

    // Grow the file
    const fixturePath = join(projects, "project_a", "fixture.jsonl");
    const { readFileSync: rfs, writeFileSync: wfs, utimesSync: uts } = require("node:fs") as typeof import("node:fs");
    const mutated = rfs(fixturePath, "utf8")
      .replace(/"sessionId"\s*:\s*"[^"]+"/g, '"sessionId": "resumed-uuid-99999"') +
      JSON.stringify({ type: "user", message: { content: "more" }, timestamp: "2026-05-19T11:00:00Z" }) + "\n";
    wfs(fixturePath, mutated);
    const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
    uts(fixturePath, oldT, oldT);

    // Tick 2: low-confidence result
    const lowClassifier = new StubClassifier({
      label: "x", summary: "y", entities: [], decisions: [], open: [], confidence: 0.1, facts: [],
    });
    const scheduler2 = new ScanScheduler({
      store, adapters: [adapter], classifier: lowClassifier, embedder: null, logger: () => {},
    });
    const tick2 = await scheduler2.tick();
    expect(tick2.skippedLowConfidence).toBe(1);

    // session_id must still be the prior value — not clobbered
    const stateAfterLowConf = db
      .prepare<[], { session_id: string | null }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get();
    expect(stateAfterLowConf?.session_id).toBe(priorSessionId);

    // Grow again + high-confidence classify → supersedes prior session with 'replaces' edge
    wfs(fixturePath, rfs(fixturePath, "utf8") +
      JSON.stringify({ type: "user", message: { content: "even more" }, timestamp: "2026-05-19T12:00:00Z" }) + "\n");
    uts(fixturePath, oldT, oldT);

    const scheduler3 = new ScanScheduler({
      store, adapters: [adapter], classifier: goodClassifier, embedder: null, logger: () => {},
    });
    const tick3 = await scheduler3.tick();
    expect(tick3.inserted).toBe(1);

    // Should have a 'replaces' edge pointing at priorSessionId
    const edges = db.prepare<[], { from_session: string; to_session: string; kind: string }>(
      "SELECT from_session, to_session, kind FROM session_edges",
    ).all();
    expect(edges.some((e) => e.kind === "replaces" && e.to_session === priorSessionId)).toBe(true);
  });

  it("wires a 'continues' edge to a prior session that shares the same entity-set", async () => {
    // Two distinct transcript files in two projects. The stub classifier tags
    // both with the same entity ("NLM"), so the second ingest (a genuinely new
    // session, not a re-parse) continues the prior one rather than superseding it.
    mkdirSync(join(projects, "project_b"), { recursive: true });
    const second = join(projects, "project_b", "fixture.jsonl");
    const lines = [
      JSON.stringify({ type: "summary", summary: { sessionId: "second-session-uuid" } }),
      JSON.stringify({ type: "user", message: { content: "follow-up work" }, timestamp: "2026-05-20T10:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: "ack" }, timestamp: "2026-05-20T10:01:00Z" }),
    ].join("\n") + "\n";
    writeFileSync(second, lines, "utf8");
    ageFiles(projects, 60 * 60 * 1000);

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(2);

    const db = store.rawDb();
    const ids = db.prepare<[], { id: string; started_at: string }>(
      "SELECT id, started_at FROM sessions ORDER BY started_at ASC",
    ).all();
    expect(ids).toHaveLength(2);

    const continues = db.prepare<[], { from_session: string; to_session: string }>(
      "SELECT from_session, to_session FROM session_edges WHERE kind = 'continues'",
    ).all();
    expect(continues).toHaveLength(1);
    // Edge points from the later session to the earlier one it continues.
    expect(continues[0]!.from_session).toBe(ids[1]!.id);
    expect(continues[0]!.to_session).toBe(ids[0]!.id);

    // No supersedes/replaces edge: these are distinct sessions, not a re-parse.
    const supersede = db.prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM session_edges WHERE kind IN ('supersedes', 'replaces')",
    ).get();
    expect(supersede?.c).toBe(0);
    // Both sessions stay closed (a continuation does not retire its predecessor).
    const statuses = db.prepare<[], { status: string }>("SELECT status FROM sessions").all();
    expect(statuses.every((s) => s.status === "closed")).toBe(true);
  });

  it("does not wire a 'continues' edge when entity-sets differ", async () => {
    mkdirSync(join(projects, "project_b"), { recursive: true });
    const second = join(projects, "project_b", "fixture.jsonl");
    const lines = [
      JSON.stringify({ type: "summary", summary: { sessionId: "other-session-uuid" } }),
      JSON.stringify({ type: "user", message: { content: "unrelated work" }, timestamp: "2026-05-20T10:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: "ack" }, timestamp: "2026-05-20T10:01:00Z" }),
    ].join("\n") + "\n";
    writeFileSync(second, lines, "utf8");
    ageFiles(projects, 60 * 60 * 1000);

    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    // Classify the two files with disjoint entity-sets by path.
    const classify = async (text: string) => ({
      label: "L", summary: "S",
      entities: text.includes("unrelated") ? ["OtherTopic"] : ["NLM"],
      decisions: [], open: [], confidence: 0.9, facts: [],
    });
    const proxy: import("../../src/ports/llm-client.js").LLMClient = {
      embed: async () => { throw new Error("not used"); },
      rewriteForRecall: async () => { throw new Error("not used"); },
      nameWorkstream: async () => { throw new Error("stub"); },
      classify,
    };
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier: proxy, embedder: null, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(2);

    const c = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM session_edges WHERE kind = 'continues'")
      .get();
    expect(c?.c).toBe(0);
  });

  it("classifier failure is contained — chunk skipped, ingest continues", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier(undefined, true);
    const messages: string[] = [];
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null,
      logger: (m) => messages.push(m),
    });
    const report = await scheduler.tick();
    expect(report.classifyFailures).toBe(1);
    expect(report.inserted).toBe(0);
    expect(messages.some((m) => m.includes("classifier"))).toBe(true);
  });

  it("mechanical re-ingest wires a 'replaces' edge + flips prior status to 'replaced' when a file grows", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    const firstReport = await scheduler.tick();
    expect(firstReport.inserted).toBe(1);
    const firstId = store.rawDb()
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;

    // Append + age + change runtime_session_id so the parser yields a new id
    const fixturePath = join(projects, "project_a", "fixture.jsonl");
    const { readFileSync, writeFileSync, utimesSync } = require("node:fs") as typeof import("node:fs");
    const original = readFileSync(fixturePath, "utf8");
    const mutated = original
      .replace(/"sessionId"\s*:\s*"[^"]+"/g, '"sessionId": "resumed-uuid-12345"') +
      JSON.stringify({ type: "user", message: { content: "more work" }, timestamp: "2026-05-19T11:00:00Z" }) + "\n";
    writeFileSync(fixturePath, mutated);
    const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, oldT, oldT);

    const secondReport = await scheduler.tick();
    expect(secondReport.inserted).toBe(1);

    const db = store.rawDb();
    const edges = db.prepare<[], { from_session: string; to_session: string; kind: string }>(
      "SELECT from_session, to_session, kind FROM session_edges",
    ).all();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("replaces");
    expect(edges[0]?.to_session).toBe(firstId);

    const priorStatus = db.prepare<[string], { status: string }>(
      "SELECT status FROM sessions WHERE id = ?",
    ).get(firstId);
    expect(priorStatus?.status).toBe("replaced");
  });

  it("a grown transcript re-ingested under the same id does not supersede itself", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    const db = store.rawDb();
    const firstId = db
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;

    // Grow the file WITHOUT changing the sessionId — the parser yields the same
    // deterministic id, so the resumed session would otherwise supersede itself.
    const fixturePath = join(projects, "project_a", "fixture.jsonl");
    const { readFileSync, writeFileSync, utimesSync } = require("node:fs") as typeof import("node:fs");
    const grown = readFileSync(fixturePath, "utf8") +
      JSON.stringify({ type: "user", message: { content: "more work" }, timestamp: "2026-05-19T11:00:00Z" }) + "\n";
    writeFileSync(fixturePath, grown);
    const oldT = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(fixturePath, oldT, oldT);

    const second = await scheduler.tick();
    expect(second.inserted).toBe(1);

    const selfEdges = db.prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM session_edges WHERE from_session = to_session AND kind = 'supersedes'",
    ).get();
    expect(selfEdges?.c).toBe(0);
    const status = db.prepare<[string], { status: string }>(
      "SELECT status FROM sessions WHERE id = ?",
    ).get(firstId);
    expect(status?.status).toBe("closed");
  });

  it("re-ingest of the same session updates row in place (no duplicates)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    // Reset adapter_state to force re-ingest of the same file
    store.rawDb().prepare("DELETE FROM adapter_state").run();
    const second = await scheduler.tick();
    expect(second.inserted).toBe(1);
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions").get();
    expect(count?.c).toBe(1);
  });

  it("writes facts atomically with the session row when a FactStore is configured (B.2)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "Stub label",
      summary: "Stub summary",
      entities: ["NLM"],
      decisions: ["chose Hono"],
      open: [],
      confidence: 0.9,
      facts: [
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
        {
          kind: "attribute",
          subject: "local-llm-host",
          predicate: "endpoint",
          value: "http://macpro:8080/v1",
        },
      ],
    });
    const factStore = storage.facts;
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, factStore, logger: () => {},
    });
    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const sessId = store.rawDb()
      .prepare<[], { session_id: string }>(
        "SELECT session_id FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get()!.session_id;
    const facts = await factStore.listBySession("team_local", sessId);
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => `${f.subject}:${f.predicate}:${f.value}`).sort()).toEqual([
      "local-llm-host:endpoint:http://macpro:8080/v1",
      "nlm-memory-ts:framework:Hono",
    ]);
    for (const f of facts) {
      expect(f.sourceSessionId).toBe(sessId);
      expect(f.confidence).toBe(0.9);
      expect(f.supersededBy).toBeNull();
    }
  });

  it("does not write facts when FactStore is not provided (backwards compat)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [{ kind: "decision", subject: "x", predicate: "framework", value: "y" }],
    });
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM facts").get();
    expect(count?.c).toBe(0);
  });

  it("writes fact embeddings when both FactStore and embedder are configured (B.3)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [
        { kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" },
        { kind: "attribute", subject: "mac-pro", predicate: "endpoint", value: "http://macpro:8080/v1" },
      ],
    });
    const embedder = new StubEmbedder();
    const factStore = storage.facts;
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder, factStore, logger: () => {},
    });
    await scheduler.tick();
    // session embedding (1) + per-fact embeddings (2) = 3 calls
    expect(embedder.calls).toBe(3);
    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM fact_embeddings").get();
    expect(count?.c).toBe(2);
  });

  it("classifier failure increments failure_count in adapter_state", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier(undefined, true);
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, logger: () => {},
    });
    await scheduler.tick();
    const row = store.rawDb()
      .prepare<[], { failure_count: number }>(
        "SELECT COALESCE(failure_count, 0) AS failure_count FROM adapter_state WHERE adapter_name = 'claude-code'",
      ).get();
    expect(row?.failure_count).toBe(1);
  });

  it("file is skipped on next tick once failure_count reaches ceiling", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const failClassifier = new StubClassifier(undefined, true);
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier: failClassifier, embedder: null, logger: () => {},
    });
    // Drive failure_count to the ceiling
    for (let i = 0; i < MAX_CLASSIFY_FAILURES; i++) {
      store.rawDb().prepare(
        "UPDATE adapter_state SET failure_count = ?, file_size = file_size - 1 WHERE adapter_name = 'claude-code'",
      ).run(i);
      await scheduler.tick();
    }
    // Now failure_count === MAX_CLASSIFY_FAILURES and file_size matches disk — next tick should skip
    const db = store.rawDb();
    db.prepare(
      "UPDATE adapter_state SET file_size = (SELECT size FROM (SELECT ? AS size)), failure_count = ?",
    );
    // Reset: set file_size to actual disk size so scanOnce sees "unchanged"
    const { statSync: ss } = require("node:fs") as typeof import("node:fs");
    const filePath = join(projects, "project_a", "fixture.jsonl");
    const realSize = ss(filePath).size;
    db.prepare(
      "UPDATE adapter_state SET file_size = ?, failure_count = ? WHERE adapter_name = 'claude-code'",
    ).run(realSize, MAX_CLASSIFY_FAILURES);

    const skipReport = await scheduler.tick();
    expect(skipReport.chunksSeen).toBe(0);
    expect(skipReport.classifyFailures).toBe(0);
  });

  it("re-ingest replaces facts (no duplicate fact rows across ticks)", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier({
      label: "L", summary: "S", entities: [], decisions: [], open: [], confidence: 0.9,
      facts: [{ kind: "decision", subject: "nlm-memory-ts", predicate: "framework", value: "Hono" }],
    });
    const factStore = storage.facts;
    const scheduler = new ScanScheduler({
      store, adapters: [adapter], classifier, embedder: null, factStore, logger: () => {},
    });
    await scheduler.tick();
    store.rawDb().prepare("DELETE FROM adapter_state").run();
    await scheduler.tick();

    const count = store.rawDb()
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM facts").get();
    expect(count?.c).toBe(1);
  });

  it("oversized session (90K chars) routes through classifyAdaptive - classifier called >1 time and session row inserted", async () => {
    // Build a fixture directory with a fake oversized JSONL transcript
    const oversizedProjects = join(tmp, "oversized_projects");
    mkdirSync(join(oversizedProjects, "project_oversized"), { recursive: true });

    // Write a minimal JSONL that will parse into a session with a 90K-char body
    const oversizedBody = "x".repeat(90_000);
    const jsonlLines = [
      JSON.stringify({ type: "summary", summary: { sessionId: "oversized-session-uuid" } }),
      JSON.stringify({ type: "user", message: { content: oversizedBody }, timestamp: "2026-05-19T10:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: "response" }, timestamp: "2026-05-19T10:01:00Z" }),
    ].join("\n") + "\n";
    const oversizedFixture = join(oversizedProjects, "project_oversized", "oversized.jsonl");
    writeFileSync(oversizedFixture, jsonlLines, "utf8");
    ageFiles(oversizedProjects, 60 * 60 * 1000);

    // Spy classifier counts calls and returns a valid result each time
    let classifyCalls = 0;
    const spyClassifier: import("../../src/ports/llm-client.js").LLMClient = {
      embed: async () => { throw new Error("not used"); },
      rewriteForRecall: async () => { throw new Error("not used"); },
      nameWorkstream: async () => { throw new Error("stub"); },
      classify: async (_text: string) => {
        classifyCalls += 1;
        return {
          label: "Oversized label",
          summary: "Oversized summary",
          entities: ["BigSession"],
          decisions: [],
          open: [],
          confidence: 0.9,
          facts: [],
        };
      },
    };

    const adapter = new ClaudeCodeAdapter({ projectsPath: oversizedProjects, idleMinutes: 15 });
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier: spyClassifier,
      embedder: null,
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);
    // > 1 proves the 90K body was chunked (routed through classifyLarge): a
    // single-pass classify would be exactly 1 call. Depends on the adapter
    // yielding a >40K-char chunk from this fixture.
    expect(classifyCalls).toBeGreaterThan(1);

    const db = store.rawDb();
    const sess = db.prepare<[], { id: string; label: string }>("SELECT id, label FROM sessions").all();
    expect(sess).toHaveLength(1);
    expect(sess[0]?.label).toBe("Oversized label");
  });

  describe("pruneReverted in exemplar sweep", () => {
    const SCOPE = "test-scope";

    async function insertExemplar(storage: SqliteStorage, survived: 0 | 1 | null, code: string): Promise<string> {
      const { codeHash } = await import("../../src/core/exemplars/ingest-exemplar.js");
      const { id } = await storage.exemplars.insert({
        installScope: SCOPE,
        signalId: null,
        sessionId: null,
        repo: "/repo/test",
        model: "test-model",
        lang: "ts",
        taskContext: "ctx",
        code,
        codeHash: codeHash(code),
        outcome: "pass",
        gitSha: null,
        survived,
        scope: null,
        ts: "2026-06-15T12:00:00.000Z",
      });
      return id;
    }

    it("prunes survived=0 exemplars and leaves survived=null and survived=1 untouched", async () => {
      const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
      const classifier = new StubClassifier();
      const messages: string[] = [];
      const scheduler = new ScanScheduler({
        store,
        adapters: [adapter],
        classifier,
        embedder: null,
        exemplarStore: storage.exemplars,
        installScope: SCOPE,
        logger: (m) => messages.push(m),
      });

      const revertedId = await insertExemplar(storage, 0, "const reverted = 0;");
      const nullId = await insertExemplar(storage, null, "const nulled = 1;");
      const survivedId = await insertExemplar(storage, 1, "const survived = 2;");

      const origEnv = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
      try {
        await scheduler.tick();
      } finally {
        if (origEnv === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
        else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = origEnv;
      }

      expect(await storage.exemplars.getById(revertedId)).toBeNull();
      expect(await storage.exemplars.getById(nullId)).not.toBeNull();
      expect(await storage.exemplars.getById(survivedId)).not.toBeNull();
      expect(messages.some((m) => m.includes("pruneReverted") && m.includes("deleted 1"))).toBe(true);
    });

    it("does not log when no reverted exemplars exist", async () => {
      const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
      const classifier = new StubClassifier();
      const messages: string[] = [];
      const scheduler = new ScanScheduler({
        store,
        adapters: [adapter],
        classifier,
        embedder: null,
        exemplarStore: storage.exemplars,
        installScope: SCOPE,
        logger: (m) => messages.push(m),
      });

      await insertExemplar(storage, null, "const x = 1;");
      await insertExemplar(storage, 1, "const y = 2;");

      const origEnv = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
      process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
      try {
        await scheduler.tick();
      } finally {
        if (origEnv === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
        else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = origEnv;
      }

      expect(messages.some((m) => m.includes("pruneReverted"))).toBe(false);
    });
  });

  it("writes classifier provenance when classifierDescriptor is provided", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 15 });
    const classifier = new StubClassifier();
    const scheduler = new ScanScheduler({
      store,
      adapters: [adapter],
      classifier,
      embedder: null,
      classifierDescriptor: { provider: "ollama", model: "deepseek-r1:7b" },
      logger: () => {},
    });

    const report = await scheduler.tick();
    expect(report.inserted).toBe(1);

    const db = store.rawDb();
    const row = db.prepare<[], {
      classifier_provider: string | null;
      classifier_model: string | null;
      classifier_confidence: number | null;
    }>("SELECT classifier_provider, classifier_model, classifier_confidence FROM sessions").get();
    expect(row?.classifier_provider).toBe("ollama");
    expect(row?.classifier_model).toBe("deepseek-r1:7b");
    expect(row?.classifier_confidence).toBeCloseTo(0.9);
  });
});
