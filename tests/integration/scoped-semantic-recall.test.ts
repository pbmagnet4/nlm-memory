import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { makeSession } from "../fixtures/sessions.js";
import { makeFact } from "../fixtures/facts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import { runScopedSemanticRecallContract } from "../contract/scoped-semantic-recall.contract.js";

const dirs = new WeakMap<Storage, string>();
runScopedSemanticRecallContract({
  name: "SQLite",
  async setup() {
    const dir = mkdtempSync(join(tmpdir(), "nlm-semantic-"));
    const storage = SqliteStorage.create({ dbPath: join(dir, "corpus.sqlite"), migrationsDir: resolve("migrations") });
    await storage.init();
    dirs.set(storage, dir);
    return storage;
  },
  async teardown(storage) {
    await storage.close();
    rmSync(dirs.get(storage)!, { recursive: true, force: true });
  },
  async foreignTeam(storage) {
    (storage as SqliteStorage).rawDb().prepare("INSERT INTO teams (id, name) VALUES (?, ?)").run("team_foreign", "Foreign");
  },
  async seedSession(storage, session, tenantId) {
    (storage as SqliteStorage).sessions.insertSessionForTest(session, tenantId);
  },
  async seedChunk(storage, sessionId, chunkIndex, vector, mapped) {
    const db = (storage as SqliteStorage).rawDb();
    const row = db.prepare("INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding) VALUES (?, ?, ?)").run(sessionId, BigInt(chunkIndex), Buffer.from(vector.buffer));
    if (mapped) db.prepare("INSERT INTO session_chunk_map (chunk_id, session_id, chunk_idx) VALUES (?, ?, ?)").run(Number(row.lastInsertRowid), sessionId, chunkIndex);
  },
});

it.each(["session", "fact"] as const)("pins %s candidate distances and eligibility to one read snapshot", async (lane) => {
  const dir = mkdtempSync(join(tmpdir(), "nlm-semantic-snapshot-"));
  const dbPath = join(dir, "corpus.sqlite");
  const storage = SqliteStorage.create({ dbPath, migrationsDir: resolve("migrations") });
  const writer = new Database(dbPath);
  const db = storage.rawDb();
  let changed = false;
  const original = db.prepare.bind(db);
  try {
    for (const [index, id] of ["a", "b", "c"].entries()) {
      storage.sessions.insertSessionForTest(makeSession({ id }));
      const v = new Float32Array(768);
      v[0] = index + 1;
      db.prepare("INSERT INTO session_embedding_chunks (session_id, chunk_idx, embedding) VALUES (?, ?, ?)").run(id, 0n, Buffer.from(v.buffer));
      await storage.facts.insert("team_local", makeFact({ id, sourceSessionId: id }));
      await storage.facts.upsertEmbedding("team_local", id, v);
    }
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (!changed && sql.includes(lane === "session" ? "SELECT s.id FROM sessions s" : "SELECT f.id FROM facts f")) {
        expect(db.inTransaction).toBe(true);
        changed = true;
        writer.prepare(lane === "session" ? "UPDATE sessions SET status = 'superseded' WHERE id = 'a'" : "UPDATE facts SET retired_at = '2026-10-16T00:00:00Z' WHERE id = 'a'").run();
      }
      return original(sql);
    });
    const query = new Float32Array(768);
    const search = () => lane === "session" ? storage.sessions.semanticSearch("team_local", query, 1) : storage.facts.semanticSearch("team_local", query, 1);
    const first = await search();
    expect(changed).toBe(true);
    expect(first).toEqual([lane === "session" ? { sessionId: "a", chunkIndex: 0, distance: 1 } : { factId: "a", distance: 1 }]);
    spy.mockRestore();
    const next = await search();
    expect(next).toEqual([lane === "session" ? { sessionId: "b", chunkIndex: 0, distance: 2 } : { factId: "b", distance: 2 }]);
  } finally {
    vi.restoreAllMocks();
    writer.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
