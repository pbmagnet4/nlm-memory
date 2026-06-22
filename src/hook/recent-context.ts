/**
 * Recent-conversation context for the recall hook.
 *
 * Thin prompts ("what do you recommend?", "do it") carry no topic, so recalling
 * on the bare prompt surfaces off-topic sessions (measured: 82% off-topic). When
 * the prompt is thin we prepend the last few conversation turns — that is where
 * the topic actually lives — to the recall query.
 *
 * Hot-path safe: TAIL-reads at most `maxBytes` of the transcript (not the whole
 * file, which can be MBs in a long session), and only thin prompts call it.
 * Fail-open: any I/O or parse error yields "" so the hook never breaks and the
 * caller falls back to bare-prompt recall (today's behavior).
 *
 * Runtime-specific: only runtimes that expose a transcript path can use this
 * (Claude Code does). Others pass no path and get "" → bare-prompt fallback.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

const DEFAULT_MAX_TURNS = 3;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_PER_TURN_CHARS = 400;

interface Opts {
  readonly maxTurns?: number;
  readonly maxBytes?: number;
  readonly perTurnChars?: number;
}

// Conversational / function words that carry no recall topic. A prompt with few
// NON-stopword words is "thin" — that is the off-topic failure band ("what do you
// recommend", "do it now"), not a raw token count (which counts do/you/the).
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "doing", "you", "your", "i", "we", "our", "it", "its", "this", "that",
  "these", "those", "what", "which", "how", "why", "when", "where", "who", "can", "could",
  "would", "should", "will", "shall", "may", "might", "must", "please", "to", "of", "in", "on",
  "for", "with", "so", "now", "then", "here", "there", "just", "also", "as", "at", "by", "if",
  "my", "me", "us", "ok", "okay", "yes", "no", "not", "up", "out", "go", "get", "got", "make",
  "made", "give", "tell", "want", "need", "think", "know", "let", "lets", "about", "from", "into",
]);

/** Count topical (non-stopword) words — the thinness signal for context-recall. */
export function topicalWordCount(s: string): number {
  const tokens = s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  return tokens.filter((t) => !STOPWORDS.has(t)).length;
}

function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** Read at most `maxBytes` from the end of the file. */
function tailRead(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function recentConversationContext(transcriptPath: string, opts: Opts = {}): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return "";
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const perTurnChars = opts.perTurnChars ?? DEFAULT_PER_TURN_CHARS;
    const lines = tailRead(transcriptPath, opts.maxBytes ?? DEFAULT_MAX_BYTES).split("\n");

    const turns: string[] = [];
    // Walk from the end; a tail read may truncate the first line mid-JSON, which
    // JSON.parse rejects and we skip — that is the intended "drop partial leading
    // line" behavior.
    for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let evt: { type?: unknown; message?: unknown };
      try {
        evt = JSON.parse(line) as { type?: unknown; message?: unknown };
      } catch {
        continue;
      }
      if (evt.type !== "user" && evt.type !== "assistant") continue;
      const text = textOf(evt.message).trim();
      if (!text) continue;
      turns.unshift(text.slice(0, perTurnChars));
    }
    return turns.join(" ").trim();
  } catch {
    return "";
  }
}
