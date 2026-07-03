import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookRuntimeFromEnv, parseHookDeadline, promptRecallEnabled, runHook } from "../../src/hook/prompt-recall-hook.js";
import type { RecallHitInput } from "../../src/core/hook/select.js";

const hits = (...ids: string[]): ReadonlyArray<RecallHitInput> =>
  ids.map((id, i) => ({
    id,
    label: `Session ${id}`,
    startedAt: "2026-05-15T10:00:00.000Z",
    matchScore: 0.9 - i * 0.01,
  }));

describe("runHook", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hook-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    delete process.env["NLM_HOOK_LOG"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shadow mode logs but returns no stdout", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(out).toBe("");
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).wouldInject).toEqual(["sess_a"]);
    expect(JSON.parse(log).mode).toBe("shadow");
  });

  it("shadow mode does not write the memo", async () => {
    await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "shadow", recall: async () => hits("sess_a") },
    );
    expect(existsSync(join(tmp, "state", "c1.json"))).toBe(false);
  });

  it("live mode returns the pointer block and records the memo", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "live", recall: async () => hits("sess_a", "sess_b") },
    );
    expect(out).toContain("## Possibly-relevant prior sessions (nlm-memory)");
    expect(out).toContain("sess_a");
    const memo = JSON.parse(readFileSync(join(tmp, "state", "c1.json"), "utf8"));
    expect([...memo].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("recall gate shadow logs decisions without changing injection", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        recall: async () => hits("sess_a", "sess_b"),
        recallGate: { mode: "shadow", judge: async () => "irrelevant" },
      },
    );
    expect(out).toContain("sess_a");
    expect(out).toContain("sess_b");
    const log = JSON.parse(readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim());
    expect(log.wouldInject).toEqual(["sess_a", "sess_b"]);
    expect(log.gateDecisions).toEqual([
      { id: "sess_a", gate: "irrelevant" },
      { id: "sess_b", gate: "irrelevant" },
    ]);
  });

  it("recall gate live drops irrelevant candidates from injection", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        recall: async () => hits("sess_a", "sess_b"),
        recallGate: { mode: "live", judge: async (_p, c) => (c.includes("sess_b") ? "irrelevant" : "relevant") },
      },
    );
    expect(out).toContain("sess_a");
    expect(out).not.toContain("sess_b");
    const log = JSON.parse(readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim());
    expect(log.wouldInject).toEqual(["sess_a"]);
    expect(log.gateDecisions).toEqual([
      { id: "sess_a", gate: "relevant" },
      { id: "sess_b", gate: "irrelevant" },
    ]);
    const memo = JSON.parse(readFileSync(join(tmp, "state", "c1.json"), "utf8"));
    expect([...memo].sort()).toEqual(["sess_a"]);
  });

  it("recall gate caps how many candidates it judges (maxCandidates)", async () => {
    let calls = 0;
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        recall: async () => hits("sess_a", "sess_b", "sess_c"),
        recallGate: { mode: "live", maxCandidates: 1, judge: async () => { calls++; return "relevant"; } },
      },
    );
    // Only the top candidate is judged; the rest pass through ungated.
    expect(calls).toBe(1);
    const log = JSON.parse(readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim());
    expect(log.gateDecisions).toEqual([{ id: "sess_a", gate: "relevant" }]);
    expect(log.wouldInject).toEqual(["sess_a", "sess_b", "sess_c"]);
    expect(out).toContain("sess_c");
  });

  it("recall gate live with cap drops only the judged-irrelevant top candidate", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        recall: async () => hits("sess_a", "sess_b"),
        recallGate: { mode: "live", maxCandidates: 1, judge: async () => "irrelevant" },
      },
    );
    // Top judged irrelevant -> dropped; the ungated second still injects.
    expect(out).not.toContain("sess_a");
    expect(out).toContain("sess_b");
    const log = JSON.parse(readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim());
    expect(log.wouldInject).toEqual(["sess_b"]);
  });

  it("without a recall gate, no gate decisions are logged", async () => {
    await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      { mode: "live", recall: async () => hits("sess_a") },
    );
    const log = JSON.parse(readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim());
    expect(log.gateDecisions).toBeUndefined();
  });

  it("live mode dedups: a second fire does not re-surface the same session", async () => {
    const deps = { mode: "live" as const, recall: async () => hits("sess_a") };
    const first = await runHook({ prompt: "what did we decide", conversationId: "c1" }, deps);
    expect(first).toContain("sess_a");
    const second = await runHook({ prompt: "and what else did we decide", conversationId: "c1" }, deps);
    expect(second).toBe("");
  });

  it("generative prompts skip recall entirely", async () => {
    let called = false;
    const out = await runHook(
      { prompt: "draft a blog post about FTS5", conversationId: "c1" },
      { mode: "live", recall: async () => { called = true; return hits("sess_a"); } },
    );
    expect(out).toBe("");
    expect(called).toBe(false);
    const log = readFileSync(join(tmp, "hook-log.jsonl"), "utf8").trim();
    expect(JSON.parse(log).gate).toBe("generative");
  });

  it("returns empty and does not throw when recall rejects", async () => {
    const out = await runHook(
      { prompt: "what did we decide", conversationId: "c1" },
      { mode: "live", recall: async () => { throw new Error("daemon down"); } },
    );
    expect(out).toBe("");
  });

  it("fails open and skips the gate when the recall stage eats the whole deadline", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        deadlineMs: 60,
        recall: async () => { await new Promise((r) => setTimeout(r, 200)); return hits("sess_a"); },
        recallGate: { mode: "live", judge: async () => { throw new Error("gate must not run"); } },
      },
    );
    expect(out).toBe("");
  });

  it("keeps all selected candidates when the gate exceeds the remaining deadline", async () => {
    const start = Date.now();
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        deadlineMs: 120,
        recall: async () => hits("sess_a", "sess_b"),
        recallGate: { mode: "live", judge: async () => { await new Promise((r) => setTimeout(r, 500)); return "irrelevant"; } },
      },
    );
    expect(Date.now() - start).toBeLessThan(300);
    expect(out).toContain("sess_a");
    expect(out).toContain("sess_b");
  });
});

describe("promptRecallEnabled", () => {
  it("defaults OFF when the var is unset (pull-first posture)", () => {
    expect(promptRecallEnabled({})).toBe(false);
  });

  it("treats empty and whitespace-only values as unset", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "" })).toBe(false);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "  " })).toBe(false);
  });

  it("opts in with on", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "on" })).toBe(true);
  });

  it("stays off when explicitly off, any case", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "off" })).toBe(false);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "OFF" })).toBe(false);
  });

  it("keeps legacy set values enabled (existing installs untouched)", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "live" })).toBe(true);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "1" })).toBe(true);
  });
});

describe("hookRuntimeFromEnv", () => {
  it("defaults to claude-code for the Claude Code hook install", () => {
    expect(hookRuntimeFromEnv({})).toBe("claude-code");
  });

  it("uses NLM_HOOK_RUNTIME for packaged runtimes like Codex", () => {
    expect(hookRuntimeFromEnv({ NLM_HOOK_RUNTIME: "codex" })).toBe("codex");
  });

  it("ignores blank runtime overrides", () => {
    expect(hookRuntimeFromEnv({ NLM_HOOK_RUNTIME: "  " })).toBe("claude-code");
  });
});

describe("parseHookDeadline", () => {
  it("defaults to 4000 when env is unset", () => {
    expect(parseHookDeadline(undefined)).toBe(4000);
  });

  it("parses a valid ms value", () => {
    expect(parseHookDeadline("2500")).toBe(2500);
  });

  it("falls back to 4000 for non-numeric input", () => {
    expect(parseHookDeadline("garbage")).toBe(4000);
  });

  it("falls back to 4000 for zero or negative values", () => {
    expect(parseHookDeadline("0")).toBe(4000);
    expect(parseHookDeadline("-100")).toBe(4000);
  });
});
