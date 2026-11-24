/**
 * T1770k — migration 052 adds the fts5vocab shadow view the keyword stage uses
 * to rank query terms by document frequency. It has to apply to a database
 * that already has sessions and a populated sessions_fts index, and the vocab
 * has to reflect those existing rows without a rebuild (fts5vocab reads the
 * FTS index itself, so there is nothing to backfill).
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const VOCAB_MIGRATION = "052_sessions_fts_vocab.sql";

describe("migration 052 sessions_fts_vocab", () => {
  let tmp: string;
  let dbPath: string;
  /** migrations/ minus 052 — the database an upgrade starts from. */
  let preDir: string;
  let storage: SqliteStorage | null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-vocab-"));
    dbPath = join(tmp, "canonical.sqlite");
    preDir = join(tmp, "migrations-pre");
    mkdirSync(preDir);
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      if (file.endsWith(".sql") && file !== VOCAB_MIGRATION) {
        copyFileSync(join(MIGRATIONS_DIR, file), join(preDir, file));
      }
    }
    storage = null;
  });

  afterEach(async () => {
    await storage?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("applies to a populated database and reflects the existing index", async () => {
    const before = SqliteStorage.create({ dbPath, migrationsDir: preDir });
    await before.init();
    before.sessions.insertSessionForTest(
      makeSession({ id: "s1", label: "widget budget", body: "widget and more" }),
    );
    before.sessions.insertSessionForTest(
      makeSession({ id: "s2", label: "widget rollout", body: "unrelated body" }),
    );
    before.sessions.insertSessionForTest(
      makeSession({ id: "s3", label: "one-off audit", body: "nothing shared" }),
    );
    expect(
      before.sessions.rawDb().prepare<[], { n: number }>("SELECT count(*) AS n FROM sessions_fts").get(),
    ).toEqual({ n: 3 });
    await before.close();

    storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    const db = storage.sessions.rawDb();

    expect(
      db.prepare<[], { version: number }>("SELECT version FROM schema_migrations WHERE version = 52").get(),
    ).toEqual({ version: 52 });
    // doc = documents containing the term, straight off the pre-existing index.
    const docFor = (term: string): number | undefined =>
      db.prepare<[string], { doc: number }>("SELECT doc FROM sessions_fts_vocab WHERE term = ?").get(term)?.doc;
    expect(docFor("widget")).toBe(2);
    expect(docFor("rollout")).toBe(1);
    expect(docFor("nope")).toBeUndefined();

    // The keyword stage reads that same vocab: of the 40 query terms, the one
    // unique to one document outranks the 38 shared filler terms for a place
    // in the MATCH expression, and a session nothing else matches stays
    // findable through it.
    const fillers = Array.from({ length: 38 }, (_, i) => `xtrap${i}`);
    storage.sessions.insertSessionForTest(
      makeSession({ id: "s_a", label: "alpha sync", body: fillers.join(" ") }),
    );
    storage.sessions.insertSessionForTest(
      makeSession({ id: "s_b", label: "beta sync", body: fillers.join(" ") }),
    );
    storage.sessions.insertSessionForTest(
      makeSession({ id: "s_quokka", label: "quokka", body: "" }),
    );
    const hits = await storage.sessions.keywordSearch(
      "team_local",
      [...fillers, "quokka"].join(" "),
      10,
    );
    expect(hits.map((h) => h.sessionId)).toContain("s_quokka");
  });
});
