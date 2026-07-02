import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SqliteEmbeddingConfigStore (via SqliteStorage)", () => {
  let storage: SqliteStorage;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-embcfg-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("migration applies cleanly: embedding_config table exists", () => {
    const row = storage
      .rawDb()
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_config'",
      )
      .get();
    expect(row?.name).toBe("embedding_config");
  });

  it("getLane returns null for an unknown lane on a fresh db", () => {
    expect(storage.embeddingConfig.getLane("prose")).toBeNull();
    expect(storage.embeddingConfig.getLane("code")).toBeNull();
  });

  it("upsertLane persists a row that getLane retrieves", () => {
    storage.embeddingConfig.upsertLane(
      { lane: "prose", provider: "ollama", model: "nomic-embed-text", dim: 768 },
      "2026-07-01T00:00:00Z",
    );
    const cfg = storage.embeddingConfig.getLane("prose");
    expect(cfg).toEqual({
      lane: "prose",
      provider: "ollama",
      model: "nomic-embed-text",
      dim: 768,
    });
  });

  it("upsertLane overwrites an existing row (ON CONFLICT update)", () => {
    storage.embeddingConfig.upsertLane(
      { lane: "prose", provider: "ollama", model: "old-model", dim: 384 },
      "2026-07-01T00:00:00Z",
    );
    storage.embeddingConfig.upsertLane(
      { lane: "prose", provider: "ollama", model: "new-model", dim: 768 },
      "2026-07-02T00:00:00Z",
    );
    const cfg = storage.embeddingConfig.getLane("prose");
    expect(cfg?.model).toBe("new-model");
    expect(cfg?.dim).toBe(768);
  });

  it("prose and code lanes are independent", () => {
    storage.embeddingConfig.upsertLane(
      { lane: "prose", provider: "ollama", model: "prose-model", dim: 768 },
      "2026-07-01T00:00:00Z",
    );
    storage.embeddingConfig.upsertLane(
      { lane: "code", provider: "ollama", model: "code-model", dim: 256 },
      "2026-07-01T00:00:00Z",
    );
    expect(storage.embeddingConfig.getLane("prose")?.model).toBe("prose-model");
    expect(storage.embeddingConfig.getLane("code")?.model).toBe("code-model");
  });

  it("lane CHECK constraint rejects invalid lane values", () => {
    expect(() =>
      storage
        .rawDb()
        .prepare(
          "INSERT INTO embedding_config (lane, provider, model, dim, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("video", "ollama", "some-model", 768, "2026-07-01T00:00:00Z"),
    ).toThrow();
  });
});
