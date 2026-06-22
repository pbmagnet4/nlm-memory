import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecallQuery } from "../../../src/hook/prompt-recall-hook.js";

const ON = { NLM_HOOK_CONTEXT_RECALL: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe("buildRecallQuery (context-recall, flag-gated)", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-bq-"));
    path = join(tmp, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "deploy the score floor on the hook gate" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "what do you recommend" } }),
      ].join("\n"),
    );
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns the bare prompt when the flag is OFF (default)", () => {
    const thin = { prompt: "what do you recommend", conversationId: "c1", transcriptPath: path };
    expect(buildRecallQuery(thin, OFF)).toBe("what do you recommend");
  });

  it("augments a thin prompt with recent context when the flag is ON", () => {
    const thin = { prompt: "what do you recommend", conversationId: "c1", transcriptPath: path };
    const q = buildRecallQuery(thin, ON);
    expect(q).toContain("score floor on the hook gate"); // topic pulled from context
    expect(q).toContain("what do you recommend"); // current prompt preserved
    expect(q.endsWith("what do you recommend")).toBe(true);
  });

  it("does NOT touch a specific prompt (>= min content words) even with the flag on", () => {
    const specific = { prompt: "why does fact recall return zero rows", conversationId: "c1", transcriptPath: path };
    expect(buildRecallQuery(specific, ON)).toBe("why does fact recall return zero rows");
  });

  it("falls back to the bare prompt when no transcript path is available", () => {
    expect(buildRecallQuery({ prompt: "do it now", conversationId: "c1" }, ON)).toBe("do it now");
  });

  it("falls back to the bare prompt when the transcript yields no context", () => {
    const empty = join(tmp, "missing.jsonl");
    expect(buildRecallQuery({ prompt: "do it now", conversationId: "c1", transcriptPath: empty }, ON)).toBe("do it now");
  });
});
