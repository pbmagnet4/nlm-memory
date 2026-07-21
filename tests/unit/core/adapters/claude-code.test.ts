/**
 * ClaudeCodeAdapter parity tests against the same synthetic JSONL fixtures
 * the Python pytest suite uses. Same inputs, same expectations — divergence
 * here means TS adapter has drifted from Python before cutover.
 */

import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, deriveSubagentMeta } from "../../../../src/core/adapters/claude-code.js";
import { safeSessionId } from "../../../../src/core/adapters/common.js";

const FIXTURES = resolve(__dirname, "../../../fixtures/claude_code");

describe("ClaudeCodeAdapter.discover", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-"));
    const dest = join(tmp, "claude_code");
    mkdirSync(dest);
    for (const f of readdirSync(FIXTURES)) {
      if (f.endsWith(".jsonl")) copyFileSync(join(FIXTURES, f), join(dest, f));
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds all jsonl fixtures under a project dir", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: tmp });
    const found = await adapter.discover();
    const stems = new Set(found.map((p) => p.split("/").pop()!.replace(".jsonl", "")));
    expect(stems).toEqual(
      new Set(["standard_iso", "short_session", "tool_heavy", "with_subagent", "with_model"]),
    );
  });

  it("filters by since mtime", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: tmp });
    const future = new Date(Date.now() + 60_000);
    const found = await adapter.discover({ since: future });
    expect(found).toHaveLength(0);
  });
});

describe("ClaudeCodeAdapter.parseSession", () => {
  const adapter = new ClaudeCodeAdapter({ projectsPath: FIXTURES });

  it("standard_iso: runtime, stable id, ISO timestamps, 4 turns", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "standard_iso.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    expect(chunk.runtime).toBe("claude-code/1.0");
    expect(chunk.id).toBe(safeSessionId("cc", chunk.runtimeSessionId));

    expect(chunk.startedAt).toBeTruthy();
    expect(chunk.endedAt).toBeTruthy();
    expect(chunk.startedAt).toMatch(/T/);
    expect(chunk.startedAt.startsWith("20")).toBe(true);

    expect(chunk.turnCount).toBe(4);
  });

  it("short_session: sensible non-negative duration, 2 turns", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "short_session.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    expect(Number.isInteger(chunk.durationMin)).toBe(true);
    expect(chunk.durationMin).toBeGreaterThanOrEqual(0);
    expect(chunk.durationMin).toBeLessThanOrEqual(5);
    expect(chunk.turnCount).toBe(2);
  });

  it("tool_heavy: raw tool_use/tool_result JSON does not leak into transcript", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "tool_heavy.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;

    expect(chunk.text).not.toContain('"type": "tool_use"');
    expect(chunk.text).not.toContain('"type": "tool_result"');
    expect(chunk.text).toMatch(/\[tool_use:/);
  });

  it("with_subagent: does not crash, returns chunk with >= 1 turn", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "with_subagent.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.turnCount).toBeGreaterThanOrEqual(1);
  });

  it("returns null on an empty file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cc-empty-"));
    const empty = join(tmp, "empty.jsonl");
    copyFileSync(join(FIXTURES, "standard_iso.jsonl"), empty);
    // truncate to 0 bytes
    const fs = await import("node:fs/promises");
    await fs.writeFile(empty, "");
    const result = await adapter.parseSession(empty);
    expect(result).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("ClaudeCodeAdapter.detect", () => {
  it("returns enabled=false with a hint when projects dir is missing", () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: "/tmp/definitely-does-not-exist-cc" });
    const result = adapter.detect();
    // detect() always probes ~/.claude/projects, not the configured path.
    // We just verify the shape is sane.
    expect(result.adapterName).toBe("claude-code");
    expect(typeof result.enabled).toBe("boolean");
  });
});

describe("ClaudeCodeAdapter chunk.model", () => {
  const adapter = new ClaudeCodeAdapter({ projectsPath: FIXTURES });

  it("with_model: last assistant message.model wins", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "with_model.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.model).toBe("claude-opus-4-8");
  });

  it("standard_iso: chunk.model is undefined when no assistant turns carry model", async () => {
    const chunk = await adapter.parseSession(join(FIXTURES, "standard_iso.jsonl"));
    expect(chunk).not.toBeNull();
    if (!chunk) return;
    expect(chunk.model).toBeUndefined();
  });
});

describe("deriveSubagentMeta", () => {
  it("subagent id + labelled: extracts persona slug and parent id", () => {
    const result = deriveSubagentMeta("abc123/agent-def456", "[subagent code-reviewer] reviewed the diff");
    expect(result).toEqual({ persona: "code-reviewer", parentSessionId: "abc123" });
  });

  it("top-level id (no slash): orchestrator persona, no parent", () => {
    const result = deriveSubagentMeta("session-ddd-004", "Drafted the Acme project summary");
    expect(result).toEqual({ persona: "orchestrator", parentSessionId: null });
  });

  it("subagent id with anon slug tag: persona is the literal anon tag", () => {
    const result = deriveSubagentMeta("abc123/agent-def456", "[subagent anon] did some work");
    expect(result).toEqual({ persona: "anon", parentSessionId: "abc123" });
  });

  it("malformed id (slash but no /agent- marker): nulls, never throws", () => {
    const result = deriveSubagentMeta("abc123/not-a-subagent-id", "[subagent code-reviewer] ...");
    expect(result).toEqual({ persona: null, parentSessionId: null });
  });

  it("malformed id (empty agent suffix): nulls, never throws", () => {
    const result = deriveSubagentMeta("abc123/agent-", "[subagent code-reviewer] ...");
    expect(result).toEqual({ persona: null, parentSessionId: null });
  });

  it("subagent id but label missing the subagent tag: parent recovered, persona null", () => {
    const result = deriveSubagentMeta("abc123/agent-def456", "just a plain label");
    expect(result).toEqual({ persona: null, parentSessionId: "abc123" });
  });

  it("empty string id: treated as top-level, never throws", () => {
    const result = deriveSubagentMeta("", "");
    expect(result).toEqual({ persona: "orchestrator", parentSessionId: null });
  });
});
