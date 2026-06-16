/**
 * Phase 0 — SourceRegistry integration. Real SQLite, migrations apply,
 * seed defaults, CRUD round-trip, name uniqueness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SourceRegistry } from "../../src/core/sources/source-registry.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("SourceRegistry", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let registry: SourceRegistry;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sources-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    registry = storage.sources;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts empty and seeds nine presets", async () => {
    expect(await registry.list()).toEqual([]);
    await registry.seedDefaults();
    const rows = await registry.list();
    expect(rows.map((r) => r.kind)).toEqual([
      "claude-code", "codex", "hermes", "hermes-agent", "aider", "cursor", "windsurf", "opencode", "pi",
    ]);
    expect(rows.every((r) => r.runtimeLabel.endsWith("/1.0"))).toBe(true);
  });

  it("seedDefaults is idempotent", async () => {
    await registry.seedDefaults();
    await registry.seedDefaults();
    expect((await registry.list()).length).toBe(9);
  });

  it("inserts a custom JSONL source and round-trips parse config", async () => {
    const inserted = await registry.insert({
      kind: "jsonl-generic",
      name: "Cursor",
      pathOrUrl: "/tmp/cursor",
      runtimeLabel: "cursor/0.1",
      parseConfig: { sessionIdField: "id", textField: "content" },
    });
    expect(inserted.id).toBeGreaterThan(0);
    const fetched = await registry.get(inserted.id);
    expect(fetched?.parseConfig).toEqual({ sessionIdField: "id", textField: "content" });
  });

  it("rejects duplicate names at the unique-constraint level", async () => {
    await registry.insert({ kind: "webhook", name: "Push", runtimeLabel: "push/1" });
    await expect(registry.insert({ kind: "webhook", name: "Push", runtimeLabel: "push/2" }))
      .rejects.toThrow();
  });

  it("update patches only the supplied fields", async () => {
    const row = await registry.insert({ kind: "webhook", name: "API", runtimeLabel: "api/1" });
    const updated = await registry.update(row.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.runtimeLabel).toBe("api/1");
  });

  it("delete removes the row", async () => {
    const row = await registry.insert({ kind: "webhook", name: "Tmp", runtimeLabel: "tmp/1" });
    expect(await registry.delete(row.id)).toBe(true);
    expect(await registry.get(row.id)).toBeNull();
  });

  it("mints a token on insert for webhook sources, redacts on list/get", async () => {
    const row = await registry.insert({ kind: "webhook", name: "Tool A", runtimeLabel: "tool-a/1" });
    expect(row.token).toMatch(/^nlm_[a-f0-9]{48}$/);
    expect(row.hasToken).toBe(true);
    const listed = (await registry.list()).find((r) => r.id === row.id);
    expect(listed?.token).toBeNull();
    expect(listed?.hasToken).toBe(true);
    expect((await registry.get(row.id))?.token).toBeNull();
  });

  it("findByToken resolves to the owning source", async () => {
    const row = await registry.insert({ kind: "webhook", name: "Tool B", runtimeLabel: "tool-b/1" });
    expect(row.token).toBeTruthy();
    const found = await registry.findByToken(row.token!);
    expect(found?.id).toBe(row.id);
    expect(await registry.findByToken("nlm_invalid")).toBeNull();
    expect(await registry.findByToken("")).toBeNull();
  });

  it("non-webhook sources do not get tokens", async () => {
    const row = await registry.insert({
      kind: "jsonl-generic", name: "Logs", runtimeLabel: "logs/1", pathOrUrl: "/tmp/logs",
    });
    expect(row.token).toBeNull();
    expect(row.hasToken).toBe(false);
  });

  it("regenerateToken issues a new token only for webhook sources", async () => {
    const wh = await registry.insert({ kind: "webhook", name: "Tool C", runtimeLabel: "tool-c/1" });
    const first = wh.token!;
    const second = (await registry.regenerateToken(wh.id))!;
    expect(second).not.toBe(first);
    expect(await registry.findByToken(first)).toBeNull();
    expect((await registry.findByToken(second))?.id).toBe(wh.id);

    const jsonl = await registry.insert({
      kind: "jsonl-generic", name: "L2", runtimeLabel: "l/1", pathOrUrl: "/tmp/x",
    });
    expect(await registry.regenerateToken(jsonl.id)).toBeNull();
  });
});
