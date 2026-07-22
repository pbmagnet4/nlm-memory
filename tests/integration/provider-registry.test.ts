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
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const T = DEFAULT_TEAM_ID;

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
    await registry.seedDefaults(T);
    const rows = await registry.list(T);
    expect(rows.map((r) => r.kind)).toEqual(["ollama", "deepseek"]);
    const deepseek = rows.find((r) => r.kind === "deepseek");
    expect(deepseek?.enabled).toBe(true);
    expect(deepseek?.hasApiKey).toBe(true);
    expect(deepseek?.apiKey).toBeNull(); // redacted
  });

  it("seedDefaults disables DeepSeek when key is absent", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    await registry.seedDefaults(T);
    const deepseek = await registry.getByName(T, "DeepSeek");
    expect(deepseek?.enabled).toBe(false);
    expect(deepseek?.hasApiKey).toBe(false);
  });

  it("seedDefaults is idempotent", async () => {
    await registry.seedDefaults(T);
    await registry.seedDefaults(T);
    expect((await registry.list(T)).length).toBe(2);
  });

  it("inserts a custom provider with explicit base URL", async () => {
    const row = await registry.insert(T, {
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
    const row = await registry.insert(T, {
      kind: "openai", name: "OpenAI prod", apiKey: "sk-real",
    });
    expect(await registry.getSecret(T, row.id)).toBe("sk-real");
  });

  it("rejects duplicate names", async () => {
    await registry.insert(T, { kind: "openai", name: "OpenAI", apiKey: "k" });
    await expect(registry.insert(T, { kind: "openai", name: "OpenAI", apiKey: "k2" }))
      .rejects.toThrow();
  });

  // M4: name uniqueness is (tenant_id, name), not a bare UNIQUE(name) — two
  // teams can register the exact same provider name without colliding.
  it("allows the same provider name under two different tenants (M4 composite uniqueness)", async () => {
    const mine = await registry.insert(T, { kind: "openai", name: "Shared Provider", apiKey: "k1" });
    const theirs = await registry.insert("team_other", { kind: "openai", name: "Shared Provider", apiKey: "k2" });
    expect(mine.id).not.toBe(theirs.id);
    expect(await registry.getByName(T, "Shared Provider")).toMatchObject({ id: mine.id });
    expect(await registry.getByName("team_other", "Shared Provider")).toMatchObject({ id: theirs.id });
  });

  it("update patches only supplied fields", async () => {
    const row = await registry.insert(T, { kind: "openai", name: "OAI", apiKey: "k1" });
    const updated = await registry.update(T, row.id, { apiKey: "k2", enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(await registry.getSecret(T, row.id)).toBe("k2");
  });

  it("delete removes the row", async () => {
    const row = await registry.insert(T, { kind: "openai", name: "Tmp", apiKey: "k" });
    expect(await registry.delete(T, row.id)).toBe(true);
    expect(await registry.get(T, row.id)).toBeNull();
  });

  it("fills in default base URL and model when omitted", async () => {
    const row = await registry.insert(T, { kind: "anthropic", name: "Claude", apiKey: "k" });
    expect(row.baseUrl).toBe("https://api.anthropic.com");
    expect(row.defaultModel).toBe("claude-haiku-4-5-20251001");
  });

  it("tenant isolation: getSecret for a cross-tenant id returns not-found (null), not the key", async () => {
    const other = "team_other";
    const row = await registry.insert(T, { kind: "openai", name: "Isolated", apiKey: "sk-secret" });
    expect(await registry.getSecret(other, row.id)).toBeNull();
    expect(await registry.get(other, row.id)).toBeNull();
    expect((await registry.list(other)).map((r) => r.id)).not.toContain(row.id);
  });
});
