/**
 * composeEmbedText caps the embed payload so the code embedder never 500s on
 * an over-context input. CodeRankEmbed has a ~512-token window; an exemplar
 * with a large code body (the common case for a real commit) blows past it,
 * Ollama returns "input length exceeds the context length", and the vector is
 * dropped — leaving the exemplar permanently unretrievable. The cap is the
 * fix: both the live capture path and the backfill build their embed input
 * through this helper so the two stay identical and both stay under the limit.
 */

import { describe, expect, it } from "vitest";
import { EMBED_TEXT_CAP, composeEmbedText } from "../../../../src/core/exemplars/embed-text.js";

describe("composeEmbedText", () => {
  it("joins task context and code with a newline", () => {
    expect(composeEmbedText("add two numbers", "return a + b;")).toBe("add two numbers\nreturn a + b;");
  });

  it("caps the combined output at EMBED_TEXT_CAP characters", () => {
    const code = "x".repeat(EMBED_TEXT_CAP * 2);
    const out = composeEmbedText("task", code);
    expect(out.length).toBe(EMBED_TEXT_CAP);
  });

  it("keeps the task context when the code is what overflows", () => {
    const task = "feat: meaningful task label";
    const out = composeEmbedText(task, "y".repeat(EMBED_TEXT_CAP * 2));
    expect(out.startsWith(task + "\n")).toBe(true);
  });

  it("leaves a short payload untouched", () => {
    const out = composeEmbedText("short", "code");
    expect(out.length).toBeLessThanOrEqual(EMBED_TEXT_CAP);
    expect(out).toBe("short\ncode");
  });
});
