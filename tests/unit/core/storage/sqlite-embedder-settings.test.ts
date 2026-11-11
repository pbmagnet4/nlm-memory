import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function open() {
  const storage = SqliteStorage.create({
    dbPath: join(mkdtempSync(join(tmpdir(), "nlm-es-")), "e.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  return storage;
}

describe("SqliteEmbedderSettingsStore", () => {
  it("starts unset for both lanes", async () => {
    const s = await open();
    const none = { provider: null, baseUrl: null, model: null, apiKey: null };
    expect(await s.embedderSettings.get("prose")).toEqual(none);
    expect(await s.embedderSettings.get("code")).toEqual(none);
    await s.close();
  });

  it("keeps lanes separate; undefined leaves a field untouched and null clears it", async () => {
    const s = await open();
    await s.embedderSettings.update("prose", { provider: "openai", model: "m1", apiKey: "k" });
    await s.embedderSettings.update("prose", { baseUrl: "http://h/v1" });
    expect(await s.embedderSettings.get("prose")).toEqual({ provider: "openai", baseUrl: "http://h/v1", model: "m1", apiKey: "k" });
    expect((await s.embedderSettings.get("code")).model).toBeNull();
    await s.embedderSettings.update("prose", { apiKey: null });
    expect((await s.embedderSettings.get("prose")).apiKey).toBeNull();
    expect((await s.embedderSettings.get("prose")).model).toBe("m1");
    await s.close();
  });
});
