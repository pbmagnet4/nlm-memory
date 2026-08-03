/**
 * Path-contract tests for core/hook/hook-log.ts (M6 Task 1). Append
 * behavior is covered in tests/integration/hook-log.test.ts; this file only
 * exercises the new tenantId-first path derivation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHookLog, type HookLogEntry } from "../../../../src/core/hook/hook-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

const entry = (over: Partial<HookLogEntry> = {}): HookLogEntry => ({
  ts: "2026-05-20T12:00:00.000Z",
  conversationId: "conv-1",
  promptPreview: "test",
  gate: "evaluate",
  hits: [],
  wouldInject: [],
  estTokens: 0,
  mode: "shadow",
  ...over,
});

describe("hook-log.ts tenant path contract", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hooklog-tenant-"));
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("default team honors NLM_HOOK_LOG override (legacy behavior)", () => {
    const logPath = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_LOG"] = logPath;
    appendHookLog(DEFAULT_TEAM_ID, entry());
    expect(existsSync(logPath)).toBe(true);
  });

  it("a non-default tenant writes under ~/.nlm/tenants/<t>/hook-log.jsonl, ignoring NLM_HOOK_LOG", () => {
    const logPath = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_LOG"] = logPath;
    const derived = join(homedir(), ".nlm", "tenants", "acme-hooklog-test", "hook-log.jsonl");
    try {
      appendHookLog("acme-hooklog-test", entry());
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(derived)).toBe(true);
    } finally {
      rmSync(derived, { force: true });
    }
  });

  it("two tenants' hook logs don't collide", () => {
    const derivedA = join(homedir(), ".nlm", "tenants", "tenant-a-hooklog", "hook-log.jsonl");
    const derivedB = join(homedir(), ".nlm", "tenants", "tenant-b-hooklog", "hook-log.jsonl");
    try {
      appendHookLog("tenant-a-hooklog", entry({ conversationId: "conv-a" }));
      appendHookLog("tenant-b-hooklog", entry({ conversationId: "conv-b" }));
      const a = JSON.parse(readFileSync(derivedA, "utf8").trim());
      const b = JSON.parse(readFileSync(derivedB, "utf8").trim());
      expect(a.conversationId).toBe("conv-a");
      expect(b.conversationId).toBe("conv-b");
    } finally {
      rmSync(derivedA, { force: true });
      rmSync(derivedB, { force: true });
    }
  });
});
