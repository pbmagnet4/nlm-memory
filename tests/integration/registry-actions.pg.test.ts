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
import { PgSourceRegistry } from "../../src/core/sources/source-registry.js";
import { PgProviderRegistry } from "../../src/core/providers/provider-registry.js";
import {
  listActionsPg,
  undoActionPg,
  writeActionPg,
} from "../../src/core/actions/actions-log.js";

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
