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

  it("ingestSessionFacts does NOT cycle on same-(subject,predicate) batch facts (#351 bug 2)", async () => {
    // Two facts for the same (subject,predicate) in one batch used to supersede
    // each other (A->B, B->A) — both recall-ineligible forever. The winner
    // collapse leaves exactly one active, no cycle.
    await storage.facts.ingestSessionFacts("sess_parent", [
      makeFact({ id: "d1", subject: "A", predicate: "uses", value: "x", sourceSessionId: "sess_parent" }),
      makeFact({ id: "d2", subject: "A", predicate: "uses", value: "y", sourceSessionId: "sess_parent" }),
    ]);
    const db = storage.rawDb();
    const active = db
      .prepare("SELECT id FROM facts WHERE subject='A' AND predicate='uses' AND superseded_by IS NULL")
      .all();
    expect(active).toHaveLength(1);
    const cyc = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM facts a JOIN facts b ON a.superseded_by=b.id AND b.superseded_by=a.id",
      )
      .get();
    expect(cyc?.c).toBe(0);
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

  it("insertFactsForSession drops embeddings of replaced same-session facts — no orphan vectors (#351 follow-up)", async () => {
    // The backfill entry point inlines the same DELETE-prior-facts logic as
    // ingestSessionFacts but the #351 fix patched only the port method, leaving
    // this path orphaning vec0 vectors (no backing fact). See sqlite-session-store.ts.
    await storage.facts.insert(makeFact({ id: "bf_old", subject: "P", predicate: "ran", sourceSessionId: "sess_parent" }));
    const v = new Float32Array(768); v[5] = 1;
    await storage.facts.upsertEmbedding("bf_old", v);
    expect(embCount("bf_old")).toBe(1);
    await storage.sessions.insertFactsForSession("sess_parent", storage.facts, [
      makeFact({ id: "bf_new", subject: "Q", predicate: "ran", sourceSessionId: "sess_parent" }),
    ]);
    expect(embCount("bf_old")).toBe(0);
  });
});
