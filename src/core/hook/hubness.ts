/**
 * Hub damping for the prompt-recall hook (T1783).
 *
 * Measured basis: docs/eval/T1783-recall-hubs.md. The hook's keyword-only
 * recall produces a flat ~0.9 BM25 plateau for prompts whose vocabulary
 * overlaps generic git/dev session text, and the same handful of recent,
 * token-rich sessions ("hubs") win the per-fire cap for dozens of unrelated
 * prompts at mean relevance ~0. Nothing else on the path scores RECENT
 * OVER-INJECTION: the daemon's citation rerank was removed (a global
 * popularity prior is not per-query relevance), selectHits' relative floor
 * only trims within-fire tails against the fire's own median plateau, and the
 * memo dedups per conversation id, which recurring automation prompts mint
 * fresh on every fire.
 *
 * This module supplies the missing signal as two pure, independently-gated
 * steps applied to the fetched hits BEFORE selectHits:
 *
 *   1. Hubness penalty — down-weight a candidate by its injection frequency
 *      over the recent window:  score / (1 + alpha * ln(1 + count)).
 *      Log-damped: a memory injected twice is barely touched (ln 3 ≈ 1.1);
 *      one injected 100 times is divided by ~1 + 3 * alpha. Count 0 is a
 *      no-op, so un-injected candidates keep exact scores.
 *   2. Lexical overlap guard — a candidate whose label+summary shares ZERO
 *      non-stopword terms with the prompt AND scores below the floor is
 *      dropped outright. FTS5 matched it through low-idf `body` vocabulary
 *      the hook never sees; below the floor that is a plateau tie-break, not
 *      evidence. The guard never fires when the prompt itself has no
 *      content words (nothing to be disjoint from) or the hit clears the
 *      floor.
 *
 * The guard tests the ORIGINAL (un-penalized) score so the two steps stay
 * independent: frequency decides how much a hit is trusted, not whether it
 * clears a relevance floor. Output is re-sorted best-first because the
 * penalty can reorder — selectHits assumes descending scores.
 */

import { tokenize } from "@core/recall/tokenize.js";
import { STOPWORDS } from "./query-extract.js";
import type { RecallHitInput } from "./select.js";

/** Injection-frequency window the hook counts (days). */
export const HUB_WINDOW_DAYS = 14;

/** Content-word length floor, mirroring query-extract's MIN_WORD_LEN. */
const MIN_TERM_LEN = 3;

export interface HubnessParams {
  /** Raw prompt text (the guard's lexical counterpart to the hits). */
  readonly prompt: string;
  /** id -> injection count over HUB_WINDOW_DAYS (missing = 0). */
  readonly injectionCounts: ReadonlyMap<string, number>;
  /** Penalty weight; <= 0 disables the penalty. */
  readonly alpha: number;
  /** Guard floor on the original matchScore; <= 0 disables the guard. */
  readonly lexicalFloor: number;
}

function contentTerms(text: string | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length >= MIN_TERM_LEN && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** One candidate's damped score: score / (1 + alpha * ln(1 + count)). */
export function hubPenalty(score: number, injections: number, alpha: number): number {
  if (!(alpha > 0) || !(injections > 0)) return score;
  return score / (1 + alpha * Math.log1p(injections));
}

/**
 * Guard + penalty + re-sort. Returns `hits` untouched when both steps are
 * disabled. Never grows the list; may shrink it (guard drops).
 */
export function applyHubness(
  hits: ReadonlyArray<RecallHitInput>,
  params: HubnessParams,
): ReadonlyArray<RecallHitInput> {
  const penalize = params.alpha > 0;
  const guard = params.lexicalFloor > 0;
  if (!penalize && !guard) return hits;

  const promptTerms: ReadonlySet<string> = guard ? contentTerms(params.prompt) : new Set();
  const out: RecallHitInput[] = [];
  for (const h of hits) {
    if (guard && promptTerms.size > 0 && h.matchScore < params.lexicalFloor) {
      const hitTerms = contentTerms(`${h.label}\n${h.summary ?? ""}`);
      let shared = 0;
      for (const t of hitTerms) {
        if (promptTerms.has(t)) {
          shared++;
          break;
        }
      }
      if (shared === 0) continue;
    }
    out.push(
      penalize
        ? { ...h, matchScore: hubPenalty(h.matchScore, params.injectionCounts.get(h.id) ?? 0, params.alpha) }
        : h,
    );
  }
  out.sort((a, b) => b.matchScore - a.matchScore);
  return out;
}
