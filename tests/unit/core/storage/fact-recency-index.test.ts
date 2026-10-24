import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../../../fixtures/sessions.js";
import { makeFact } from "../../../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

// M3 (T1036): the dominant fact-recall shape is tenant-scoped recency —
// listForRecall always filters tenant_id and orders by created_at DESC with a
// LIMIT. Without a composite (tenant_id, created_at) index the engine sorts.
describe("fact recency index (M3)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-recency-idx-"));
    storage = SqliteStorage.create({ dbPath: join(dir, "t.db"), migrationsDir: MIGRATIONS_DIR });
    storage.sessions.insertSessionForTest(makeSession({ id: "sess_parent" }));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves tenant-scoped recency order from an index, not a sort", async () => {
    await storage.facts.insert("team_local", makeFact({ id: "fact_1", sourceSessionId: "sess_parent" }));
    const dbPath = join(dir, "t.db");
    const probe = new Database(dbPath, { readonly: true });
    try {
      const plan = probe
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM facts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
        .all("team_local", 500) as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(" | ");
      expect(detail).toMatch(/USING (?:COVERING )?INDEX idx_facts_tenant_created/i);
      expect(detail).not.toMatch(/TEMP B-TREE|SCAN facts/i);
    } finally {
      probe.close();
    }
  });
});
