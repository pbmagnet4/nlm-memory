/**
 * Hierarchical (map-reduce) classification for oversized session bodies.
 *
 * Ollama's num_ctx (16384 tokens, ~50-60K chars) silently truncates input
 * beyond the window, so a single classify pass only attends to the head of a
 * large transcript. classifyLarge chunks the body to fit the window, classifies
 * each chunk, and reduces deterministically. classifyAdaptive routes by length.
 */
import { chunkSessionText } from "@core/embedding/chunk-body.js";
import type { ClassifyResult, LLMClient } from "@ports/llm-client.js";

/** Bodies at or under this length go single-pass; larger ones are chunked. */
export const SINGLE_PASS_CHAR_BUDGET = 40_000;
const CHUNK_CHARS = 40_000;
const CHUNK_OVERLAP = 1_000;

function dedupeCaseInsensitive(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export async function classifyLarge(text: string, classifier: LLMClient): Promise<ClassifyResult> {
  const chunks = chunkSessionText({ body: text }, { maxChars: CHUNK_CHARS, overlap: CHUNK_OVERLAP });
  if (chunks.length === 0) {
    return { label: "", summary: "", entities: [], decisions: [], open: [], confidence: 0, facts: [] };
  }
  const results: ClassifyResult[] = [];
  for (const chunk of chunks) {
    try {
      results.push(await classifier.classify(chunk));
    } catch {
      // Tolerate a chunk that still failed after the client's own retries:
      // skip it and classify from the survivors. If every chunk fails, the
      // results.length === 0 guard below throws.
    }
  }
  if (results.length === 0) {
    throw new Error(`classifyLarge: all ${chunks.length} chunks failed classification`);
  }
  const firstLabelled = results.find((r) => r.label.trim().length > 0) ?? results[0]!;
  const firstSummarised = results.find((r) => r.summary.trim().length > 0) ?? results[0]!;
  return {
    label: firstLabelled.label,
    summary: firstSummarised.summary,
    entities: dedupeCaseInsensitive(results.flatMap((r) => r.entities)),
    decisions: dedupeCaseInsensitive(results.flatMap((r) => r.decisions)),
    open: dedupeCaseInsensitive(results.flatMap((r) => r.open)),
    confidence: Math.min(...results.map((r) => r.confidence)),
    facts: results.flatMap((r) => r.facts),
  };
}

export async function classifyAdaptive(text: string, classifier: LLMClient): Promise<ClassifyResult> {
  if (text.length <= SINGLE_PASS_CHAR_BUDGET) return classifier.classify(text);
  return classifyLarge(text, classifier);
}
