import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tenantStatePath, TENANTS_DIRNAME } from "../../../../src/core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

describe("tenantStatePath", () => {
  it("returns the legacy ~/.nlm path for the default team", () => {
    expect(tenantStatePath(DEFAULT_TEAM_ID, "query_log.jsonl")).toBe(
      join(homedir(), ".nlm", "query_log.jsonl"),
    );
  });

  it("returns the legacy path unchanged for a nested default-team segment", () => {
    expect(tenantStatePath(DEFAULT_TEAM_ID, "hook-state")).toBe(
      join(homedir(), ".nlm", "hook-state"),
    );
  });

  it("derives a tenants/<t>/... path for a non-default tenant", () => {
    expect(tenantStatePath("acme", "query_log.jsonl")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "acme", "query_log.jsonl"),
    );
  });

  it("isolates two tenants to distinct paths for the same basename", () => {
    const a = tenantStatePath("tenant-a", "hook-log.jsonl");
    const b = tenantStatePath("tenant-b", "hook-log.jsonl");
    expect(a).not.toBe(b);
    expect(a).toBe(join(homedir(), ".nlm", TENANTS_DIRNAME, "tenant-a", "hook-log.jsonl"));
    expect(b).toBe(join(homedir(), ".nlm", TENANTS_DIRNAME, "tenant-b", "hook-log.jsonl"));
  });

  it("sanitizes unsafe characters in the tenant id the same way memo.ts sanitizes conversation ids", () => {
    expect(tenantStatePath("../../etc/passwd", "hook-state")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "______etc_passwd", "hook-state"),
    );
  });

  it("falls back to 'unknown' for an empty tenant id", () => {
    expect(tenantStatePath("", "hook-state")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "unknown", "hook-state"),
    );
  });

  it("supports multiple path segments (memo dir + filename)", () => {
    expect(tenantStatePath("acme", "hook-state", "conv-1.json")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "acme", "hook-state", "conv-1.json"),
    );
  });
});
