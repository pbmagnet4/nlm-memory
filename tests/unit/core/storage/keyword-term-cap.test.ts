/**
 * T1770k — keyword queries from recall hooks arrive as whole prompts
 * (128-256 words). OR-ing every token into one FTS5 MATCH costs seconds on
 * the daemon's event loop; the 24 rarest terms cost milliseconds and carry
 * the BM25 weight anyway. Pure-selection coverage only — the end-to-end
 * search cases live in tests/integration/keyword-search-fts.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  KEYWORD_MAX_TERMS,
  selectRarestKeywordTerms,
} from "../../../../src/core/storage/sqlite-session-store.js";

/** n distinct terms, each in `doc` documents (so a term occurring in every
 *  document of a 6-document corpus is the "common" case). */
function freq(entries: ReadonlyArray<readonly [string, number]>): Map<string, number> {
  return new Map(entries);
}

describe("KEYWORD_MAX_TERMS", () => {
  it("is 24", () => {
    expect(KEYWORD_MAX_TERMS).toBe(24);
  });
});

describe("selectRarestKeywordTerms", () => {
  it("leaves a query at or under the cap untouched, unknown terms included", () => {
    const terms = ["pgvector", "totally-unknown-term", "hono"];
    expect(selectRarestKeywordTerms(terms, freq([]))).toEqual(terms);

    const atCap = Array.from({ length: KEYWORD_MAX_TERMS }, (_, i) => `t${i}`);
    expect(selectRarestKeywordTerms(atCap, freq([["t0", 5]]))).toEqual(atCap);
  });

  it("keeps the 24 rarest terms of a longer query, rarest first", () => {
    // 40 terms: t39 is the rarest (doc 1), t0 the most common (doc 40).
    const terms = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const docFreq = freq(terms.map((t, i) => [t, 40 - i] as const));

    const chosen = selectRarestKeywordTerms(terms, docFreq);

    expect(chosen).toHaveLength(KEYWORD_MAX_TERMS);
    expect(chosen).toEqual(terms.slice(40 - KEYWORD_MAX_TERMS).reverse());
    // The two most common terms of the corpus are the ones that fell off.
    expect(chosen).not.toContain("t0");
    expect(chosen).not.toContain("t1");
    expect(chosen).toContain("t39");
  });

  it("drops terms with no vocabulary row once the cap bites", () => {
    // 30 terms, only 10 of which exist in the index at all.
    const terms = Array.from({ length: 30 }, (_, i) => (i < 10 ? `known${i}` : `ghost${i}`));
    const docFreq = freq(terms.slice(0, 10).map((t, i) => [t, i + 1] as const));

    const chosen = selectRarestKeywordTerms(terms, docFreq);

    expect(chosen).toHaveLength(10);
    expect(chosen).toEqual(terms.slice(0, 10));
  });

  it("keeps the original query order among equally frequent terms", () => {
    const terms = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const docFreq = freq(terms.map((t) => [t, 7] as const));

    expect(selectRarestKeywordTerms(terms, docFreq)).toEqual(terms.slice(0, KEYWORD_MAX_TERMS));
  });

  it("returns nothing when no term of a long query is in the index", () => {
    const terms = Array.from({ length: 40 }, (_, i) => `ghost${i}`);
    expect(selectRarestKeywordTerms(terms, freq([]))).toEqual([]);
  });
});
