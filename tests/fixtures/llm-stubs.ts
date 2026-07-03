import type { ClassifyResult, EmbedResult, EmbeddingKind, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";

export class FixedEmbedder implements LLMClient {
  constructor(private readonly vector: Float32Array = new Float32Array(768)) {}
  async embed(): Promise<EmbedResult> { return { vector: this.vector, model: "fixed-test" }; }
  async rewriteForRecall(): Promise<never> { throw new Error("not used in tests"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used in this test"); }
}

export interface StubEmbedderOpts {
  fail?: boolean;
  /** Hang until the provided AbortSignal fires (or forever if no signal is passed). */
  hang?: boolean;
}

export class StubEmbedder implements LLMClient {
  calls = 0;
  private readonly _fail: boolean;
  private readonly _hang: boolean;

  constructor(optsOrFail: boolean | StubEmbedderOpts = false) {
    if (typeof optsOrFail === "boolean") {
      this._fail = optsOrFail;
      this._hang = false;
    } else {
      this._fail = optsOrFail.fail ?? false;
      this._hang = optsOrFail.hang ?? false;
    }
  }

  async embed(_text: string, _kind: EmbeddingKind, opts?: { signal?: AbortSignal }): Promise<EmbedResult> {
    this.calls++;
    if (this._hang) {
      await new Promise<void>((_res, rej) => {
        const sig = opts?.signal;
        if (sig?.aborted) { rej(new LLMUnreachableError("stub-embedder", "aborted")); return; }
        sig?.addEventListener("abort", () => rej(new LLMUnreachableError("stub-embedder", "aborted")), { once: true });
      });
    }
    if (this._fail) throw new LLMUnreachableError("ollama");
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "stub" };
  }
  async rewriteForRecall(): Promise<never> { throw new Error("not used in tests"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used"); }
}

export const DEFAULT_CLASSIFY_RESULT: ClassifyResult = {
  label: "Stub label",
  summary: "Stub summary",
  entities: ["NLM"],
  decisions: ["chose Hono"],
  open: [],
  confidence: 0.9,
  facts: [],
};

export class StubClassifier implements LLMClient {
  calls = 0;
  constructor(
    private readonly result: ClassifyResult = DEFAULT_CLASSIFY_RESULT,
    private readonly throwError: boolean = false,
  ) {}
  async embed(): Promise<EmbedResult> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used in tests"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<ClassifyResult> {
    this.calls++;
    if (this.throwError) throw new Error("classifier blew up");
    return this.result;
  }
}
