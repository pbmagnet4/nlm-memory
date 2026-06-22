/**
 * SQLite-specific assertions that poke rawDb() to inspect internal state.
 *
 * These are NOT part of the FactStore contract. They verify SQLite-only
 * invariants (row counts in fact_embeddings) that a Postgres adapter would
 * verify against pg_class / its own embedding table, not against this code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteFactStore (SQLite-internal)", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-facts-internal-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    storage.sessions.insertSessionForTest(
      makeSession({ id: "sess_parent", label: "Parent session" }),
    );
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertEmbedding replaces, not duplicates", async () => {
    await storage.facts.insert(makeFact({ id: "f1", sourceSessionId: "sess_parent" }));
    const v1 = new Float32Array(768);
    v1[0] = 1;
    const v2 = new Float32Array(768);
    v2[1] = 1;
    await storage.facts.upsertEmbedding("f1", v1);
    await storage.facts.upsertEmbedding("f1", v2);
    const count = storage
      .rawDb()
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = 'f1'",
      )
      .get();
    expect(count?.c).toBe(1);
  });

  const embCount = (factId: string) =>
    storage
      .rawDb()
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = ?")
      .get(factId)?.c;

  it("markSuperseded deletes the superseded fact's embedding (no ANN ghost) (#351)", async () => {
    await storage.facts.insert(makeFact({ id: "old", sourceSessionId: "sess_parent" }));
    await storage.facts.insert(makeFact({ id: "new", sourceSessionId: "sess_parent" }));
    const v = new Float32Array(768); v[0] = 1;
    await storage.facts.upsertEmbedding("old", v);
    expect(embCount("old")).toBe(1);
    await storage.facts.markSuperseded("old", "new");
    expect(embCount("old")).toBe(0);
  });

  it("ingestSessionFacts collapse deletes a superseded duplicate's embedding (#351)", async () => {
    // "dup" comes from a DIFFERENT session; ingesting a fresh fact for the same
    // (subject,predicate) into sess_parent collapses (supersedes) it.
    storage.sessions.insertSessionForTest(makeSession({ id: "sess_other", label: "Other" }));
    await storage.facts.insert(makeFact({ id: "dup", subject: "X", predicate: "uses", sourceSessionId: "sess_other" }));
    const v = new Float32Array(768); v[2] = 1;
    await storage.facts.upsertEmbedding("dup", v);
    expect(embCount("dup")).toBe(1);
    await storage.facts.ingestSessionFacts("sess_parent", [
      makeFact({ id: "fresh", subject: "X", predicate: "uses", sourceSessionId: "sess_parent" }),
    ]);
    expect(embCount("dup")).toBe(0);
  });

  it("ingestSessionFacts drops embeddings of replaced same-session facts (#351)", async () => {
    await storage.facts.insert(makeFact({ id: "old1", subject: "Y", predicate: "ran", sourceSessionId: "sess_parent" }));
    const v = new Float32Array(768); v[3] = 1;
    await storage.facts.upsertEmbedding("old1", v);
    expect(embCount("old1")).toBe(1);
    // Re-ingesting sess_parent deletes its prior facts (and their embeddings).
    await storage.facts.ingestSessionFacts("sess_parent", [
      makeFact({ id: "replacement", subject: "Z", predicate: "ran", sourceSessionId: "sess_parent" }),
    ]);
    expect(embCount("old1")).toBe(0);
  });
});
