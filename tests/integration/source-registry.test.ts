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
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const T = DEFAULT_TEAM_ID;

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
    expect(await registry.list(T)).toEqual([]);
    await registry.seedDefaults(T);
    const rows = await registry.list(T);
    expect(rows.map((r) => r.kind)).toEqual([
      "claude-code", "codex", "hermes", "hermes-agent", "aider", "cursor", "windsurf", "opencode", "pi",
    ]);
    expect(rows.every((r) => r.runtimeLabel.endsWith("/1.0"))).toBe(true);
  });

  it("seedDefaults is idempotent", async () => {
    await registry.seedDefaults(T);
    await registry.seedDefaults(T);
    expect((await registry.list(T)).length).toBe(9);
  });

  // M4: seedDefaults(DEFAULT_TEAM_ID) is exactly what nlm.ts's buildStack()
  // calls at boot — every seeded preset row must land under the default
  // team's tenant_id, not some other value the DEFAULT constant could drift
  // from. Checked via raw SQL rather than through the tenant-scoped
  // registry API so the assertion can't pass by construction.
  it("seedDefaults stamps every preset row with tenant_id = DEFAULT_TEAM_ID", async () => {
    await registry.seedDefaults(T);
    const raw = storage.rawDb()
      .prepare("SELECT DISTINCT tenant_id FROM sources")
      .all() as Array<{ tenant_id: string }>;
    expect(raw.map((r) => r.tenant_id)).toEqual([T]);
  });

  it("inserts a custom JSONL source and round-trips parse config", async () => {
    const inserted = await registry.insert(T, {
      kind: "jsonl-generic",
      name: "Cursor",
      pathOrUrl: "/tmp/cursor",
      runtimeLabel: "cursor/0.1",
      parseConfig: { sessionIdField: "id", textField: "content" },
    });
    expect(inserted.id).toBeGreaterThan(0);
    const fetched = await registry.get(T, inserted.id);
    expect(fetched?.parseConfig).toEqual({ sessionIdField: "id", textField: "content" });
  });

  it("rejects duplicate names at the unique-constraint level", async () => {
    await registry.insert(T, { kind: "webhook", name: "Push", runtimeLabel: "push/1" });
    await expect(registry.insert(T, { kind: "webhook", name: "Push", runtimeLabel: "push/2" }))
      .rejects.toThrow();
  });

  // M4: name uniqueness is (tenant_id, name), not a bare UNIQUE(name) — two
  // teams can register the exact same source name without colliding.
  it("allows the same source name under two different tenants (M4 composite uniqueness)", async () => {
    const mine = await registry.insert(T, { kind: "webhook", name: "Shared Name", runtimeLabel: "push/1" });
    const theirs = await registry.insert("team_other", { kind: "webhook", name: "Shared Name", runtimeLabel: "push/1" });
    expect(mine.id).not.toBe(theirs.id);
    expect(await registry.getByName(T, "Shared Name")).toMatchObject({ id: mine.id });
    expect(await registry.getByName("team_other", "Shared Name")).toMatchObject({ id: theirs.id });
  });

  it("update patches only the supplied fields", async () => {
    const row = await registry.insert(T, { kind: "webhook", name: "API", runtimeLabel: "api/1" });
    const updated = await registry.update(T, row.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(updated?.runtimeLabel).toBe("api/1");
  });

  it("delete removes the row", async () => {
    const row = await registry.insert(T, { kind: "webhook", name: "Tmp", runtimeLabel: "tmp/1" });
    expect(await registry.delete(T, row.id)).toBe(true);
    expect(await registry.get(T, row.id)).toBeNull();
  });

  it("mints a token on insert for webhook sources, redacts on list/get", async () => {
    const row = await registry.insert(T, { kind: "webhook", name: "Tool A", runtimeLabel: "tool-a/1" });
    expect(row.token).toMatch(/^nlm_[a-f0-9]{48}$/);
    expect(row.hasToken).toBe(true);
    const listed = (await registry.list(T)).find((r) => r.id === row.id);
    expect(listed?.token).toBeNull();
    expect(listed?.hasToken).toBe(true);
    expect((await registry.get(T, row.id))?.token).toBeNull();
  });

  it("findByToken resolves to the owning source", async () => {
    const row = await registry.insert(T, { kind: "webhook", name: "Tool B", runtimeLabel: "tool-b/1" });
    expect(row.token).toBeTruthy();
    const found = await registry.findByToken(row.token!);
    expect(found?.id).toBe(row.id);
    expect(found?.tenantId).toBe(T);
    expect(await registry.findByToken("nlm_invalid")).toBeNull();
    expect(await registry.findByToken("")).toBeNull();
  });

  it("non-webhook sources do not get tokens", async () => {
    const row = await registry.insert(T, {
      kind: "jsonl-generic", name: "Logs", runtimeLabel: "logs/1", pathOrUrl: "/tmp/logs",
    });
    expect(row.token).toBeNull();
    expect(row.hasToken).toBe(false);
  });

  it("regenerateToken issues a new token only for webhook sources", async () => {
    const wh = await registry.insert(T, { kind: "webhook", name: "Tool C", runtimeLabel: "tool-c/1" });
    const first = wh.token!;
    const second = (await registry.regenerateToken(T, wh.id))!;
    expect(second).not.toBe(first);
    expect(await registry.findByToken(first)).toBeNull();
    expect((await registry.findByToken(second))?.id).toBe(wh.id);

    const jsonl = await registry.insert(T, {
      kind: "jsonl-generic", name: "L2", runtimeLabel: "l/1", pathOrUrl: "/tmp/x",
    });
    expect(await registry.regenerateToken(T, jsonl.id)).toBeNull();
  });

  it("tenant isolation: a source created under one team is invisible to another team's list/get", async () => {
    const other = "team_other";
    const row = await registry.insert(T, { kind: "webhook", name: "Isolated", runtimeLabel: "iso/1" });
    expect(await registry.get(other, row.id)).toBeNull();
    expect((await registry.list(other)).map((r) => r.id)).not.toContain(row.id);
    expect(await registry.getByName(other, "Isolated")).toBeNull();
  });
});
