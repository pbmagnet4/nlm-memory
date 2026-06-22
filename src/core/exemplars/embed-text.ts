/**
 * The embed payload for a code exemplar is `taskContext + "\n" + code`. The
 * code embedder (CodeRankEmbed) has a ~512-token context window; a real commit
 * diff easily exceeds it, at which point Ollama returns HTTP 500 ("the input
 * length exceeds the context length") and the vector is silently dropped —
 * leaving the exemplar unretrievable (recall_code is vector-only).
 *
 * composeEmbedText is the single place both the live capture path and the
 * backfill build that payload, capping it so the embed always fits. 2000 chars
 * sits comfortably under the window even for token-dense code (empirically the
 * window tolerates ~4000 chars; 2000 leaves margin for the model's prompt
 * prefix and tokenizer variance).
 */

export const EMBED_TEXT_CAP = 2000;

export function composeEmbedText(taskContext: string, code: string): string {
  return (taskContext + "\n" + code).slice(0, EMBED_TEXT_CAP);
}
