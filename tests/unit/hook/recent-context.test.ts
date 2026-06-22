import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recentConversationContext } from "../../../src/hook/recent-context.js";

function turn(type: "user" | "assistant", text: string): string {
  return JSON.stringify({ type, message: { role: type, content: text } });
}

describe("recentConversationContext", () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-recent-"));
    path = join(tmp, "transcript.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns the last N turns' text, oldest-first", () => {
    writeFileSync(
      path,
      [
        turn("user", "first thing about the hook gate"),
        turn("assistant", "I recommend deploying the score floor"),
        turn("user", "what do you recommend in this case"),
      ].join("\n"),
    );
    const ctx = recentConversationContext(path, { maxTurns: 2 });
    // last 2 turns, in order
    expect(ctx).toBe("I recommend deploying the score floor what do you recommend in this case");
  });

  it("parses array-shaped assistant content (text blocks only)", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "score floor calibration" }, { type: "tool_use", name: "Bash" }] },
        }),
      ].join("\n"),
    );
    expect(recentConversationContext(path, { maxTurns: 1 })).toBe("score floor calibration");
  });

  it("caps each turn to perTurnChars", () => {
    writeFileSync(path, turn("user", "x".repeat(1000)));
    expect(recentConversationContext(path, { maxTurns: 1, perTurnChars: 50 }).length).toBe(50);
  });

  it("returns empty string for a missing or empty path", () => {
    expect(recentConversationContext(join(tmp, "nope.jsonl"))).toBe("");
    expect(recentConversationContext("")).toBe("");
  });

  it("tail-reads a large transcript without choking, dropping the partial leading line", () => {
    const big = turn("assistant", "OLD ".repeat(50000)); // > maxBytes
    const recent = turn("user", "recent question about pgvector");
    writeFileSync(path, [big, recent].join("\n"));
    const ctx = recentConversationContext(path, { maxTurns: 1, maxBytes: 4096 });
    expect(ctx).toBe("recent question about pgvector");
  });

  it("skips non-message events (system, queue-operation) and blank lines", () => {
    writeFileSync(
      path,
      [
        turn("user", "real question"),
        JSON.stringify({ type: "system", subtype: "hook" }),
        "",
        JSON.stringify({ type: "queue-operation", operation: "x" }),
      ].join("\n"),
    );
    expect(recentConversationContext(path, { maxTurns: 3 })).toBe("real question");
  });
});
