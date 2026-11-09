import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_DREAM_MODEL,
  DREAM_MODEL_ENV,
  DreamJudgeError,
  DREAM_JUDGE_SYSTEM_PROMPT,
  buildDreamJudgeUserPrompt,
  dreamModelFromEnv,
  judgeDreamFact,
} from "@core/dream/judge.js";
import type { LLMClient } from "@ports/llm-client.js";

interface Call { readonly system: string; readonly user: string; readonly opts: Record<string, unknown> | undefined }

/** Stubbed chat lane: replies with a canned string and records each call.
 *  Everything else on the port is left unset — the judge must not need it. */
function stubLlm(reply: string): { llm: LLMClient; calls: Call[] } {
  const calls: Call[] = [];
  const llm = {
    complete: async (system: string, user: string, opts?: Record<string, unknown>) => {
      calls.push({ system, user, opts });
      return reply;
    },
  };
  return { llm: llm as unknown as LLMClient, calls };
}

const VERDICT = (v: string, evidence = "e") => `{"verdict":"${v}","evidence":"${evidence}"}`;

describe("dream judge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still-true carries the model's verbatim evidence quote", async () => {
    const { llm, calls } = stubLlm(VERDICT("still-true", "we shipped the judge on Tuesday"));
    const judgement = await judgeDreamFact({ llm, env: {} }, "judge ships Tuesday", "we shipped the judge on Tuesday");
    expect(judgement).toEqual({ verdict: "still-true", evidenceQuote: "we shipped the judge on Tuesday", model: DEFAULT_DREAM_MODEL });
    expect(calls[0]!.system).toBe(DREAM_JUDGE_SYSTEM_PROMPT);
    expect(calls[0]!.user).toBe(buildDreamJudgeUserPrompt("judge ships Tuesday", "we shipped the judge on Tuesday"));
  });

  it("contradicted passes through", async () => {
    const { llm } = stubLlm(VERDICT("contradicted", "actually we reverted the judge"));
    const judgement = await judgeDreamFact({ llm, env: {} }, "judge ships Tuesday", "actually we reverted the judge");
    expect(judgement.verdict).toBe("contradicted");
    expect(judgement.evidenceQuote).toBe("actually we reverted the judge");
  });

  it("unverifiable in a json fence passes through with an empty quote", async () => {
    const { llm } = stubLlm("```json\n" + VERDICT("unverifiable", "") + "\n```");
    const judgement = await judgeDreamFact({ llm, env: {} }, "judge ships Tuesday", "unrelated chatter");
    expect(judgement.verdict).toBe("unverifiable");
    expect(judgement.evidenceQuote).toBe("");
  });

  it("normalizes verdict spellings and caps evidence length", async () => {
    const { llm } = stubLlm(VERDICT(" Still_True ", "x".repeat(400)));
    const judgement = await judgeDreamFact({ llm, env: {} }, "fact", "excerpt");
    expect(judgement.verdict).toBe("still-true");
    expect(judgement.evidenceQuote).toHaveLength(300);
  });

  it("ignores a dangling thinking block before the object", async () => {
    const { llm } = stubLlm("<|im_start|>reasoning<tool_call> " + VERDICT("contradicted", "no"));
    expect((await judgeDreamFact({ llm, env: {} }, "fact", "excerpt")).verdict).toBe("contradicted");
  });

  it("empty content throws DreamJudgeError (failed call, not a verdict)", async () => {
    const { llm } = stubLlm("   \n ");
    await expect(judgeDreamFact({ llm, env: {} }, "fact", "excerpt")).rejects.toThrow(DreamJudgeError);
    await expect(judgeDreamFact({ llm, env: {} }, "fact", "excerpt")).rejects.toThrow(/empty content/);
  });

  it.each(["not json at all", VERDICT("maybe"), '{"verdict":', "[1,2]"])("unparseable reply %s throws", async (reply) => {
    const { llm } = stubLlm(reply);
    await expect(judgeDreamFact({ llm, env: {} }, "fact", "excerpt")).rejects.toThrow(/not a valid verdict object/);
  });

  it("throws when the wired client has no chat lane", async () => {
    await expect(judgeDreamFact({ llm: {} as unknown as LLMClient, env: {} }, "fact", "excerpt")).rejects.toThrow(DreamJudgeError);
  });

  it("propagates transport errors untouched", async () => {
    class TransportError extends Error {}
    const llm = { complete: async () => { throw new TransportError("socket closed"); } } as unknown as LLMClient;
    await expect(judgeDreamFact({ llm, env: {} }, "fact", "excerpt")).rejects.toThrow(TransportError);
  });

  it("model precedence: explicit dep > NLM_DREAM_MODEL > default", async () => {
    const { llm } = stubLlm(VERDICT("unverifiable", ""));
    const model = (deps: Parameters<typeof judgeDreamFact>[0]) => judgeDreamFact(deps, "f", "e").then((j) => j.model);
    await expect(model({ llm, model: "a", env: { [DREAM_MODEL_ENV]: "b" } })).resolves.toBe("a");
    await expect(model({ llm, model: "   ", env: { [DREAM_MODEL_ENV]: "b" } })).resolves.toBe("b");
    await expect(model({ llm, env: { [DREAM_MODEL_ENV]: "  " } })).resolves.toBe(DEFAULT_DREAM_MODEL);
    await expect(model({ llm, env: {} })).resolves.toBe(DEFAULT_DREAM_MODEL);
  });

  it("env is injectable — dreamModelFromEnv reads the passed record, not process.env", () => {
    expect(dreamModelFromEnv({ [DREAM_MODEL_ENV]: "env-model" })).toBe("env-model");
    expect(dreamModelFromEnv({ [DREAM_MODEL_ENV]: "  " })).toBe(DEFAULT_DREAM_MODEL);
    expect(dreamModelFromEnv({})).toBe(DEFAULT_DREAM_MODEL);
  });

  it("sends the no-thinking chat options and never reaches the network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network in a unit test"); }));
    const { llm, calls } = stubLlm(VERDICT("still-true"));
    const controller = new AbortController();
    await judgeDreamFact({ llm, env: {}, maxTokens: 128, signal: controller.signal }, "fact", "excerpt");
    expect(calls[0]!.opts).toEqual({ enable_thinking: false, signal: controller.signal, maxTokens: 128 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strips a think block but keeps angle brackets in the verdict evidence", async () => {
    const { llm } = stubLlm(
      "<think>deliberating about Array<string> and im_start tokens</think>" +
      VERDICT("contradicted", "use Array<string> for lists"),
    );
    const judgement = await judgeDreamFact({ llm, env: {} }, "fact", "use Array<string> for lists");
    expect(judgement.verdict).toBe("contradicted");
    expect(judgement.evidenceQuote).toBe("use Array<string> for lists");
  });

  it("leaves im_start substrings and bare angle brackets in replies intact", async () => {
    const { llm } = stubLlm(VERDICT("still-true", "see im_start<span> docs"));
    const judgement = await judgeDreamFact({ llm, env: {} }, "fact", "excerpt");
    expect(judgement.verdict).toBe("still-true");
    expect(judgement.evidenceQuote).toBe("see im_start<span> docs");
  });
});
