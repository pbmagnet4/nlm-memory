/**
 * Direct coverage of SqliteSessionStore.semanticSearch — verify that
 * superseded sessions are filtered out from recall results.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => {
    padded[i] = v;
  });
  let sum = 0;
  for (const v of padded) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < padded.length; i++) padded[i] = (padded[i] ?? 0) / norm;
  return padded;
}

describe("SqliteSessionStore.semanticSearch", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteStorage["sessions"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-semantic-"));
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

  it("filters out superseded sessions from semantic search results", async () => {
    // Insert two sessions with embeddings
    const oldSession = makeSession({
      id: "s_old_semantic",
      label: "pgvector exploration",
      body: "testing pgvector extension",
    });
    const newSession = makeSession({
      id: "s_new_semantic",
      label: "pgvector production",
      body: "deployed pgvector in production",
    });
    store.insertSessionForTest(oldSession);
    store.insertSessionForTest(newSession);

    // Embed both sessions with different vectors
    store.insertEmbeddingForTest("s_old_semantic", unit([1, 0, 0]));
    store.insertEmbeddingForTest("s_new_semantic", unit([1, 0.5, 0]));

    // Mark old as superseded by new
    await store.markSuperseded("team_local", "s_old_semantic", "s_new_semantic");

    // Query with a vector similar to both
    const queryVec = unit([1, 0.1, 0]);
    const results = await store.semanticSearch("team_local", queryVec, 10);

    // Should only find the new session, not the old superseded one
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain("s_new_semantic");
    expect(sessionIds).not.toContain("s_old_semantic");
  });

  it("returns empty immediately when workstreamIds is an empty array", async () => {
    store.insertSessionForTest(makeSession({ id: "s_ws_empty", label: "kafka pipeline" }));
    store.insertEmbeddingForTest("s_ws_empty", unit([1, 0, 0]));
    const q = unit([1, 0, 0]);
    const results = await store.semanticSearch( "team_local",q, 10, { workstreamIds: [] });
    expect(results).toHaveLength(0);
  });

  it("returns only non-superseded sessions when multiple exist", async () => {
    // Insert three sessions, supersede one
    store.insertSessionForTest(
      makeSession({
        id: "s_baseline",
        label: "baseline test",
        body: "original approach",
      }),
    );
    store.insertSessionForTest(
      makeSession({
        id: "s_old_alt",
        label: "alternative tried",
        body: "attempted alternate approach",
      }),
    );
    store.insertSessionForTest(
      makeSession({
        id: "s_final",
        label: "final decision",
        body: "chose the best approach",
      }),
    );

    // Embed all
    store.insertEmbeddingForTest("s_baseline", unit([1, 0, 0]));
    store.insertEmbeddingForTest("s_old_alt", unit([0.9, 0.1, 0]));
    store.insertEmbeddingForTest("s_final", unit([1, 0, 0]));

    // Mark old_alt as superseded
    await store.markSuperseded("team_local", "s_old_alt", "s_final");

    // Query
    const queryVec = unit([0.95, 0.05, 0]);
    const results = await store.semanticSearch("team_local", queryVec, 10);

    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain("s_baseline");
    expect(sessionIds).toContain("s_final");
    expect(sessionIds).not.toContain("s_old_alt");
  });
});
