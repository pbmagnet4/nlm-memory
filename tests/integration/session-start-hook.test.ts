import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../../src/hook/session-start-hook.js";
import type { RecallHitInput } from "../../src/core/hook/select.js";

const hits = (...ids: string[]): ReadonlyArray<RecallHitInput> =>
  ids.map((id, i) => ({
    id,
    label: `Session ${id}`,
    startedAt: "2026-05-15T10:00:00.000Z",
    matchScore: 0.9 - i * 0.01,
  }));

describe("session-start runHook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-session-start-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shadow mode logs to hook-log but returns no stdout", async () => {
    const out = await runHook(
      { conversationId: "c1", query: "nlm-memory-ts recall" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(out).toBe("");
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    const entry = JSON.parse(log) as Record<string, unknown>;
    expect(entry["wouldInject"]).toEqual(["sess_a"]);
    expect(entry["mode"]).toBe("shadow");
    // gate is always "evaluate" — no prompt classifier in session-start
    expect(entry["gate"]).toBe("evaluate");
  });

  it("shadow mode does not write the memo", async () => {
    await runHook(
      { conversationId: "c1", query: "nlm-memory-ts" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(existsSync(join(tmp, "state", "c1.json"))).toBe(false);
  });

  it("live mode returns the pointer block and writes the memo", async () => {
    const out = await runHook(
      { conversationId: "c1", query: "nlm-memory-ts recall" },
      { mode: "live", recall: async () => hits("sess_a", "sess_b") },
    );
    expect(out).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(out).toContain("sess_a");
    const memo = JSON.parse(
      readFileSync(join(tmp, "state", "c1.json"), "utf8"),
    ) as string[];
    expect([...memo].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("live mode dedups: a second fire does not re-surface the same session", async () => {
    const deps = { mode: "live" as const, recall: async () => hits("sess_a") };
    const first = await runHook({ conversationId: "c1", query: "nlm-memory-ts" }, deps);
    expect(first).toContain("sess_a");
    const second = await runHook({ conversationId: "c1", query: "nlm-memory-ts" }, deps);
    expect(second).toBe("");
  });

  it("returns empty and does not throw when recall rejects", async () => {
    const out = await runHook(
      { conversationId: "c1", query: "nlm-memory-ts" },
      {
        mode: "live",
        recall: async () => {
          throw new Error("daemon down");
        },
      },
    );
    expect(out).toBe("");
  });

  it("returns empty string in both modes when recall returns no hits", async () => {
    for (const mode of ["shadow", "live"] as const) {
      const out = await runHook(
        { conversationId: `c-${mode}`, query: "nlm-memory-ts" },
        { mode, recall: async () => [] },
      );
      expect(out).toBe("");
    }
  });

  it("hook-log entry has promptPreview set to the query", async () => {
    await runHook(
      { conversationId: "c1", query: "whtnxt-agent session recall" },
      { mode: "shadow", recall: async () => hits("sess_x") },
    );
    const entry = JSON.parse(
      readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim(),
    ) as Record<string, unknown>;
    expect(entry["promptPreview"]).toBe("whtnxt-agent session recall");
  });

  it("live mode writes memo for each new session ID across multiple fires", async () => {
    // First fire surfaces sess_a
    await runHook(
      { conversationId: "c1", query: "nlm-memory-ts" },
      { mode: "live", recall: async () => hits("sess_a") },
    );
    // Second fire surfaces sess_b (sess_a already in memo — deduped out, sess_b is new)
    const second = await runHook(
      { conversationId: "c1", query: "nlm-memory-ts" },
      { mode: "live", recall: async () => hits("sess_a", "sess_b") },
    );
    expect(second).toContain("sess_b");
    expect(second).not.toContain("sess_a");
    const memo = JSON.parse(
      readFileSync(join(tmp, "state", "c1.json"), "utf8"),
    ) as string[];
    expect([...memo].sort()).toEqual(["sess_a", "sess_b"]);
  });
});
