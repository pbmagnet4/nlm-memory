// tests/unit/tenant-census.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CENSUS = join(ROOT, "docs/superpowers/specs/2026-07-22-team-nlm-table-census.md");

function tablesInDir(dir: string): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const m of sql.matchAll(/CREATE(?:\s+VIRTUAL)?\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_]+)/gi)) {
      const name = m[1]!.toLowerCase();
      if (!name.endsWith("_new") && name !== "schema_migrations") names.add(name);
    }
  }
  return names;
}

describe("tenant table census", () => {
  it("lists every table created by any migration, both lanes", () => {
    const census = readFileSync(CENSUS, "utf8");
    const all = new Set([
      ...tablesInDir(join(ROOT, "migrations")),
      ...tablesInDir(join(ROOT, "migrations/pg")),
    ]);
    const missing = [...all].filter((t) => !census.includes(`| ${t} |`));
    expect(missing).toEqual([]);
  });
});
