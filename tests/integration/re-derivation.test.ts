/**
 * re-derivation metric (SQLite backend): seed two same-topic sessions far
 * apart with no continues edge -> one re-derivation; add a continues edge ->
 * zero. Exercises the real SQL deps factory, not a fake.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import {
  computeReDerivationRate,
  sqliteReDerivationDeps,
} from "../../src/core/metrics/re-derivation.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("computeReDerivationRate (SQLite deps)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-rederive-"));
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

  it("counts an unlinked re-derivation of the same decision", async () => {
    store.insertSessionForTest(
      makeSession({
        id: "a",
        startedAt: "2026-01-01T00:00:00Z",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );
    store.insertSessionForTest(
      makeSession({
        id: "b",
        startedAt: "2026-01-20T00:00:00Z",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );

    const deps = sqliteReDerivationDeps(store.rawDb());
    const { rate, pairs } = await computeReDerivationRate(deps, 3650);
    expect(pairs.length).toBe(1);
    expect(rate).toBeGreaterThan(0);
  });

  it("does not count when a continues edge links the sessions", async () => {
    store.insertSessionForTest(
      makeSession({
        id: "a",
        startedAt: "2026-01-01T00:00:00Z",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );
    store.insertSessionForTest(
      makeSession({
        id: "b",
        startedAt: "2026-01-20T00:00:00Z",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );
    store.insertEdgeForTest("b", "a", "continues");

    const deps = sqliteReDerivationDeps(store.rawDb());
    const { pairs } = await computeReDerivationRate(deps, 3650);
    expect(pairs.length).toBe(0);
  });
});
