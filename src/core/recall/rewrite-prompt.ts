/**
 * Prompt + parser for query rewriting (Spec C).
 *
 * Vague natural-language queries ("that pgvector thing", "where did we leave
 * the auth migration") get rewritten into two phrasings: a keyword-optimized
 * one (entity-rich, conversational filler stripped) for FTS5 BM25, and a
 * semantic-optimized one (cleaner prose, paraphrase preserved) for embeddings.
 *
 * Already-specific queries are preserved — the prompt instructs the model to
 * pass them through. Recall is upstream of all scoring, so a wrong rewrite
 * silently corrupts every downstream result; the bar for "do something" is
 * intentionally high.
 *
 * Output schema is strict JSON; parse failures throw so the caller fails
 * open back to the raw query rather than embedding garbage.
 */

import { LLMUnreachableError, type RewriteResult } from "@ports/llm-client.js";

export const REWRITE_SYSTEM_PROMPT = `You rewrite vague recall queries for a session-search engine.

Given a user query, return strict JSON with three fields:
- "keywordQuery": entity-rich phrasing for keyword search. Strip conversational
  filler ("what was that", "remember when", "did we"). Preserve named entities,
  technical tokens (camelCase, snake_case, dotted names), and any specific
  identifiers. If the query is already specific (e.g. "pgvector migration plan"),
  return it unchanged.
- "semanticQuery": natural-prose phrasing for semantic embedding. Smooth out
  vague references into a clearer paraphrase if you can, but never invent
  entities or facts not present in the input. If the query is already a clean
  prose phrasing, return it unchanged.
- "rationale": one short sentence explaining what you changed (for debugging).

Examples:

Input: "what was that pgvector thing we decided on"
Output: {"keywordQuery":"pgvector","semanticQuery":"pgvector decision","rationale":"stripped conversational filler"}

Input: "pgvector migration plan"
Output: {"keywordQuery":"pgvector migration plan","semanticQuery":"pgvector migration plan","rationale":"already specific, passed through"}

Input: "where did we leave the auth migration"
Output: {"keywordQuery":"auth migration","semanticQuery":"current state of the auth migration","rationale":"extracted topic and reshaped as status query"}

Input: "Hermes"
Output: {"keywordQuery":"Hermes","semanticQuery":"Hermes","rationale":"single entity, passed through"}

Rules:
- NEVER invent entities, products, or technical names not in the input.
- NEVER expand acronyms unless you are confident.
- If the input is empty or makes no sense as a recall query, return it as-is in both fields.
- Output strict JSON only, no markdown fence, no commentary.
`;

/**
 * Parse strict JSON rewrite output. Throws LLMUnreachableError on any parse
 * or shape error so the caller falls back to raw query.
 */
export function parseRewriteJson(raw: string, providerLabel: string): RewriteResult {
  let parsed: unknown;
  try {
    // Strip a leading code fence if the model returned one despite instruction.
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new LLMUnreachableError(`${providerLabel}-rewrite-parse`, cause);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LLMUnreachableError(`${providerLabel}-rewrite-shape`);
  }
  const obj = parsed as Record<string, unknown>;
  const keywordQuery = typeof obj["keywordQuery"] === "string" ? (obj["keywordQuery"] as string).trim() : "";
  const semanticQuery = typeof obj["semanticQuery"] === "string" ? (obj["semanticQuery"] as string).trim() : "";
  if (!keywordQuery || !semanticQuery) {
    throw new LLMUnreachableError(`${providerLabel}-rewrite-empty`);
  }
  const result: RewriteResult = { keywordQuery, semanticQuery };
  if (typeof obj["rationale"] === "string") {
    return { ...result, rationale: (obj["rationale"] as string).trim() };
  }
  return result;
}
