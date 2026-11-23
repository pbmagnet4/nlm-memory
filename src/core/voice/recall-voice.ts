/**
 * recall-voice — the voice recall lane (design §D).
 *
 * Embeds the request with the prose embedder behind the T1774 breaker and
 * ranks published/approved samples of the voice, requested channel first.
 * With no embedder reachable the lane degrades to the newest published
 * samples of the channel; with neither rules nor samples the result is
 * empty, never an error.
 */

import { randomUUID } from "node:crypto";
import { embedForRecall } from "@core/recall/request-budget.js";
import type { RecallExecutionOptions } from "@core/recall/execution-options.js";
import { LLMUnreachableError, type LLMClient } from "@ports/llm-client.js";
import type {
  WritingSampleHit,
  WritingSampleStore,
} from "@ports/writing-sample-store.js";
import { voiceRules } from "./rules.js";

export interface RecallVoiceDeps {
  readonly writingSamples: WritingSampleStore;
  /** Null when the prose embedder is not wired: newest-first fallback. */
  readonly embedClient: LLMClient | null;
  /** Receives the invalid-rules WARN (one per file change); silent by default. */
  readonly log?: ((message: string) => void) | undefined;
}

export interface RecallVoiceInput {
  readonly voice: string;
  readonly channel: string;
  readonly audience?: string | undefined;
  readonly request: string;
  /** Default 3. */
  readonly k?: number | undefined;
  /** Response character budget. Default 6000. */
  readonly maxChars?: number | undefined;
}

export interface RecallVoiceExample {
  readonly id: string;
  readonly channel: string;
  readonly source: string;
  readonly outcome: string;
  readonly text: string;
  readonly source_ref: string | null;
  readonly distance: number | null;
}

export interface RecallVoiceAvoid {
  readonly id: string;
  readonly text: string;
  readonly distance: number;
}

export interface RecallVoiceResult {
  readonly rules: ReadonlyArray<string> | null;
  readonly rules_version: string | null;
  readonly banned_phrases: ReadonlyArray<string>;
  readonly examples: ReadonlyArray<RecallVoiceExample>;
  readonly avoid: ReadonlyArray<RecallVoiceAvoid>;
  readonly draft_id: string;
  readonly truncated: boolean;
}

const DEFAULT_K = 3;
const DEFAULT_MAX_CHARS = 6000;
const EMBED_DEADLINE_MS = 2_000;
const AVOID_LIMIT = 2;

function clampK(k: number | undefined): number {
  if (k === undefined) return DEFAULT_K;
  return Math.max(1, Math.min(10, Math.trunc(k)));
}

/** Published before approved, then by distance — the design §D.1 tiering. */
function toExample(
  hit: Pick<WritingSampleHit, "id" | "channel" | "source" | "outcome" | "text" | "sourceRef">,
  distance: number | null,
): RecallVoiceExample {
  return {
    id: hit.id,
    channel: hit.channel,
    source: hit.source,
    outcome: hit.outcome,
    text: hit.text,
    source_ref: hit.sourceRef,
    distance,
  };
}

export async function recallVoice(
  deps: RecallVoiceDeps,
  tenantId: string,
  input: RecallVoiceInput,
  execution: RecallExecutionOptions = {},
): Promise<RecallVoiceResult> {
  const k = clampK(input.k);
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  let queryVector: Float32Array | null = null;
  if (deps.embedClient) {
    try {
      queryVector = (await embedForRecall(deps.embedClient, input.request, execution, EMBED_DEADLINE_MS)).vector;
    } catch (error) {
      if (!(error instanceof LLMUnreachableError)) throw error;
    }
  }

  let examples: RecallVoiceExample[];
  let avoid: RecallVoiceAvoid[];
  if (queryVector) {
    const vector = queryVector;
    // Tiered by fetching, not by sorting a mixed top-k: published samples come
    // first and approved ones only fill what published cannot, so a near
    // approved sample never displaces a published one just past the k-th slot.
    const tieredSearch = async (channel: string | undefined, want: number, exclude: ReadonlySet<string>) => {
      const take = async (outcome: "published" | "approved", n: number) =>
        n <= 0 ? [] : (await deps.writingSamples.search(tenantId, vector, {
          voice: input.voice,
          ...(channel !== undefined ? { channel } : {}),
          outcomes: [outcome],
          k: Math.min(50, n + exclude.size),
        })).filter((hit) => !exclude.has(hit.id) && (channel !== undefined || hit.channel !== input.channel)).slice(0, n);
      const published = await take("published", want);
      return [...published, ...(await take("approved", want - published.length))];
    };
    const primary = await tieredSearch(input.channel, k, new Set());
    examples = primary.map((hit) => toExample(hit, hit.distance));
    if (examples.length < k) {
      const others = await tieredSearch(undefined, k - examples.length, new Set(examples.map((e) => e.id)));
      examples.push(...others.map((hit) => toExample(hit, hit.distance)));
    }
    avoid = [];
    const last = examples[examples.length - 1];
    if (last && last.distance !== null) {
      const band = last.distance;
      const rejected = await deps.writingSamples.search(tenantId, vector, {
        voice: input.voice,
        channel: input.channel,
        outcomes: ["rejected"],
        k: AVOID_LIMIT,
      });
      avoid = rejected
        .filter((hit) => hit.distance <= band)
        .slice(0, AVOID_LIMIT)
        .map((hit) => ({ id: hit.id, text: hit.text, distance: hit.distance }));
    }
  } else {
    const fresh = await deps.writingSamples.latest(tenantId, {
      voice: input.voice,
      channel: input.channel,
      outcomes: ["published"],
      k,
    });
    examples = fresh.map((hit) => toExample(hit, null));
    avoid = [];
  }

  const resolved = voiceRules(
    process.env["NLM_VOICE_RULES_DIR"],
    input.voice,
    input.channel,
    input.audience,
    deps.log,
  );

  const result: {
    rules: ReadonlyArray<string> | null;
    rules_version: string | null;
    banned_phrases: ReadonlyArray<string>;
    examples: RecallVoiceExample[];
    avoid: RecallVoiceAvoid[];
    draft_id: string;
    truncated: boolean;
  } = {
    rules: resolved?.rules ?? null,
    rules_version: resolved?.rulesVersion ?? null,
    banned_phrases: resolved?.bannedPhrases ?? [],
    examples,
    avoid,
    draft_id: randomUUID(),
    truncated: false,
  };
  let truncated = false;
  while (JSON.stringify(result).length > maxChars && result.examples.length > 0) {
    result.examples.pop();
    truncated = true;
  }
  while (JSON.stringify(result).length > maxChars && result.avoid.length > 0) {
    result.avoid.pop();
    truncated = true;
  }
  result.truncated = truncated;
  return result;
}
