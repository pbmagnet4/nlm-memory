/**
 * Chunk-embed atomicity and retry: a chunk whose embed fails is persisted in
 * chunk_embed_pending and repaired by the sweep; the vector + map pair is one
 * transaction; `doctor --fix` removes map-less vectors (I7b-1).
 * Real SQLite + sqlite-vec; a stub LLMClient stands in for the embedder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import {
  MAX_CHUNK_EMBED_ATTEMPTS,
  stuckChunksOnSqlite,
  sweepChunkEmbeddings,
} from "../../src/core/embedding/chunk-retry.js";
import { applyFixOnSqlite, runChecksOnSqlite } from "../../src/core/integrity/check-invariants.js";
import { resetForTests as resetInflight } from "../../src/core/health/embed-inflight.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function vec(seed: number): Float32Array {
  const v = new Float32Array(768);
  v[seed % 768] = 1;
  return v;
}

class StubEmbedder {
  calls = 0;
  failing = false;
  async embed(_text: string, _role: string): Promise<{ vector: Float32Array; dim: number }> {
    this.calls += 1;
    if (this.failing) throw new LLMUnreachableError("embedder unreachable");
    return { vector: vec(this.calls), dim: 768 };
  }
}

function record(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt: "2026-10-01T00:00:00Z",
    endedAt: "2026-10-01T00:05:00Z",
    durationMin: 5,
    label: "L",
    summary: "S",
    body: "a short body that makes exactly one chunk",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe("chunk embed atomicity, retry and I7b-1 repair", () => {
  let dir: string;
  let storage: SqliteStorage;
  const embedder = new StubEmbedder();
  const later = (hours: number) => () => new Date(Date.now() + hours * 3_600_000);
  const count = (table: string) =>
    (storage.rawDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const ingest = (id: string) =>
    storage.sessions.insertSession("team_local", record(id), embedder as never, null);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nlm-chunk-retry-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    embedder.calls = 0;
    embedder.failing = false;
    resetInflight();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a failing map insert rolls the vector back instead of orphaning it", () => {
    // no such session: the map row's foreign key fails after the vector went in
    expect(() => storage.sessions.insertChunkEmbedding("ghost-session", 0, vec(1))).toThrow();
    expect(count("session_embedding_chunks_rowids")).toBe(0);
    expect(runChecksOnSqlite(storage.rawDb()).find((v) => v.id === "I7b-1")).toBeUndefined();
  });

  it("a sweep insert for a chunk that was mapped meanwhile adds no duplicate vector and clears the retry record", async () => {
    await ingest("s1");
    storage.sessions.markChunkEmbedPending("s1", 0, "raced");
    storage.sessions.insertChunkEmbedding("s1", 0, vec(5));
    expect(count("session_embedding_chunks_rowids")).toBe(1);
    expect(count("session_chunk_map")).toBe(1);
    expect(count("chunk_embed_pending")).toBe(0);
  });

  it("embedder down at ingest: no vec row, chunk enqueued; sweep embeds it on recovery", async () => {
    embedder.failing = true;
    await ingest("s1");
    expect(count("session_embedding_chunks_rowids")).toBe(0);
    expect(storage.rawDb().prepare("SELECT session_id, chunk_idx, attempts FROM chunk_embed_pending").all()).toEqual([
      { session_id: "s1", chunk_idx: 0, attempts: 1 },
    ]);

    // inside the backoff window nothing is retried
    expect(await sweepChunkEmbeddings({ store: storage.sessions, embedder: embedder as never })).toMatchObject({ attempted: 0 });

    embedder.failing = false;
    const report = await sweepChunkEmbeddings({ store: storage.sessions, embedder: embedder as never, now: later(1) });
    expect(report).toMatchObject({ attempted: 1, repaired: 1, failed: 0 });
    expect(count("session_embedding_chunks_rowids")).toBe(1);
    expect(count("session_chunk_map")).toBe(1);
    expect(count("chunk_embed_pending")).toBe(0);
    expect(runChecksOnSqlite(storage.rawDb()).find((v) => v.id === "I7b-1")).toBeUndefined();
  });

  it("a chunk failing 5 times stays pending, is no longer retried, and is reported", async () => {
    embedder.failing = true;
    await ingest("s1");
    for (let i = 1; i < MAX_CHUNK_EMBED_ATTEMPTS; i++) {
      const r = await sweepChunkEmbeddings({ store: storage.sessions, embedder: embedder as never, now: later(24 * i) });
      expect(r).toMatchObject({ attempted: 1, failed: 1 });
    }
    expect(stuckChunksOnSqlite(storage.rawDb())).toMatchObject([{ sessionId: "s1", chunkIdx: 0, attempts: MAX_CHUNK_EMBED_ATTEMPTS }]);

    embedder.failing = false;
    const after = await sweepChunkEmbeddings({ store: storage.sessions, embedder: embedder as never, now: later(24 * 10) });
    expect(after.attempted).toBe(0);
    expect(count("chunk_embed_pending")).toBe(1);
  });

  it("re-ingest drops the session's stale pending rows", async () => {
    embedder.failing = true;
    await ingest("s1");
    embedder.failing = false;
    await ingest("s1");
    expect(count("chunk_embed_pending")).toBe(0);
    expect(count("session_chunk_map")).toBe(1);
  });

  it("doctor --fix deletes map-less chunk vectors and keeps mapped ones", async () => {
    await ingest("s1");
    await ingest("s2");
    await ingest("s3");
    const db = storage.rawDb();
    const blob = Buffer.alloc(768 * 4);
    const orphan = Number(
      db.prepare("INSERT INTO session_embedding_chunks (embedding, session_id, chunk_idx) VALUES (?, ?, ?)").run(blob, "s1", BigInt(7)).lastInsertRowid,
    );
    expect(runChecksOnSqlite(db).find((v) => v.id === "I7b-1")?.count).toBe(1);

    const report = applyFixOnSqlite(db);
    expect(report.deletedOrphanChunkIds).toEqual([orphan]);
    expect(runChecksOnSqlite(db).find((v) => v.id === "I7b-1")).toBeUndefined();
    expect(count("session_chunk_map")).toBe(3);
    expect(count("session_embedding_chunks_rowids")).toBe(3);
    expect(applyFixOnSqlite(db).deletedOrphanChunkIds).toEqual([]);
  });
});
