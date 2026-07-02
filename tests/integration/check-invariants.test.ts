/**
 * check-invariants — SQLite backend: seed violation shapes → detected; clean
 * DB → all pass; --fix repairs I1+I2 and is idempotent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import {
  runChecksOnSqlite,
  runCheapChecksOnSqlite,
  applyFixOnSqlite,
} from "../../src/core/integrity/check-invariants.js";
import { makeSession } from "../fixtures/sessions.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("check-invariants (SQLite)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-invariants-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clean DB passes all checks", () => {
    store.insertSessionForTest(makeSession({ id: "s1" }));
    store.insertSessionForTest(makeSession({ id: "s2" }));
    const violations = runChecksOnSqlite(store.rawDb());
    expect(violations).toHaveLength(0);
  });

  describe("I1: self-loop edges", () => {
    it("detects self-loop edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i1 = violations.find((v) => v.id === "I1");
      expect(i1).toBeDefined();
      expect(i1!.count).toBe(1);
      expect(i1!.sampleIds).toContain("s1");
    });

    it("does not flag normal supersedes edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I1")).toBeUndefined();
    });
  });

  describe("I2 — orphaned superseded sessions", () => {
    it("detects superseded session with no incoming edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      const violations = runChecksOnSqlite(store.rawDb());
      const i2 = violations.find((v) => v.id === "I2");
      expect(i2).toBeDefined();
      expect(i2!.count).toBe(1);
      expect(i2!.sampleIds).toContain("s1");
    });

    it("does not flag superseded session with real incoming edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I2")).toBeUndefined();
    });

    it("I2 matches kind: superseded with only a replaces edge is a violation", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i2 = violations.find((v) => v.id === "I2");
      expect(i2).toBeDefined();
      expect(i2!.sampleIds).toContain("s1");
    });
  });

  describe("I2r — orphaned replaced sessions", () => {
    it("detects replaced session with no incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      const violations = runChecksOnSqlite(store.rawDb());
      const i2r = violations.find((v) => v.id === "I2r");
      expect(i2r).toBeDefined();
      expect(i2r!.sampleIds).toContain("s1");
    });

    it("does not flag replaced session with real incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I2r")).toBeUndefined();
    });

    it("I2r matches kind: replaced with only a supersedes edge is a violation", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      const i2r = violations.find((v) => v.id === "I2r");
      expect(i2r).toBeDefined();
      expect(i2r!.sampleIds).toContain("s1");
    });
  });

  describe("I3 — cycle detection", () => {
    it("detects cycle in supersedes graph", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s3", "s2");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s1", "s3");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeDefined();
    });

    it("does not flag acyclic graph", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s3", "s2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeUndefined();
    });

    it("detects cycle across mixed supersedes/replaces edges", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.insertSessionForTest(makeSession({ id: "s3" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s2", "s1");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')").run("s3", "s2");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')").run("s1", "s3");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I3")).toBeDefined();
    });
  });

  describe("I4 — dangling edge endpoints", () => {
    it("detects edge referencing missing session", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      // Temporarily disable FK checks to seed a corrupted state that the
      // integrity check is designed to detect.
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "ghost-id");
      db.pragma("foreign_keys = ON");
      const violations = runChecksOnSqlite(store.rawDb());
      const i4 = violations.find((v) => v.id === "I4");
      expect(i4).toBeDefined();
      expect(i4!.sampleIds).toContain("ghost-id");
    });
  });

  describe("I5 — facts integrity", () => {
    it("detects duplicate active facts for same (subject, predicate)", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0)`).run("f1");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'blue', 's1', 1.0)`).run("f2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5a")).toBeDefined();
    });

    it("detects fact with dangling superseded_by reference", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      // Temporarily disable FK checks to seed a corrupted state that the
      // integrity check is designed to detect.
      db.pragma("foreign_keys = OFF");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, superseded_by)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0, 'nonexistent-fact-id')`).run("f1");
      db.pragma("foreign_keys = ON");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5b")).toBeDefined();
    });

    it("does not flag facts with valid superseded_by", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0)`).run("f1");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, superseded_by)
        VALUES (?, 'attribute', 'x', 'color', 'blue', 's1', 1.0, 'f1')`).run("f2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5a")).toBeUndefined();
      expect(violations.find((v) => v.id === "I5b")).toBeUndefined();
    });

    it("does not flag a duplicate that has been retired (retired_at set)", () => {
      // supersede_fact retires a fact by setting retired_at while leaving
      // superseded_by NULL. A retired fact is recall-ineligible (fact-recall
      // excludes it), so it must not count as an active duplicate — otherwise
      // retiring one of two duplicates can never clear the I5a violation.
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 'x', 'color', 'red', 's1', 1.0)`).run("f1");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, retired_at)
        VALUES (?, 'attribute', 'x', 'color', 'blue', 's1', 1.0, '2026-06-22T00:00:00Z')`).run("f2");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I5a")).toBeUndefined();
    });
  });

  describe("I6 — adapter_state orphan references", () => {
    it("detects adapter_state.session_id referencing missing session", () => {
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, session_id) VALUES (?, ?, ?)`)
        .run("claude-code", "/path/to/file.jsonl", "ghost-session-id");
      const violations = runChecksOnSqlite(store.rawDb());
      const i6 = violations.find((v) => v.id === "I6");
      expect(i6).toBeDefined();
      expect(i6!.sampleIds).toContain("ghost-session-id");
    });

    it("does not flag adapter_state.session_id pointing to real session", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path, session_id) VALUES (?, ?, ?)`)
        .run("claude-code", "/path/to/file.jsonl", "s1");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I6")).toBeUndefined();
    });

    it("does not flag adapter_state rows with null session_id", () => {
      const db = store.rawDb();
      db.prepare(`INSERT INTO adapter_state (adapter_name, source_path) VALUES (?, ?)`)
        .run("claude-code", "/path/to/file.jsonl");
      const violations = runChecksOnSqlite(store.rawDb());
      expect(violations.find((v) => v.id === "I6")).toBeUndefined();
    });
  });

  describe("--fix: applyFix", () => {
    it("deletes self-loop edges (I1 repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.deletedSelfLoops).toBe(1);
      const remaining = store.rawDb()
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM session_edges WHERE from_session = to_session")
        .get();
      expect(remaining?.n).toBe(0);
    });

    it("restores orphaned superseded sessions to closed (I2 repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(1);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("closed");
    });

    it("restores orphaned replaced sessions to closed (I2r repair)", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(1);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("closed");
    });

    it("does not restore replaced session with real incoming replaces edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "replaced" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'replaces')")
        .run("s2", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(0);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("replaced");
    });

    it("does not restore session with real incoming supersedes edge", () => {
      store.insertSessionForTest(makeSession({ id: "s1", status: "superseded" }));
      store.insertSessionForTest(makeSession({ id: "s2" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s2", "s1");
      const report = applyFixOnSqlite(store.rawDb());
      expect(report.restoredToClosed).toBe(0);
      const row = store.rawDb()
        .prepare<[], { status: string }>("SELECT status FROM sessions WHERE id = 's1'")
        .get();
      expect(row?.status).toBe("superseded");
    });

    it("is idempotent: running fix twice reports 0 changes on second run", () => {
      store.insertSessionForTest(makeSession({ id: "s1" }));
      store.rawDb()
        .prepare("INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')")
        .run("s1", "s1");
      store.insertSessionForTest(makeSession({ id: "s2", status: "superseded" }));
      applyFixOnSqlite(store.rawDb());
      const second = applyFixOnSqlite(store.rawDb());
      expect(second.deletedSelfLoops).toBe(0);
      expect(second.restoredToClosed).toBe(0);
    });
  });

  describe("I5c — fact supersedence cycles", () => {
    it("detects a 2-cycle in facts.superseded_by", async () => {
      store.insertSessionForTest(makeSession({ id: "sessF" }));
      await storage.facts.insert(makeFact({ id: "fa", subject: "s", predicate: "p", sourceSessionId: "sessF" }));
      await storage.facts.insert(makeFact({ id: "fb", subject: "s", predicate: "q", sourceSessionId: "sessF" }));
      const db = store.rawDb();
      db.prepare("UPDATE facts SET superseded_by = 'fb' WHERE id = 'fa'").run();
      db.prepare("UPDATE facts SET superseded_by = 'fa' WHERE id = 'fb'").run();
      const violations = runChecksOnSqlite(db);
      expect(violations.some((v) => v.id === "I5c")).toBe(true);
    });

    it("does not flag a clean (acyclic) supersedence chain", async () => {
      store.insertSessionForTest(makeSession({ id: "sessG" }));
      await storage.facts.insert(makeFact({ id: "g1", subject: "s", predicate: "p", sourceSessionId: "sessG" }));
      await storage.facts.insert(makeFact({ id: "g2", subject: "s", predicate: "p", sourceSessionId: "sessG" }));
      // g1 superseded by g2 (normal), g2 active — no cycle.
      store.rawDb().prepare("UPDATE facts SET superseded_by = 'g2' WHERE id = 'g1'").run();
      expect(runChecksOnSqlite(store.rawDb()).some((v) => v.id === "I5c")).toBe(false);
    });
  });

  describe("I7: ghost fact embeddings", () => {
    function seedEmbedding(factId: string): void {
      const blob = Buffer.alloc(768 * 4);
      store
        .rawDb()
        .prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)")
        .run(factId, blob);
    }

    it("flags an embedding whose fact was superseded without cleanup", () => {
      store.insertSessionForTest(makeSession({ id: "s_i7a" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p', 'old', 's_i7a', 1.0)`).run("f_ghost_sup");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p', 'new', 's_i7a', 1.0)`).run("f_live_sup");
      seedEmbedding("f_ghost_sup");
      db.prepare("UPDATE facts SET superseded_by = 'f_live_sup' WHERE id = 'f_ghost_sup'").run();
      const violations = runChecksOnSqlite(db);
      const i7 = violations.find((v) => v.id === "I7");
      expect(i7).toBeDefined();
      expect(i7!.count).toBeGreaterThanOrEqual(1);
      expect(i7!.sampleIds).toContain("f_ghost_sup");
    });

    it("flags an embedding whose fact is retired", () => {
      store.insertSessionForTest(makeSession({ id: "s_i7b" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_ret', 'v', 's_i7b', 1.0)`).run("f_ret");
      seedEmbedding("f_ret");
      db.prepare("UPDATE facts SET retired_at = '2026-01-01T00:00:00Z' WHERE id = 'f_ret'").run();
      const violations = runChecksOnSqlite(db);
      const i7 = violations.find((v) => v.id === "I7");
      expect(i7).toBeDefined();
      expect(i7!.sampleIds).toContain("f_ret");
    });

    it("flags an embedding with no facts row at all (sqlite only; pg FK forbids)", () => {
      seedEmbedding("f_orphan");
      const violations = runChecksOnSqlite(store.rawDb());
      const i7 = violations.find((v) => v.id === "I7");
      expect(i7).toBeDefined();
      expect(i7!.sampleIds).toContain("f_orphan");
    });

    it("does not flag an embedding with a live parent fact", () => {
      store.insertSessionForTest(makeSession({ id: "s_i7_clean" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_live', 'v', 's_i7_clean', 1.0)`).run("f_live_clean");
      seedEmbedding("f_live_clean");
      expect(runChecksOnSqlite(db).find((v) => v.id === "I7")).toBeUndefined();
    });

    it("--fix deletes exactly the violating embedding rows and is idempotent", () => {
      store.insertSessionForTest(makeSession({ id: "s_i7_fix" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_live', 'v', 's_i7_fix', 1.0)`).run("f_live_i7");
      seedEmbedding("f_live_i7");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_sup', 'old', 's_i7_fix', 1.0)`).run("f_sup_i7");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_sup', 'new', 's_i7_fix', 1.0)`).run("f_sup_new_i7");
      seedEmbedding("f_sup_i7");
      db.prepare("UPDATE facts SET superseded_by = 'f_sup_new_i7' WHERE id = 'f_sup_i7'").run();
      seedEmbedding("f_orphan_i7");

      const report = applyFixOnSqlite(db);
      expect(report.deletedGhostEmbeddings).toBe(2);

      const badCount = db
        .prepare<[], { n: number }>(`
          SELECT COUNT(*) AS n
          FROM fact_embeddings_rowids r
          LEFT JOIN facts f ON f.id = r.id
          WHERE f.id IS NULL OR f.superseded_by IS NOT NULL OR f.retired_at IS NOT NULL
        `)
        .get();
      expect(badCount?.n).toBe(0);

      const liveRow = db
        .prepare<[], { id: string }>("SELECT id FROM fact_embeddings_rowids WHERE id = 'f_live_i7'")
        .get();
      expect(liveRow).toBeDefined();

      const second = applyFixOnSqlite(db);
      expect(second.deletedGhostEmbeddings).toBe(0);
    });
  });

  describe("I7b chunk ghost invariants", () => {
    it("I7b-1 fires when a chunk has no map row", () => {
      const db = store.rawDb();
      const blob = Buffer.alloc(768 * 4);
      db.prepare("INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)").run(blob, "orphan-session", BigInt(0));
      const violations = runChecksOnSqlite(db);
      const v = violations.find((v) => v.id === "I7b-1");
      expect(v).toBeDefined();
      expect(v!.count).toBeGreaterThanOrEqual(1);
    });

    it("I7b-1 does not fire when all chunks have map entries", () => {
      store.insertSessionForTest(makeSession({ id: "s_chunk_clean" }));
      const db = store.rawDb();
      const blob = Buffer.alloc(768 * 4);
      const info = db.prepare("INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)").run(blob, "s_chunk_clean", BigInt(0));
      const chunkId = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)").run(chunkId, "s_chunk_clean", 0);
      const violations = runChecksOnSqlite(db);
      expect(violations.find((v) => v.id === "I7b-1")).toBeUndefined();
    });

    it("I7b-2 fires when a map row references a missing session", () => {
      const db = store.rawDb();
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)").run(9999, "ghost-session-i7b2", 0);
      db.pragma("foreign_keys = ON");
      const violations = runChecksOnSqlite(db);
      const v = violations.find((v) => v.id === "I7b-2");
      expect(v).toBeDefined();
      expect(v!.count).toBeGreaterThanOrEqual(1);
      expect(v!.sampleIds).toContain("ghost-session-i7b2");
    });

    it("I7b-2 does not fire when all map rows have valid sessions", () => {
      store.insertSessionForTest(makeSession({ id: "s_map_valid" }));
      const db = store.rawDb();
      db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)").run(1, "s_map_valid", 0);
      const violations = runChecksOnSqlite(db);
      expect(violations.find((v) => v.id === "I7b-2")).toBeUndefined();
    });
  });

  describe("runCheapChecksOnSqlite: I7 in cheap subset", () => {
    function seedEmbedding(db: ReturnType<typeof store.rawDb>, factId: string): void {
      const blob = Buffer.alloc(768 * 4);
      db.prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)").run(factId, blob);
    }

    it("reports I7 when a superseded ghost embedding exists", () => {
      store.insertSessionForTest(makeSession({ id: "s_cheap_i7" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p', 'old', 's_cheap_i7', 1.0)`).run("f_ghost_cheap");
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p', 'new', 's_cheap_i7', 1.0)`).run("f_live_cheap");
      seedEmbedding(db, "f_ghost_cheap");
      db.prepare("UPDATE facts SET superseded_by = 'f_live_cheap' WHERE id = 'f_ghost_cheap'").run();
      const violations = runCheapChecksOnSqlite(db);
      const i7 = violations.find((v) => v.id === "I7");
      expect(i7).toBeDefined();
      expect(i7!.sampleIds).toContain("f_ghost_cheap");
    });

    it("does not report I7 when all embeddings have live parent facts", () => {
      store.insertSessionForTest(makeSession({ id: "s_cheap_clean" }));
      const db = store.rawDb();
      db.prepare(`INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)
        VALUES (?, 'attribute', 's', 'p_clean', 'v', 's_cheap_clean', 1.0)`).run("f_clean_cheap");
      seedEmbedding(db, "f_clean_cheap");
      const violations = runCheapChecksOnSqlite(db);
      expect(violations.find((v) => v.id === "I7")).toBeUndefined();
    });
  });
});
