/**
 * Phase 0 task 3 — ProviderRegistry integration. Real SQLite, seed
 * defaults bridge from env, CRUD, secret redaction on list/get.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { ProviderRegistry } from "../../src/core/providers/provider-registry.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("ProviderRegistry", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let registry: ProviderRegistry;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-providers-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    registry = storage.providers;
    savedKey = process.env["DEEPSEEK_API_KEY"];
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = savedKey;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("seedDefaults inserts Ollama always, DeepSeek with key when present", async () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-test-abc";
    await registry.seedDefaults();
    const rows = await registry.list();
    expect(rows.map((r) => r.kind)).toEqual(["ollama", "deepseek"]);
    const deepseek = rows.find((r) => r.kind === "deepseek");
    expect(deepseek?.enabled).toBe(true);
    expect(deepseek?.hasApiKey).toBe(true);
    expect(deepseek?.apiKey).toBeNull(); // redacted
  });

  it("seedDefaults disables DeepSeek when key is absent", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    await registry.seedDefaults();
    const deepseek = await registry.getByName("DeepSeek");
    expect(deepseek?.enabled).toBe(false);
    expect(deepseek?.hasApiKey).toBe(false);
  });

  it("seedDefaults is idempotent", async () => {
    await registry.seedDefaults();
    await registry.seedDefaults();
    expect((await registry.list()).length).toBe(2);
  });

  it("inserts a custom provider with explicit base URL", async () => {
    const row = await registry.insert({
      kind: "openai-compatible",
      name: "vLLM box",
      baseUrl: "http://192.0.2.1:8000/v1",
      defaultModel: "llama-3.1-70b",
      apiKey: "secret-token",
    });
    expect(row.baseUrl).toBe("http://192.0.2.1:8000/v1");
    expect(row.hasApiKey).toBe(true);
    expect(row.apiKey).toBeNull();
  });

  it("getSecret returns the unredacted key", async () => {
    const row = await registry.insert({
      kind: "openai", name: "OpenAI prod", apiKey: "sk-real",
    });
    expect(await registry.getSecret(row.id)).toBe("sk-real");
  });

  it("rejects duplicate names", async () => {
    await registry.insert({ kind: "openai", name: "OpenAI", apiKey: "k" });
    await expect(registry.insert({ kind: "openai", name: "OpenAI", apiKey: "k2" }))
      .rejects.toThrow();
  });

  it("update patches only supplied fields", async () => {
    const row = await registry.insert({ kind: "openai", name: "OAI", apiKey: "k1" });
    const updated = await registry.update(row.id, { apiKey: "k2", enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(await registry.getSecret(row.id)).toBe("k2");
  });

  it("delete removes the row", async () => {
    const row = await registry.insert({ kind: "openai", name: "Tmp", apiKey: "k" });
    expect(await registry.delete(row.id)).toBe(true);
    expect(await registry.get(row.id)).toBeNull();
  });

  it("fills in default base URL and model when omitted", async () => {
    const row = await registry.insert({ kind: "anthropic", name: "Claude", apiKey: "k" });
    expect(row.baseUrl).toBe("https://api.anthropic.com");
    expect(row.defaultModel).toBe("claude-haiku-4-5-20251001");
  });
});
