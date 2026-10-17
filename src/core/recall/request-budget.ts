import { LLMUnreachableError, type EmbedResult, type LLMClient } from "@ports/llm-client.js";
import type { RecallExecutionOptions } from "./execution-options.js";

export class RequestBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly parent: AbortSignal | undefined;
  private readonly onAbort = () => this.controller.abort(new Error("recall cancelled"));

  constructor(timeoutMs: number, options: Pick<RecallExecutionOptions, "signal" | "deadlineAt" | "now"> = {}) {
    this.now = options.now ?? (() => performance.now());
    this.deadlineAt = Math.min(this.now() + timeoutMs, options.deadlineAt ?? Infinity);
    this.signal = this.controller.signal;
    this.parent = options.signal;
    if (this.parent?.aborted || this.remaining() <= 0) this.onAbort();
    else {
      this.parent?.addEventListener("abort", this.onAbort, { once: true });
      this.timer = setTimeout(this.onAbort, this.remaining());
    }
  }

  readonly now: () => number;
  remaining(): number { return Math.max(0, this.deadlineAt - this.now()); }
  check(): void {
    if (this.remaining() <= 0 && !this.signal.aborted) this.onAbort();
    this.signal.throwIfAborted();
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([operation(), stopped]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
    this.onAbort();
  }
}

export async function embedForRecall(
  client: LLMClient, text: string, options: RecallExecutionOptions, capMs: number,
): Promise<EmbedResult> {
  const budget = new RequestBudget(capMs, options);
  try {
    return await budget.run(() => {
      const key = options.queryEmbeddingIdentity;
      return key?.client === client && key.text === text && key.kind === "query" && options.queryEmbedding
        ? options.queryEmbedding : client.embed(text, "query", { signal: budget.signal });
    });
  } catch (error) {
    throw error instanceof LLMUnreachableError ? error : new LLMUnreachableError("recall-embedding", error);
  } finally {
    budget.dispose();
  }
}
