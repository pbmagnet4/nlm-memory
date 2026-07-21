/**
 * Unit tests for scanTranscriptDerivables (#352 phase 2, Task 5).
 *
 * Writes synthetic jsonl fixtures to a tmp dir per test (mirrors the
 * mkdtempSync pattern used by backfill-derivables.test.ts / claude-code
 * adapter tests) and asserts on majority-model selection, tie-break to
 * last-seen, token summing, first-Skill extraction, missing-file safety,
 * and the non-claude-code-kind short circuit.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanTranscriptDerivables } from "../../../../src/core/ingest/transcript-derivables.js";

function assistantLine(over: {
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: unknown;
}): string {
  const content = over.content ?? "text";
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      ...(over.model ? { model: over.model } : {}),
      ...(over.usage ? { usage: over.usage } : {}),
      content,
    },
  });
}

function userLine(text = "hi"): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

describe("scanTranscriptDerivables", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-transcript-derivables-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(lines: string[]): string {
    const path = join(tmp, "session.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  }

  it("3 models: majority wins", async () => {
    const path = writeTranscript([
      userLine(),
      assistantLine({ model: "claude-opus-4-7" }),
      assistantLine({ model: "claude-sonnet-4-5" }),
      assistantLine({ model: "claude-sonnet-4-5" }),
      assistantLine({ model: "claude-haiku-4-5" }),
      assistantLine({ model: "claude-sonnet-4-5" }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.primaryModel).toBe("claude-sonnet-4-5");
  });

  it("tied model counts: last-seen wins", async () => {
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-7" }),
      assistantLine({ model: "claude-sonnet-4-5" }),
      assistantLine({ model: "claude-opus-4-7" }),
      assistantLine({ model: "claude-sonnet-4-5" }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    // Both appear twice; claude-sonnet-4-5's last occurrence is the later line.
    expect(result.primaryModel).toBe("claude-sonnet-4-5");
  });

  it("sums input_tokens + output_tokens across assistant messages", async () => {
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-7", usage: { input_tokens: 100, output_tokens: 20 } }),
      assistantLine({ model: "claude-opus-4-7", usage: { input_tokens: 50, output_tokens: 5 } }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.totalTokens).toBe(175);
  });

  it("no usage on any assistant message: totalTokens is null, not 0", async () => {
    const path = writeTranscript([assistantLine({ model: "claude-opus-4-7" })]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.totalTokens).toBeNull();
  });

  it("extracts the first Skill tool_use invocation's slug", async () => {
    const path = writeTranscript([
      assistantLine({
        content: [
          { type: "text", text: "Let me check that." },
          { type: "tool_use", id: "t1", name: "Skill", input: { skill: "superpowers:brainstorming", args: "x" } },
        ],
      }),
      assistantLine({
        content: [
          { type: "tool_use", id: "t2", name: "Skill", input: { skill: "code-review" } },
        ],
      }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.skill).toBe("superpowers:brainstorming");
  });

  it("no Skill tool_use anywhere: skill is null", async () => {
    const path = writeTranscript([
      assistantLine({
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } }],
      }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.skill).toBeNull();
  });

  it("missing file: resolves all-null, never throws", async () => {
    const path = join(tmp, "does-not-exist.jsonl");
    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result).toEqual({ primaryModel: null, totalTokens: null, skill: null });
  });

  it("hermes (non-claude-code) kind: all-null without reading the file", async () => {
    const path = writeTranscript([
      assistantLine({ model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);

    const result = await scanTranscriptDerivables(path, "hermes-json");
    expect(result).toEqual({ primaryModel: null, totalTokens: null, skill: null });
  });

  it("malformed JSON lines are skipped, not fatal", async () => {
    const path = writeTranscript([
      "{not valid json",
      assistantLine({ model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 } }),
    ]);

    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result.primaryModel).toBe("claude-opus-4-7");
    expect(result.totalTokens).toBe(15);
  });

  it("empty file: all-null", async () => {
    const path = writeTranscript([]);
    const result = await scanTranscriptDerivables(path, "claude-code-jsonl");
    expect(result).toEqual({ primaryModel: null, totalTokens: null, skill: null });
  });
});
