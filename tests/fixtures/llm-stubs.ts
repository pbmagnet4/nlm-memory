import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";

export class FixedEmbedder implements LLMClient {
  constructor(private readonly vector: Float32Array = new Float32Array(768)) {}
  async embed(): Promise<EmbedResult> { return { vector: this.vector, model: "fixed-test" }; }
  async rewriteForRecall(): Promise<never> { throw new Error("not used in tests"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("not used in this test"); }
}

export class StubEmbedder implements LLMClient {
  calls = 0;
  constructor(private readonly fail: boolean = false) {}
  async embed(): Promise<EmbedResult> {
    this.calls++;
    if (this.fail) throw new LLMUnreachableError("ollama");
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
