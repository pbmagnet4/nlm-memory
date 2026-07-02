/**
 * PgSourceRegistry / PgProviderRegistry / PG actions-log coverage.
 *
 * The SQLite registries are covered by source-registry.test.ts and
 * provider-registry.test.ts; their PG counterparts had no direct tests.
 * This file mirrors the SQLite assertions against the PG adapters, focusing
 * on the methods wired into the HTTP layer in #215a (getByName, findByToken,
 * regenerateToken, and the PG action log dispatch).
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string. Skips when absent. Tables are truncated between tests.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { PgSessionStore } from "../../src/core/storage/pg-session-store.js";
import { PgSourceRegistry } from "../../src/core/sources/source-registry.js";
import { PgProviderRegistry } from "../../src/core/providers/provider-registry.js";
import {
  listActionsPg,
  undoActionPg,
  writeActionPg,
} from "../../src/core/actions/actions-log.js";
import { createApp } from "../../src/http/app.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import type { Hono } from "hono";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL =
  "TRUNCATE TABLE sources, providers, actions RESTART IDENTITY CASCADE";

describe.skipIf(!PG_TEST_URL)("PgSourceRegistry (PG)", () => {
  let storage: PgStorage;
  let pool: Pool;
  let registry: PgSourceRegistry;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    registry = new PgSourceRegistry(pool);
  });

  it("getByName resolves an inserted source and is null for unknown names", async () => {
    const inserted = await registry.insert({
      kind: "jsonl-generic",
      name: "Custom Logs",
      pathOrUrl: "/tmp/logs",
      runtimeLabel: "custom/1.0",
    });
    const found = await registry.getByName("Custom Logs");
    expect(found?.id).toBe(inserted.id);
    expect(await registry.getByName("Nonexistent")).toBeNull();
  });

  it("findByToken resolves a webhook source by its token", async () => {
    const wh = await registry.insert({
      kind: "webhook",
      name: "Hook A",
      runtimeLabel: "webhook/1.0",
    });
    expect(wh.token).toBeTruthy();
    const found = await registry.findByToken(wh.token!);
    expect(found?.id).toBe(wh.id);
    expect(found?.token).toBeNull(); // redacted on lookup
    expect(await registry.findByToken("nlm_invalid")).toBeNull();
    expect(await registry.findByToken("")).toBeNull();
  });

  it("regenerateToken issues a new token only for webhook sources", async () => {
    const wh = await registry.insert({
      kind: "webhook",
      name: "Hook B",
      runtimeLabel: "webhook/1.0",
    });
    const first = wh.token!;
    const second = (await registry.regenerateToken(wh.id))!;
    expect(second).not.toBe(first);
    expect(await registry.findByToken(first)).toBeNull();
    expect((await registry.findByToken(second))?.id).toBe(wh.id);

    const jsonl = await registry.insert({
      kind: "jsonl-generic",
      name: "Not A Hook",
      runtimeLabel: "custom/1.0",
    });
    expect(await registry.regenerateToken(jsonl.id)).toBeNull();
  });
});

describe.skipIf(!PG_TEST_URL)("PgProviderRegistry (PG)", () => {
  let storage: PgStorage;
  let pool: Pool;
  let registry: PgProviderRegistry;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    registry = new PgProviderRegistry(pool);
  });

  it("getByName resolves an inserted provider and redacts the key", async () => {
    const inserted = await registry.insert({
      kind: "openai",
      name: "My OpenAI",
      apiKey: "sk-secret",
    });
    const found = await registry.getByName("My OpenAI");
    expect(found?.id).toBe(inserted.id);
    expect(found?.apiKey).toBeNull();
    expect(found?.hasApiKey).toBe(true);
    expect(await registry.getByName("Nonexistent")).toBeNull();
  });
});

describe.skipIf(!PG_TEST_URL)("PG actions-log", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
  });

  it("writeActionPg then listActionsPg round-trips, undoActionPg reverts", async () => {
    const id = await writeActionPg(pool, {
      kind: "dismiss",
      subjectType: "session",
      subjectId: "sess_1",
      payload: { reason: "noise" },
    });
    expect(id).toMatch(/^act_/);

    const listed = await listActionsPg(pool, { subjectId: "sess_1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe("dismiss");
    expect(listed[0]!.payload).toEqual({ reason: "noise" });

    const undo = await undoActionPg(pool, id);
    expect(undo?.originalKind).toBe("dismiss");
    // The original is now reverted; undoing it again returns null.
    expect(await undoActionPg(pool, id)).toBeNull();
  });
});

describe.skipIf(!PG_TEST_URL)("data-management routes (PG backend)", () => {
  let storage: PgStorage;
  let store: PgSessionStore;
  let app: Hono;

  beforeAll(async () => {
    // The backup/restore routes gate on NLM_MCP_TOKEN before the PG guard; clear
    // it so the 501 assertions don't get pre-empted by a 401 in a token'd env.
    delete process.env["NLM_MCP_TOKEN"];
    storage = PgStorage.create({ connectionString: PG_TEST_URL!, migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
    const recall = new RecallService({ store, llm: new FixedEmbedder() });
    app = createApp({ recall, store, liveStore: store, dbPath: "/tmp/nlm-pg-stats-test.sqlite" });
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await storage.pgPool().query(TRUNCATE_SQL);
    await storage.pgPool().query("TRUNCATE TABLE sessions RESTART IDENTITY CASCADE");
  });

  it("GET /api/data/stats reports PG-native size + counts", async () => {
    await store.insertSessionForTest({
      id: "sess_stats_1",
      runtime: "claude-code",
      runtimeSessionId: "rt_1",
      startedAt: "2026-06-16T00:00:00Z",
      endedAt: null,
      durationMin: null,
      label: "stats fixture",
      summary: "a session for the stats test",
      status: "closed",
      transcriptKind: "claude-code",
      transcriptPath: null,
      body: "body text",
      entities: [],
      decisions: [],
      open: [],
    });

    const res = await app.request("/api/data/stats");
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      dbPath: string;
      dbBytes: number;
      dbPresent: boolean;
      schemaVersion: number | null;
      tables: Array<{ name: string; rows: number }>;
      runtimes: Array<{ runtime: string; n: number }>;
    };
    expect(stats.dbPath).toBe("postgresql");
    expect(stats.dbPresent).toBe(true);
    expect(stats.dbBytes).toBeGreaterThan(0);
    expect(stats.schemaVersion).toBe(25);
    expect(stats.tables.find((t) => t.name === "sessions")?.rows).toBe(1);
    expect(stats.runtimes).toContainEqual({ runtime: "claude-code", n: 1 });
  });

  it("GET /api/data/backup is 501 on PG with delegation guidance", async () => {
    const res = await app.request("/api/data/backup");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/pg_dump/);
  });

  it("POST /api/data/restore is 501 on PG with delegation guidance", async () => {
    const res = await app.request("/api/data/restore", { method: "POST" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/pg_restore/);
  });
});
