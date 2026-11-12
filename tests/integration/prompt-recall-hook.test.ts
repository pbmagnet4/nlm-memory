import { mkdtempSync, existsSync, readFileSync, rmSync, appendFileSync } from "node:fs";
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

  it("live mode injects fetched concepts as a Learning state section", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        recall: async () => ({
          hits: hits("sess_a"),
          facts: [],
          concepts: [
            { concept: "math.chain-rule", status: "practicing", attemptCount: 2, nextStep: "Compare u=3x+1." },
          ],
        }),
      },
    );
    expect(out).toContain("## Learning state (nlm-memory)");
    expect(out).toContain("[practicing] math.chain-rule (2 attempts)");
    expect(out).toContain("Next: Compare u=3x+1.");
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

  it("fails open when the recall stage eats the whole deadline", async () => {
    const out = await runHook(
      { prompt: "what did we decide about pgvector", conversationId: "c1" },
      {
        mode: "live",
        deadlineMs: 60,
        recall: async () => { await new Promise((r) => setTimeout(r, 200)); return hits("sess_a"); },
      },
    );
    expect(out).toBe("");
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

// T1783 hub damping on the hook path.
function hitWithLabel(id: string, score: number, label: string): RecallHitInput {
  return { id, label, startedAt: "2026-05-15T10:00:00.000Z", matchScore: score };
}

function injectedFromLog(tmpDir: string): string[] {
  const log = readFileSync(join(tmpDir, "hook-log.jsonl"), "utf8").trim();
  return JSON.parse(log.split("\n").at(-1)!).wouldInject;
}

describe("hub damping (T1783)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hub-"));
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "state");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_HUB_DAMP"] = "on";
  });
  afterEach(() => {
    for (const k of ["NLM_HOOK_STATE_DIR", "NLM_HOOK_LOG", "NLM_HOOK_HUB_DAMP", "NLM_HOOK_HUB_ALPHA", "NLM_HOOK_LEX_FLOOR"]) {
      delete process.env[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("demotes a heavily-injected plateau hit below fresh candidates", async () => {
    process.env["NLM_HOOK_LEX_FLOOR"] = "0"; // isolate the penalty
    const plateau = [
      hitWithLabel("hub", 0.99, "git merge pipeline work"),
      hitWithLabel("fresh_a", 0.9, "git merge pipeline work"),
      hitWithLabel("fresh_b", 0.89, "git merge pipeline work"),
      hitWithLabel("fresh_c", 0.88, "git merge pipeline work"),
    ];
    const out = await runHook(
      { prompt: "rebase the feature branch onto main", conversationId: "c1" },
      {
        mode: "shadow",
        recall: async () => plateau,
        injectionCounts: new Map([["hub", 100]]),
      },
    );
    expect(out).toBe(""); // shadow
    expect(injectedFromLog(tmp)).toEqual(["fresh_a", "fresh_b", "fresh_c"]);
  });

  it("keeps the old ordering when damping is off", async () => {
    process.env["NLM_HOOK_HUB_DAMP"] = "off";
    process.env["NLM_HOOK_LEX_FLOOR"] = "0";
    const plateau = [
      hitWithLabel("hub", 0.99, "git merge pipeline work"),
      hitWithLabel("fresh_a", 0.9, "git merge pipeline work"),
      hitWithLabel("fresh_b", 0.89, "git merge pipeline work"),
      hitWithLabel("fresh_c", 0.88, "git merge pipeline work"),
    ];
    await runHook(
      { prompt: "rebase the feature branch onto main", conversationId: "c1" },
      {
        mode: "shadow",
        recall: async () => plateau,
        injectionCounts: new Map([["hub", 100]]),
      },
    );
    expect(injectedFromLog(tmp)).toEqual(["hub", "fresh_a", "fresh_b"]);
  });

  it("drops a below-floor hit with zero lexical overlap even when it leads", async () => {
    process.env["NLM_HOOK_HUB_ALPHA"] = "0"; // guard only
    process.env["NLM_HOOK_LEX_FLOOR"] = "2.0";
    await runHook(
      { prompt: "vault backup rotation schedule", conversationId: "c1" },
      {
        mode: "shadow",
        recall: async () => [
          hitWithLabel("off_topic", 1.0, "LinkedIn Easy Apply for Ryan Sr Manager"),
          hitWithLabel("keeper", 0.91, "vault rotation design"),
        ],
        injectionCounts: new Map(),
      },
    );
    expect(injectedFromLog(tmp)).toEqual(["keeper"]);
  });

  it("keeps that same hit when the guard floor is 0", async () => {
    process.env["NLM_HOOK_HUB_ALPHA"] = "0";
    process.env["NLM_HOOK_LEX_FLOOR"] = "0";
    await runHook(
      { prompt: "vault backup rotation schedule", conversationId: "c1" },
      {
        mode: "shadow",
        recall: async () => [
          hitWithLabel("off_topic", 1.0, "LinkedIn Easy Apply for Ryan Sr Manager"),
          hitWithLabel("keeper", 0.91, "vault rotation design"),
        ],
        injectionCounts: new Map(),
      },
    );
    expect(injectedFromLog(tmp)).toEqual(["off_topic", "keeper"]);
  });

  it("reads injection counts from the hook-log tail when deps omit them", async () => {
    process.env["NLM_HOOK_LEX_FLOOR"] = "0"; // isolate the penalty
    // Three prior fires surfaced "hub" — countRecentInjections must see them
    // without any deps injection.
    appendPriorFires(join(tmp, "hook-log.jsonl"), ["hub", "hub", "hub"], ["other"]);
    const plateau = [
      hitWithLabel("hub", 0.99, "git merge pipeline work"),
      hitWithLabel("fresh_a", 0.9, "git merge pipeline work"),
    ];
    await runHook(
      { prompt: "rebase the feature branch onto main", conversationId: "later" },
      { mode: "shadow", recall: async () => plateau },
    );
    // count 3 -> 0.99 / (1 + 0.5 * ln 4) = ~0.59 -> demoted below fresh_a, and
    // below the relative floor for a 2-hit fire (median 0.9 * 0.9 = 0.81).
    expect(injectedFromLog(tmp)).toEqual(["fresh_a"]);
  });
});

function appendPriorFires(path: string, hubPrior: string[], otherPrior: string[]): void {
  const lines = hubPrior
    .map((id) => JSON.stringify({ ts: new Date().toISOString(), conversationId: "old", wouldInject: [id] }))
    .concat(otherPrior.map((id) => JSON.stringify({ ts: new Date().toISOString(), conversationId: "old2", wouldInject: [id] })))
    .join("\n");
  appendFileSync(path, `${lines}\n`, "utf8");
}
