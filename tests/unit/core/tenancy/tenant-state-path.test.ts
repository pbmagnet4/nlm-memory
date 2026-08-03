import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tenantStatePath, TENANTS_DIRNAME } from "../../../../src/core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

function shortHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

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

  it("sanitizes unsafe characters in the tenant id the same way memo.ts sanitizes conversation ids, appending a hash of the raw id", () => {
    const raw = "../../etc/passwd";
    expect(tenantStatePath(raw, "hook-state")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, `______etc_passwd_${shortHash(raw)}`, "hook-state"),
    );
  });

  it("falls back to 'unknown' plus a hash of the raw id for an empty tenant id", () => {
    expect(tenantStatePath("", "hook-state")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, `unknown_${shortHash("")}`, "hook-state"),
    );
  });

  it("supports multiple path segments (memo dir + filename)", () => {
    expect(tenantStatePath("acme", "hook-state", "conv-1.json")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "acme", "hook-state", "conv-1.json"),
    );
  });

  it("leaves a safe id (letters/digits/underscore/hyphen only) unsanitized and unhashed", () => {
    expect(tenantStatePath("team_local-2", "x")).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, "team_local-2", "x"),
    );
  });

  it("two ids that sanitize identically derive different, non-colliding dirs", () => {
    const a = tenantStatePath("acme.co", "query_log.jsonl");
    const b = tenantStatePath("acme_co", "query_log.jsonl");
    // "acme_co" is already safe and passes through unhashed; "acme.co" is
    // not, so it must not collide with the literal safe id it sanitizes to.
    expect(a).not.toBe(b);
    expect(b).toBe(join(homedir(), ".nlm", TENANTS_DIRNAME, "acme_co", "query_log.jsonl"));
    expect(a).toBe(
      join(homedir(), ".nlm", TENANTS_DIRNAME, `acme_co_${shortHash("acme.co")}`, "query_log.jsonl"),
    );
  });

  it("two different unsafe ids that sanitize to the same string still derive different dirs", () => {
    const a = tenantStatePath("acme.co", "x");
    const b = tenantStatePath("acme:co", "x");
    expect(a).not.toBe(b);
  });

  describe("NLM_STATE_ROOT override", () => {
    let tmp: string;
    const prevRoot = process.env["NLM_STATE_ROOT"];

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "nlm-state-root-"));
    });

    afterEach(() => {
      if (prevRoot === undefined) delete process.env["NLM_STATE_ROOT"];
      else process.env["NLM_STATE_ROOT"] = prevRoot;
      rmSync(tmp, { recursive: true, force: true });
    });

    it("relocates the default team's base directory", () => {
      process.env["NLM_STATE_ROOT"] = tmp;
      expect(tenantStatePath(DEFAULT_TEAM_ID, "query_log.jsonl")).toBe(join(tmp, "query_log.jsonl"));
    });

    it("relocates a non-default tenant's base directory, preserving tenant isolation", () => {
      process.env["NLM_STATE_ROOT"] = tmp;
      const a = tenantStatePath("acme", "query_log.jsonl");
      const b = tenantStatePath("other", "query_log.jsonl");
      expect(a).toBe(join(tmp, TENANTS_DIRNAME, "acme", "query_log.jsonl"));
      expect(b).toBe(join(tmp, TENANTS_DIRNAME, "other", "query_log.jsonl"));
      expect(a).not.toBe(b);
    });

    it("falls back to ~/.nlm when unset", () => {
      delete process.env["NLM_STATE_ROOT"];
      expect(tenantStatePath(DEFAULT_TEAM_ID, "x")).toBe(join(homedir(), ".nlm", "x"));
    });
  });
});
