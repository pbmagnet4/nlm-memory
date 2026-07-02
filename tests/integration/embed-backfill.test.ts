/**
 * Integration tests for embed-backfill against a real SQLite + sqlite-vec
 * store. No network: a deterministic fake LLMClient stands in for Ollama.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { reembedCorpus } from "../../src/core/embedding/embed-backfill.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unitWithLeading(value: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = value;
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] ?? 0) ** 2;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(768);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

class DeterministicEmbedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls += 1;
    // Stable, distinct, unit-length vectors per call
    return { vector: unitWithLeading(this.calls), model: "fake" };
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used in tests");
  }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

/** 8-dimensional stub embedder for rebuild tests. */
class Dim8Embedder implements LLMClient {
  calls = 0;
  async embed(): Promise<EmbedResult> {
    this.calls++;
    const v = new Float32Array(8);
    v[this.calls % 8] = 1;
    return { vector: v, model: "stub-8d" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used"); }
}

const seed: ReadonlyArray<Session> = [
  makeSession({ id: "s_a", label: "Hono setup", body: "wired Hono routes" }),
  makeSession({ id: "s_b", label: "pgvector plan", body: "drafted pgvector swap" }),
  makeSession({ id: "s_c", label: "tx tax county", body: "ingested county directory" }),
];

describe("reembedCorpus", () => {
  let tmp: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-emb-"));
    dbPath = join(tmp, "canonical.sqlite");
    statePath = join(tmp, "state.json");
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    for (const s of seed) {
      storage.sessions.insertSessionForTest(s);
      // seed each with a non-normalized vector so backfill has something to replace
      storage.sessions.insertEmbeddingForTest(s.id, new Float32Array(768).fill(0.5));
    }
    await storage.close();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("replaces every embedding and writes a state file", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath });
    expect(report.dbMissing).toBe(false);
    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.skippedAlreadyDone).toBe(0);
    // 1 probe call + 3 session embed calls (one chunk per short session)
    expect(embedder.calls).toBe(4);
    expect(existsSync(statePath)).toBe(true);
  });

  it("is resumable — second run skips ids already in state", async () => {
    const embedder1 = new DeterministicEmbedder();
    await reembedCorpus({ dbPath, embedder: embedder1, statePath });
    const embedder2 = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder: embedder2, statePath });
    expect(report.skippedAlreadyDone).toBe(3);
    expect(report.succeeded).toBe(0);
    // Only the probe call is made; all sessions are already done
    expect(embedder2.calls).toBe(1);
  });

  it("respects --limit", async () => {
    const embedder = new DeterministicEmbedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath, limit: 2 });
    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(2);
  });
});

describe("rebuild on dim mismatch", () => {
  let tmp: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-rebuild-"));
    dbPath = join(tmp, "canonical.sqlite");
    statePath = join(tmp, "state.json");
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    for (const s of seed) {
      storage.sessions.insertSessionForTest(s);
      storage.sessions.insertEmbeddingForTest(s.id, new Float32Array(768).fill(0.1));
    }
    await storage.close();
    // Insert a fact, its 768-dim embedding, and a 768-dim config row via raw SQL.
    const rawDb = new Database(dbPath);
    sqliteVec.load(rawDb);
    rawDb
      .prepare(
        "INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("f_1", "attribute", "project", "uses", "SQLite", "s_a", 0.9);
    const blob768 = Buffer.from(new Float32Array(768).fill(0.1).buffer);
    rawDb.prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)").run("f_1", blob768);
    rawDb
      .prepare(
        "INSERT INTO embedding_config (lane, provider, model, dim, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("prose", "test", "model-768", 768, new Date().toISOString());
    rawDb.close();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("drops and recreates vec tables on dim mismatch, reembeds sessions and facts", async () => {
    const embedder = new Dim8Embedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath, embedderProvider: "test" });

    expect(report.rebuilt).toBe(true);
    expect(report.succeeded).toBe(3);
    expect(report.factsReembedded).toBe(1);

    const db = new Database(dbPath);
    sqliteVec.load(db);

    // Session chunk embedding is now 8-dim (8 x float32 = 32 bytes).
    const chunkRow = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM session_embedding_chunks LIMIT 1")
      .get()!;
    expect(chunkRow.embedding.byteLength).toBe(8 * 4);

    // Fact embedding is now 8-dim.
    const factRow = db
      .prepare<[string], { embedding: Buffer }>(
        "SELECT embedding FROM fact_embeddings WHERE fact_id = ?",
      )
      .get("f_1")!;
    expect(factRow.embedding.byteLength).toBe(8 * 4);

    // Config row updated to dim=8 with the stub model/provider.
    const cfgRow = db
      .prepare<[], { dim: number; model: string; provider: string }>(
        "SELECT dim, model, provider FROM embedding_config WHERE lane='prose'",
      )
      .get()!;
    expect(cfgRow.dim).toBe(8);
    expect(cfgRow.model).toBe("stub-8d");
    expect(cfgRow.provider).toBe("test");

    db.close();
  });

  it("does not drop tables when config matches, leaves other session chunks intact", async () => {
    // First run: rebuilds from 768 to 8-dim and embeds all sessions + facts.
    const embedder1 = new Dim8Embedder();
    await reembedCorpus({ dbPath, embedder: embedder1, statePath, embedderProvider: "test" });

    const db = new Database(dbPath);
    sqliteVec.load(db);
    const countAfterRebuild = (
      db.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM session_chunk_map").get()!
    ).c;
    db.close();
    expect(countAfterRebuild).toBe(3);

    // Second run: same embedder config (8-dim, "stub-8d", "test") - no rebuild.
    // Reuse the same state file so all sessions are already done.
    const embedder2 = new Dim8Embedder();
    const report = await reembedCorpus({ dbPath, embedder: embedder2, statePath, embedderProvider: "test" });

    expect(report.rebuilt).toBe(false);
    expect(report.skippedAlreadyDone).toBe(3);
    expect(report.factsReembedded).toBe(0);

    // All chunks from the first run must still be present.
    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const countAfterSecond = (
      db2.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM session_chunk_map").get()!
    ).c;
    const feCount = (
      db2.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM fact_embeddings").get()!
    ).c;
    db2.close();

    expect(countAfterSecond).toBe(3);
    expect(feCount).toBe(1);
  });

  it("dry-run reports resume state when state file carries new config but embedding_config is stale", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify({
      done: ["s_a", "s_b", "s_c"],
      config: { provider: "test", model: "stub-8d", dim: 8 },
    }));

    const rawDb = new Database(dbPath);
    sqliteVec.load(rawDb);
    rawDb.exec("DROP TABLE IF EXISTS fact_embeddings");
    rawDb.exec(
      "CREATE VIRTUAL TABLE fact_embeddings USING vec0(fact_id TEXT PRIMARY KEY, embedding float[8])",
    );
    rawDb.close();

    const embedder = new Dim8Embedder();
    const report = await reembedCorpus({
      dbPath,
      embedder,
      statePath,
      embedderProvider: "test",
      dryRun: true,
    });

    expect(report.rebuilt).toBe(false);
    expect(report.dryRun).toBe(true);
    // factsReembedded reflects how many facts would be reembedded (1 seeded in beforeEach)
    expect(report.factsReembedded).toBe(1);
  });

  it("DELETE+INSERT counts correctly when fact already has an embedding (doubly-interrupted path)", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify({
      done: ["s_a", "s_b", "s_c"],
      config: { provider: "test", model: "stub-8d", dim: 8 },
    }));

    // Simulate a prior interrupted fact-reembed: tables already have 8-dim schema
    // and fact_embeddings already has the row (partial prior run wrote it).
    const rawDb = new Database(dbPath);
    sqliteVec.load(rawDb);
    rawDb.exec("DROP TABLE IF EXISTS fact_embeddings");
    rawDb.exec(
      "CREATE VIRTUAL TABLE fact_embeddings USING vec0(fact_id TEXT PRIMARY KEY, embedding float[8])",
    );
    const existingBlob = Buffer.from(new Float32Array(8).fill(0.99).buffer);
    rawDb.prepare("INSERT INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)").run("f_1", existingBlob);
    rawDb.close();

    const embedder = new Dim8Embedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath, embedderProvider: "test" });

    // DELETE+INSERT must count the fact even though a row already existed.
    expect(report.rebuilt).toBe(false);
    expect(report.factsReembedded).toBe(1);

    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const feCount = (
      db2.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM fact_embeddings").get()!
    ).c;
    db2.close();
    expect(feCount).toBe(1);
  });

  it("resume after interrupted rebuild: facts are reembedded even when state file has new config", async () => {
    // Simulate an interrupted rebuild:
    // - The state file already carries the new (8-dim) config (the rebuild saved it mid-run)
    // - The embedding_config row still holds the old (768-dim) config (final upsert never ran)
    // - fact_embeddings is empty (the DROP TABLE ran but the fact loop did not complete)
    // This state means storedConfig != runtimeConfig but stateConfigMatches=true,
    // so needsRebuild=false. The fix: gate fact reembed on storedConfig && !configMatch,
    // not on needsRebuild.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(statePath, JSON.stringify({
      done: ["s_a", "s_b", "s_c"],
      config: { provider: "test", model: "stub-8d", dim: 8 },
    }));

    // embedding_config is already at 768-dim from beforeEach, fact_embeddings has f_1 cleared.
    // Clear fact_embeddings to simulate the rebuild having dropped and recreated the table.
    const rawDb = new Database(dbPath);
    sqliteVec.load(rawDb);
    rawDb.exec("DROP TABLE IF EXISTS fact_embeddings");
    rawDb.exec(
      "CREATE VIRTUAL TABLE fact_embeddings USING vec0(fact_id TEXT PRIMARY KEY, embedding float[8])",
    );
    rawDb.close();

    const embedder = new Dim8Embedder();
    const report = await reembedCorpus({ dbPath, embedder, statePath, embedderProvider: "test" });

    expect(report.rebuilt).toBe(false);
    expect(report.factsReembedded).toBe(1);

    const db2 = new Database(dbPath);
    sqliteVec.load(db2);
    const feCount = (
      db2.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM fact_embeddings").get()!
    ).c;
    const cfgRow = db2
      .prepare<[], { dim: number }>("SELECT dim FROM embedding_config WHERE lane='prose'")
      .get()!;
    db2.close();

    expect(feCount).toBe(1);
    expect(cfgRow.dim).toBe(8);
  });
});
