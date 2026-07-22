// tests/unit/default-team.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("DEFAULT_TEAM_ID", () => {
  it("matches the id seeded by both migration lanes", () => {
    expect(DEFAULT_TEAM_ID).toBe("team_local");
    const sqlite = readFileSync(join(ROOT, "migrations/034_tenancy_teams_and_stamps.sql"), "utf8");
    const pg = readFileSync(join(ROOT, "migrations/pg/034_tenancy.sql"), "utf8");
    expect(sqlite).toContain(`VALUES ('${DEFAULT_TEAM_ID}'`);
    expect(pg).toContain(`VALUES ('${DEFAULT_TEAM_ID}'`);
  });
});
