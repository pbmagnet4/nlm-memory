/**
 * Direct coverage of SqliteSessionStore.keywordSearch — FTS5 BM25 ranking
 * and resilience to FTS5 query-syntax metacharacters in user input.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteSessionStore.keywordSearch", () => {
  let tmp: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-kw-"));
    store = new SqliteSessionStore({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    store.insertSessionForTest(
      makeSession({ id: "s_pg", label: "pgvector migration plan", body: "postgres mirror" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_hono", label: "Hono router", body: "http framework setup" }),
    );
    store.insertSessionForTest(
      makeSession({ id: "s_misc", label: "unrelated work", body: "nothing in common" }),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ranks the matching session first and returns a positive score", async () => {
    const hits = await store.keywordSearch("pgvector", 10);
    expect(hits[0]?.sessionId).toBe("s_pg");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("matches body text, not just the label", async () => {
    const hits = await store.keywordSearch("framework", 10);
    expect(hits.map((h) => h.sessionId)).toContain("s_hono");
  });

  it("returns an empty array for a query with no indexable tokens", async () => {
    const hits = await store.keywordSearch("---", 10);
    expect(hits).toEqual([]);
  });

  it("does not throw on FTS5 metacharacters in the query", async () => {
    const hits = await store.keywordSearch('pgvector OR (qdrant) NEAR "x"', 10);
    expect(hits.map((h) => h.sessionId)).toContain("s_pg");
  });

  it("respects the limit", async () => {
    const hits = await store.keywordSearch("plan router work", 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
