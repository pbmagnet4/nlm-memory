// tests/unit/tenant-clause.test.ts
import { describe, expect, it } from "vitest";
import { tenantClause, tenantClausePg } from "../../src/core/tenancy/tenant-clause.js";

describe("tenantClause (sqlite)", () => {
  it("builds a positional `?` fragment bound to the tenant id", () => {
    const c = tenantClause("team_a");
    expect(c.sql).toBe("tenant_id = ?");
    expect(c.param).toBe("team_a");
  });

  it("qualifies the column for joined queries", () => {
    const c = tenantClause("team_a", "s.tenant_id");
    expect(c.sql).toBe("s.tenant_id = ?");
  });

  it("throws on an empty tenantId", () => {
    expect(() => tenantClause("")).toThrow(/tenantId is required/);
  });
});

describe("tenantClausePg", () => {
  it("builds a numbered `$n` fragment at the given index", () => {
    const c = tenantClausePg("team_b", 3);
    expect(c.sql).toBe("tenant_id = $3");
    expect(c.param).toBe("team_b");
  });

  it("qualifies the column for joined queries", () => {
    const c = tenantClausePg("team_b", 1, "f.tenant_id");
    expect(c.sql).toBe("f.tenant_id = $1");
  });

  it("throws on an empty tenantId", () => {
    expect(() => tenantClausePg("", 1)).toThrow(/tenantId is required/);
  });
});
