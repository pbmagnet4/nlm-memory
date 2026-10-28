import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function open() {
  const storage = SqliteStorage.create({
    dbPath: join(mkdtempSync(join(tmpdir(), "nlm-cs-")), "c.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  return storage;
}

describe("SqliteClassifierSettingsStore", () => {
  it("starts with everything unset", async () => {
    const s = await open();
    expect(await s.classifierSettings.get()).toEqual({ thinking: null, timeoutMs: null, maxTokens: null });
    await s.close();
  });

  it("persists a partial update, leaving other fields untouched", async () => {
    const s = await open();
    await s.classifierSettings.update({ thinking: "on", timeoutMs: 300_000 });
    await s.classifierSettings.update({ maxTokens: 2048 });
    expect(await s.classifierSettings.get()).toEqual({ thinking: "on", timeoutMs: 300_000, maxTokens: 2048 });
    await s.close();
  });

  it("null clears a stored value", async () => {
    const s = await open();
    await s.classifierSettings.update({ thinking: "on", timeoutMs: 300_000 });
    await s.classifierSettings.update({ thinking: null });
    expect(await s.classifierSettings.get()).toEqual({ thinking: null, timeoutMs: 300_000, maxTokens: null });
    await s.close();
  });
});
