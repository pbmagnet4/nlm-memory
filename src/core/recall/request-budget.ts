import { LLMUnreachableError, type EmbedResult, type LLMClient } from "@ports/llm-client.js";
import type { RecallExecutionOptions } from "./execution-options.js";
import { recallEmbedBreaker, type CircuitBreaker } from "@core/health/embed-breaker.js";

export class RequestBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly parent: AbortSignal | undefined;
  private readonly onAbort = () => this.controller.abort(new Error("recall cancelled"));

  constructor(timeoutMs: number, options: Pick<RecallExecutionOptions, "signal" | "deadlineAt" | "now" | "workTracker"> = {}) {
    this.workTracker = options.workTracker;
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
  private readonly workTracker: RecallExecutionOptions["workTracker"];
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
      const work = operation();
      const result = await Promise.race([this.workTracker?.track(work) ?? work, stopped]);
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
  breaker: CircuitBreaker = recallEmbedBreaker,
): Promise<EmbedResult> {
  const key = options.queryEmbeddingIdentity;
  const shared = key?.client === client && key.text === text && key.kind === "query" ? options.queryEmbedding : undefined;
  // T1774: a dead embedder answers at once instead of after capMs. The shared
  // embedding is itself an embedForRecall call, so it already passed the breaker.
  if (!shared && !breaker.allow()) throw new LLMUnreachableError("recall-embedding", new Error("embedder circuit open"));
  // Only a timeout with the whole capMs to spend says the embedder is slow; a
  // shorter request deadline or a cancelled caller says nothing about it.
  const fullBudget = (options.deadlineAt ?? Infinity) - (options.now ?? (() => performance.now()))() >= capMs;
  const budget = new RequestBudget(capMs, options);
  try {
    const result = await budget.run(() => shared ?? client.embed(text, "query", { signal: budget.signal }));
    if (!shared) breaker.success();
    return result;
  } catch (error) {
    if (!shared) {
      if (options.signal?.aborted || (budget.signal.aborted && !fullBudget)) breaker.release();
      else breaker.failure(error instanceof Error ? error.message : String(error));
    }
    throw error instanceof LLMUnreachableError ? error : new LLMUnreachableError("recall-embedding", error);
  } finally {
    budget.dispose();
  }
}
