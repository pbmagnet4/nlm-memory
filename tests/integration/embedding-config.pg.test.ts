/**
 * PgEmbeddingConfigStore integration tests.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL to a
 * connection string, e.g.:
 *   export NLM_PG_TEST_URL="postgres://postgres:nlm@127.0.0.1:5544/nlm_test"
 *
 * Skips when the env var is absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";
import { PgEmbeddingConfigStore } from "../../src/core/storage/pg-embedding-config.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

describe.skipIf(!PG_TEST_URL)("PgEmbeddingConfigStore", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let pool: Pool;
  let store: PgEmbeddingConfigStore;

  beforeEach(async () => {
    pool = new Pool({ connectionString: pgUrl() });
    await runMigrationsPg(pool, MIGRATIONS_DIR);
    await pool.query("TRUNCATE TABLE embedding_config");
    store = new PgEmbeddingConfigStore(pool);
    await store.load();
  });

  afterEach(async () => {
    await pool.end();
  });

  it("migration applies: embedding_config table exists", async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'embedding_config') AS exists",
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("getLane returns null for unknown lane on fresh store", () => {
    expect(store.getLane("prose")).toBeNull();
    expect(store.getLane("code")).toBeNull();
  });

  it("upsertLane persists a row that getLane retrieves (cache round-trip)", async () => {
    store.upsertLane(
      { lane: "prose", provider: "ollama", model: "nomic-embed-text", dim: 768 },
      "2026-07-01T00:00:00Z",
    );
    const cfg = store.getLane("prose");
    expect(cfg).toEqual({
      lane: "prose",
      provider: "ollama",
      model: "nomic-embed-text",
      dim: 768,
    });
  });

  it("upsertLane persists to pg (survives a fresh load)", async () => {
    store.upsertLane(
      { lane: "prose", provider: "ollama", model: "nomic-embed-text", dim: 768 },
      "2026-07-01T00:00:00Z",
    );
    // Allow the async write to land
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const store2 = new PgEmbeddingConfigStore(pool);
    await store2.load();
    expect(store2.getLane("prose")).toEqual({
      lane: "prose",
      provider: "ollama",
      model: "nomic-embed-text",
      dim: 768,
    });
  });

  it("upsertLane overwrites existing row (ON CONFLICT update)", async () => {
    store.upsertLane(
      { lane: "prose", provider: "ollama", model: "old-model", dim: 384 },
      "2026-07-01T00:00:00Z",
    );
    store.upsertLane(
      { lane: "prose", provider: "ollama", model: "new-model", dim: 768 },
      "2026-07-02T00:00:00Z",
    );
    const cfg = store.getLane("prose");
    expect(cfg?.model).toBe("new-model");
    expect(cfg?.dim).toBe(768);
  });

  it("prose and code lanes are independent", () => {
    store.upsertLane(
      { lane: "prose", provider: "ollama", model: "prose-model", dim: 768 },
      "2026-07-01T00:00:00Z",
    );
    store.upsertLane(
      { lane: "code", provider: "ollama", model: "code-model", dim: 256 },
      "2026-07-01T00:00:00Z",
    );
    expect(store.getLane("prose")?.model).toBe("prose-model");
    expect(store.getLane("code")?.model).toBe("code-model");
  });

  it("lane CHECK constraint rejects invalid lane values", async () => {
    await expect(
      pool.query(
        "INSERT INTO embedding_config (lane, provider, model, dim, updated_at) VALUES ($1, $2, $3, $4, $5)",
        ["video", "ollama", "some-model", 768, "2026-07-01T00:00:00Z"],
      ),
    ).rejects.toThrow();
  });
});
