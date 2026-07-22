// tests/integration/tenancy.pg.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrationsPg } from "../../src/core/storage/pg-migrate.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations/pg");

describe.skipIf(!PG_TEST_URL)("tenancy schema (pg 034)", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: pgUrl() });
    await runMigrationsPg(pool, MIGRATIONS_DIR);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("seeds team_local and enforces NOT NULL + FK on stamped tables", async () => {
    const team = await pool.query("SELECT id FROM teams WHERE id = 'team_local'");
    expect(team.rowCount).toBe(1);
    const cols = await pool.query(
      `SELECT c.table_name, c.is_nullable FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.column_name = 'tenant_id' AND c.table_schema = current_schema()`,
    );
    const stamped = new Map(cols.rows.map((r: { table_name: string; is_nullable: string }) => [r.table_name, r.is_nullable]));
    for (const t of ["sessions", "facts", "code_exemplars", "signals", "workstreams", "sources", "providers", "entities", "entity_variants", "session_entities", "workstream_entities"]) {
      expect(stamped.get(t), `${t}.tenant_id`).toBe("NO");
    }
  });

  it("rejects a tenant_id with no team row (FK)", async () => {
    await expect(
      pool.query("INSERT INTO workstreams (id, label, tenant_id) VALUES ('w-x', 'l', 'ghost-team')"),
    ).rejects.toThrow();
  });

  it("allows the same entity canonical under two tenants", async () => {
    await pool.query("INSERT INTO teams (id, name) VALUES ('team_b', 'B') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO entities (canonical) VALUES ('acme-api')");
    await pool.query("INSERT INTO entities (tenant_id, canonical) VALUES ('team_b', 'acme-api')");
    const rows = await pool.query("SELECT tenant_id FROM entities WHERE canonical = 'acme-api'");
    expect(rows.rowCount).toBe(2);
  });
});
