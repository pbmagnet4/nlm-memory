/**
 * Corpus-agnostic R@k / MRR runner shared by `nlm eval` and the regression
 * gate. Takes a query set with expected ids and a recall searcher, returns a
 * per-mode report. The query set is supplied by the caller and never bundled.
 */

import type { RecallMode } from "@shared/types.js";

export interface EvalQuery {
  readonly query: string;
  readonly expectedIds: ReadonlyArray<string>;
}

export interface EvalReport {
  readonly mode: RecallMode;
  readonly n: number;
  readonly rAt1: number;
  readonly rAt5: number;
  readonly mrr: number;
  readonly misses: ReadonlyArray<{
    query: string;
    expected: ReadonlyArray<string>;
    got: ReadonlyArray<string>;
  }>;
}

interface Searcher {
  search(q: { query: string; mode: RecallMode; limit: number }): Promise<{
    results: ReadonlyArray<{ id: string }>;
  }>;
}

export async function runEval(
  deps: { recall: Searcher },
  queries: ReadonlyArray<EvalQuery>,
  opts: { mode: RecallMode; k: number },
): Promise<EvalReport> {
  let hit1 = 0;
  let hit5 = 0;
  let rrSum = 0;
  const misses: Array<{ query: string; expected: ReadonlyArray<string>; got: ReadonlyArray<string> }> = [];
  for (const q of queries) {
    const { results } = await deps.recall.search({ query: q.query, mode: opts.mode, limit: opts.k });
    const ids = results.map((r) => r.id);
    const rank = ids.findIndex((id) => q.expectedIds.includes(id)) + 1; // 0 => miss
    if (rank === 1) hit1++;
    if (rank >= 1 && rank <= 5) hit5++;
    if (rank >= 1) rrSum += 1 / rank;
    else misses.push({ query: q.query, expected: q.expectedIds, got: ids });
  }
  const n = queries.length || 1;
  return {
    mode: opts.mode,
    n: queries.length,
    rAt1: hit1 / n,
    rAt5: hit5 / n,
    mrr: rrSum / n,
    misses,
  };
}
