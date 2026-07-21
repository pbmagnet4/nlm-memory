/**
 * transcript-derivables — post-classify scan of the raw transcript file for
 * primary_model/total_tokens/skill (#352 phase 2, Task 5). Complements
 * deriveSubagentMeta (Task 2), which derives persona/parent from the chunk's
 * already-parsed runtimeSessionId + label; this scan needs the per-message
 * `model` + `usage` + `tool_use` blocks the chunk parser summarizes away, so
 * it re-reads the transcript file directly.
 *
 * v1 supports claude-code-jsonl only: assistant events carry `message.model`
 * and `message.usage.{input,output}_tokens` (same fields
 * claude-code.ts's parseSession already reads for `lastModel`); a Skill-tool
 * invocation is a `content` block with `type: "tool_use"`, `name: "Skill"`,
 * and `input.skill` holding the slug (e.g. "superpowers:brainstorming").
 * Every other transcript kind returns all-null — no per-runtime scanner
 * exists yet.
 *
 * Streamed line-by-line (readline over a ReadStream), never readFileSync:
 * transcripts reach tens of MB and this runs on the ingest write path, not
 * just backfill. A missing, unreadable, or rotated-away file resolves nulls
 * rather than rejecting — never throws.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const CLAUDE_CODE_JSONL_KIND = "claude-code-jsonl";

export interface TranscriptDerivables {
  readonly primaryModel: string | null;
  readonly totalTokens: number | null;
  readonly skill: string | null;
}

const NULL_DERIVABLES: TranscriptDerivables = {
  primaryModel: null,
  totalTokens: null,
  skill: null,
};

export function scanTranscriptDerivables(path: string, kind: string): Promise<TranscriptDerivables> {
  if (kind !== CLAUDE_CODE_JSONL_KIND) return Promise.resolve(NULL_DERIVABLES);

  return new Promise((resolve) => {
    const modelCounts = new Map<string, number>();
    const modelLastSeenAt = new Map<string, number>();
    let lineNumber = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let skill: string | null = null;
    let settled = false;

    const finish = (result: TranscriptDerivables): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let stream;
    try {
      stream = createReadStream(path, { encoding: "utf8" });
    } catch {
      // Synchronous throw (e.g. malformed path) — most fs errors surface via
      // the 'error' event below instead.
      finish(NULL_DERIVABLES);
      return;
    }

    // Missing/unreadable/rotated-away file — resolve nulls, never throw.
    stream.on("error", () => finish(NULL_DERIVABLES));

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("error", () => finish(NULL_DERIVABLES));

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      lineNumber += 1;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }

      if (evt["type"] !== "assistant") return;
      const msg = (evt["message"] as Record<string, unknown> | undefined) ?? {};

      const model = msg["model"];
      if (typeof model === "string" && model) {
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
        modelLastSeenAt.set(model, lineNumber);
      }

      const usage = msg["usage"] as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        const input = usage["input_tokens"];
        const output = usage["output_tokens"];
        if (typeof input === "number") {
          inputTokens += input;
          sawUsage = true;
        }
        if (typeof output === "number") {
          outputTokens += output;
          sawUsage = true;
        }
      }

      if (skill === null) {
        const content = msg["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if (b["type"] === "tool_use" && b["name"] === "Skill") {
              const toolInput = b["input"] as Record<string, unknown> | undefined;
              const slug = toolInput?.["skill"];
              if (typeof slug === "string" && slug) skill = slug;
              break;
            }
          }
        }
      }
    });

    rl.on("close", () => {
      finish({
        primaryModel: majorityModel(modelCounts, modelLastSeenAt),
        totalTokens: sawUsage ? inputTokens + outputTokens : null,
        skill,
      });
    });
  });
}

/** Majority wins by occurrence count; ties break to whichever model's last
 *  occurrence is chronologically latest in the transcript. */
function majorityModel(
  counts: ReadonlyMap<string, number>,
  lastSeenAt: ReadonlyMap<string, number>,
): string | null {
  let best: string | null = null;
  let bestCount = -1;
  let bestLastSeenAt = -1;
  for (const [model, count] of counts) {
    const lastSeen = lastSeenAt.get(model) ?? -1;
    if (count > bestCount || (count === bestCount && lastSeen > bestLastSeenAt)) {
      best = model;
      bestCount = count;
      bestLastSeenAt = lastSeen;
    }
  }
  return best;
}
