import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { readHookRecallLog } from "../../../../src/core/recall/hook-recall-log.js";
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nlm-hook-recall-"));
  logPath = join(dir, "hook-log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

describe("readHookRecallLog", () => {
  it("returns only recall entries with injected ids and a real conversationId", async () => {
    const lines = [
      // valid recall fire
      { ts: now(), conversationId: "conv_a", wouldInject: ["s1", "s2"], gate: "evaluate" },
      // unknown conversationId — dropped (can't join)
      { ts: now(), conversationId: "unknown", wouldInject: ["s3"], gate: "evaluate" },
      // empty injection — dropped
      { ts: now(), conversationId: "conv_b", wouldInject: [], gate: "evaluate" },
      // stop entry (no wouldInject) — dropped
      { ts: now(), kind: "stop", conversationId: "conv_a", citedIds: ["s1"] },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const out = await readHookRecallLog(DEFAULT_TEAM_ID, 30, logPath);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ conversationId: "conv_a", injectedIds: ["s1", "s2"] });
  });

  it("respects the day cutoff", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      { ts: old, conversationId: "conv_old", wouldInject: ["s1"], gate: "evaluate" },
      { ts: now(), conversationId: "conv_new", wouldInject: ["s2"], gate: "evaluate" },
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const out = await readHookRecallLog(DEFAULT_TEAM_ID, 30, logPath);
    expect(out.map((e) => e.conversationId)).toEqual(["conv_new"]);
  });

  it("returns empty array when the file is missing", async () => {
    const out = await readHookRecallLog(DEFAULT_TEAM_ID, 30, join(dir, "nope.jsonl"));
    expect(out).toEqual([]);
  });

  it("skips corrupt lines", async () => {
    writeFileSync(
      logPath,
      `${JSON.stringify({ ts: now(), conversationId: "conv_a", wouldInject: ["s1"] })}\nnot json\n`,
      "utf8",
    );
    const out = await readHookRecallLog(DEFAULT_TEAM_ID, 30, logPath);
    expect(out).toHaveLength(1);
  });
});

describe("readHookRecallLog tenant path contract", () => {
  afterEach(() => {
    delete process.env["NLM_HOOK_LOG"];
  });

  it("default team honors NLM_HOOK_LOG override (legacy behavior)", async () => {
    process.env["NLM_HOOK_LOG"] = logPath;
    writeFileSync(logPath, `${JSON.stringify({ ts: now(), conversationId: "conv_a", wouldInject: ["s1"] })}\n`, "utf8");
    const out = await readHookRecallLog(DEFAULT_TEAM_ID, 30);
    expect(out).toHaveLength(1);
  });

  it("a non-default tenant reads from ~/.nlm/tenants/<t>/hook-log.jsonl, ignoring NLM_HOOK_LOG", async () => {
    process.env["NLM_HOOK_LOG"] = logPath;
    const derivedDir = join(homedir(), ".nlm", "tenants", "acme-hookrecall-test");
    const derived = join(derivedDir, "hook-log.jsonl");
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(derived, `${JSON.stringify({ ts: now(), conversationId: "conv_tenant", wouldInject: ["s9"] })}\n`, "utf8");
    try {
      const out = await readHookRecallLog("acme-hookrecall-test", 30);
      expect(out).toEqual([{ conversationId: "conv_tenant", injectedIds: ["s9"] }]);
    } finally {
      rmSync(derived, { force: true });
    }
  });

  it("two tenants' hook-recall logs don't collide", async () => {
    const derivedDirA = join(homedir(), ".nlm", "tenants", "tenant-a-hookrecall");
    const derivedDirB = join(homedir(), ".nlm", "tenants", "tenant-b-hookrecall");
    const derivedA = join(derivedDirA, "hook-log.jsonl");
    const derivedB = join(derivedDirB, "hook-log.jsonl");
    mkdirSync(derivedDirA, { recursive: true });
    mkdirSync(derivedDirB, { recursive: true });
    writeFileSync(derivedA, `${JSON.stringify({ ts: now(), conversationId: "conv_a", wouldInject: ["s_a"] })}\n`, "utf8");
    writeFileSync(derivedB, `${JSON.stringify({ ts: now(), conversationId: "conv_b", wouldInject: ["s_b"] })}\n`, "utf8");
    try {
      const outA = await readHookRecallLog("tenant-a-hookrecall", 30);
      const outB = await readHookRecallLog("tenant-b-hookrecall", 30);
      expect(outA).toEqual([{ conversationId: "conv_a", injectedIds: ["s_a"] }]);
      expect(outB).toEqual([{ conversationId: "conv_b", injectedIds: ["s_b"] }]);
    } finally {
      rmSync(derivedA, { force: true });
      rmSync(derivedB, { force: true });
    }
  });
});
