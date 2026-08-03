/**
 * Path-contract tests for core/hook/memo.ts (M6 Task 1). Behavioral coverage
 * (dedup, corrupt-file handling, resolveConversationForSession) already
 * lives in tests/integration/hook-memo.test.ts; this file only exercises the
 * new tenantId-first path derivation.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaced, recordSurfaced, clearSurfaced } from "../../../../src/core/hook/memo.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

describe("memo.ts tenant path contract", () => {
  let tmp: string;
  let hookStateDir: string;
  const prevStateRoot = process.env["NLM_STATE_ROOT"];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-tenant-"));
    hookStateDir = join(tmp, "hook-state-override");
    // NLM_STATE_ROOT keeps every non-default-team write under this temp dir
    // instead of the real ~/.nlm/tenants/<t>/ — otherwise this test leaves
    // residual tenant directories behind in the developer's actual home dir.
    process.env["NLM_STATE_ROOT"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    if (prevStateRoot === undefined) delete process.env["NLM_STATE_ROOT"];
    else process.env["NLM_STATE_ROOT"] = prevStateRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default team honors NLM_HOOK_STATE_DIR override (legacy behavior)", () => {
    process.env["NLM_HOOK_STATE_DIR"] = hookStateDir;
    recordSurfaced(DEFAULT_TEAM_ID, "conv-1", ["sess_a"]);
    expect(existsSync(join(hookStateDir, "conv-1.json"))).toBe(true);
  });

  it("a non-default tenant writes under STATE_ROOT/tenants/<t>/hook-state/, ignoring NLM_HOOK_STATE_DIR", () => {
    process.env["NLM_HOOK_STATE_DIR"] = hookStateDir;
    recordSurfaced("acme", "conv-1", ["sess_a"]);
    // Not written into the env-override dir...
    expect(existsSync(join(hookStateDir, "conv-1.json"))).toBe(false);
    // ...but under the derived tenant dir, relocated under the temp state root.
    const derived = join(tmp, "tenants", "acme", "hook-state", "conv-1.json");
    expect(existsSync(derived)).toBe(true);
    clearSurfaced("acme", "conv-1");
  });

  it("two tenants writing the same conversation id do not collide", () => {
    process.env["NLM_HOOK_STATE_DIR"] = hookStateDir;
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
