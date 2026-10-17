import type { EmbedResult, EmbeddingKind, LLMClient } from "@ports/llm-client.js";
import type { FactRecallResult, RecallResult } from "@shared/types.js";

export interface RecallExecutionOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly now?: () => number;
  readonly queryEmbedding?: Promise<EmbedResult>;
  readonly queryEmbeddingIdentity?: { readonly text: string; readonly kind: EmbeddingKind; readonly client: LLMClient };
  readonly onPartialFacts?: (result: FactRecallResult) => Promise<void>;
  readonly onPartialSessions?: (result: RecallResult) => Promise<void>;
  readonly workstreamIds?: readonly string[];
}

export async function executionWorkstreamIds(
  tenantId: string, selector: string | undefined, options: RecallExecutionOptions,
  resolver?: (tenantId: string, idOrLabel: string) => Promise<readonly string[]>,
): Promise<readonly string[] | undefined> {
  if (selector === undefined) return options.workstreamIds;
  const resolved = resolver ? await resolver(tenantId, selector) : [];
  if (options.workstreamIds !== undefined) {
    const requested = new Set(options.workstreamIds);
    if (resolved.length !== requested.size || resolved.some((id) => !requested.has(id))) {
      throw new Error("Inconsistent recall scope constraints");
    }
  }
  return resolved;
}
