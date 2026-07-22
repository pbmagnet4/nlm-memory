// tests/integration/tenant-schema.test.ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/core/storage/migrate.js";

const MIGRATIONS = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations");
const STAMPED = ["sessions", "facts", "code_exemplars", "signals", "workstreams", "sources", "providers"];

describe("tenancy schema (sqlite 034)", () => {
  let dir: string;
  let db: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-tenant-"));
    db = new Database(join(dir, "t.sqlite"));
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);
    runMigrations(db, MIGRATIONS);
  });
  afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("seeds the default team", () => {
    const row = db.prepare("SELECT id, name FROM teams WHERE id = 'team_local'").get();
    expect(row).toBeDefined();
  });

  it("stamps every corpus/registry table NOT NULL DEFAULT team_local", () => {
    for (const table of STAMPED) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const col = cols.find((c) => c.name === "tenant_id");
      expect(col, `${table}.tenant_id`).toBeDefined();
      expect(col!.notnull, `${table}.tenant_id notnull`).toBe(1);
      expect(col!.dflt_value).toContain("team_local");
    }
  });

  it("stamps a row inserted without tenant_id via the DEFAULT", () => {
    db.prepare(
      "INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, body, status) VALUES ('s-t1','claude-code','r1','2026-07-22T00:00:00Z','l','s','b','active')",
    ).run();
    const row = db.prepare("SELECT tenant_id FROM sessions WHERE id = 's-t1'").get() as { tenant_id: string };
    expect(row.tenant_id).toBe("team_local");
  });

  it("team_tokens enforces team FK and unique hash", () => {
    db.prepare("INSERT INTO team_tokens (token_hash, team_id) VALUES ('h1','team_local')").run();
    expect(() => db.prepare("INSERT INTO team_tokens (token_hash, team_id) VALUES ('h1','team_local')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO team_tokens (token_hash, team_id) VALUES ('h2','nope')").run()).toThrow();
  });

  it("allows the same entity canonical under two tenants after re-key", () => {
    db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES ('team_b', 'B')").run();
    db.prepare("INSERT INTO entities (canonical, type, status) VALUES ('acme-api', 'candidate', 'candidate')").run();
    db.prepare("INSERT INTO entities (tenant_id, canonical, type, status) VALUES ('team_b', 'acme-api', 'candidate', 'candidate')").run();
    const rows = db.prepare("SELECT tenant_id FROM entities WHERE canonical = 'acme-api' ORDER BY tenant_id").all() as Array<{ tenant_id: string }>;
    expect(rows.map((r) => r.tenant_id)).toEqual(["team_b", "team_local"]);
  });

  it("still rejects a duplicate canonical within one tenant", () => {
    expect(() =>
      db.prepare("INSERT INTO entities (canonical, type, status) VALUES ('acme-api', 'candidate', 'candidate')").run(),
    ).toThrow();
  });

  it("cascades variant deletion per-tenant only", () => {
    db.prepare("INSERT INTO entity_variants (variant, canonical) VALUES ('Acme-API', 'acme-api')").run();
    db.prepare("INSERT INTO entity_variants (tenant_id, variant, canonical) VALUES ('team_b', 'Acme-API', 'acme-api')").run();
    db.prepare("DELETE FROM entities WHERE tenant_id = 'team_b' AND canonical = 'acme-api'").run();
    const left = db.prepare("SELECT tenant_id FROM entity_variants WHERE variant = 'Acme-API'").all() as Array<{ tenant_id: string }>;
    expect(left.map((r) => r.tenant_id)).toEqual(["team_local"]);
  });
});
