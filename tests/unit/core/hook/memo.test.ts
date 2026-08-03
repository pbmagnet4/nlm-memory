/**
 * Path-contract tests for core/hook/memo.ts (M6 Task 1). Behavioral coverage
 * (dedup, corrupt-file handling, resolveConversationForSession) already
 * lives in tests/integration/hook-memo.test.ts; this file only exercises the
 * new tenantId-first path derivation.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaced, recordSurfaced, clearSurfaced } from "../../../../src/core/hook/memo.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

describe("memo.ts tenant path contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-tenant-"));
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default team honors NLM_HOOK_STATE_DIR override (legacy behavior)", () => {
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
    recordSurfaced(DEFAULT_TEAM_ID, "conv-1", ["sess_a"]);
    expect(existsSync(join(tmp, "conv-1.json"))).toBe(true);
  });

  it("a non-default tenant writes under ~/.nlm/tenants/<t>/hook-state/, ignoring NLM_HOOK_STATE_DIR", () => {
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
    recordSurfaced("acme", "conv-1", ["sess_a"]);
    // Not written into the env-override dir...
    expect(existsSync(join(tmp, "conv-1.json"))).toBe(false);
    // ...but under the derived tenant dir.
    const derived = join(homedir(), ".nlm", "tenants", "acme", "hook-state", "conv-1.json");
    expect(existsSync(derived)).toBe(true);
    clearSurfaced("acme", "conv-1");
  });

  it("two tenants writing the same conversation id do not collide", () => {
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
    try {
      recordSurfaced("tenant-a", "conv-shared", ["sess_a"]);
      recordSurfaced("tenant-b", "conv-shared", ["sess_b"]);
      expect([...loadSurfaced("tenant-a", "conv-shared")]).toEqual(["sess_a"]);
      expect([...loadSurfaced("tenant-b", "conv-shared")]).toEqual(["sess_b"]);
    } finally {
      clearSurfaced("tenant-a", "conv-shared");
      clearSurfaced("tenant-b", "conv-shared");
    }
  });
});
