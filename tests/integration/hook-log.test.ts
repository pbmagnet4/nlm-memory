import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHookLog, type HookLogEntry } from "../../src/core/hook/hook-log.js";

const entry = (over: Partial<HookLogEntry> = {}): HookLogEntry => ({
  ts: "2026-05-20T12:00:00.000Z",
  conversationId: "conv-1",
  promptPreview: "what did we decide about pgvector",
  gate: "evaluate",
  hits: [{ id: "sess_a", score: 0.9 }],
  wouldInject: ["sess_a"],
  estTokens: 42,
  mode: "shadow",
  ...over,
});

describe("appendHookLog", () => {
  let tmp: string;
  let logPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hooklog-"));
    logPath = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_LOG"] = logPath;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends one JSON line per call", () => {
    appendHookLog(entry());
    appendHookLog(entry({ conversationId: "conv-2" }));
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "");
    expect(first.conversationId).toBe("conv-1");
    expect(first.wouldInject).toEqual(["sess_a"]);
    expect(first.estTokens).toBe(42);
  });

  it("creates the parent directory if missing", () => {
    process.env["NLM_HOOK_LOG"] = join(tmp, "nested", "deep", "hook-log.jsonl");
    appendHookLog(entry());
    const lines = readFileSync(
      join(tmp, "nested", "deep", "hook-log.jsonl"),
      "utf8",
    ).trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
