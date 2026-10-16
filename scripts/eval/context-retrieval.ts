/** Compare full-corpus fact candidates to the former recency window on one frozen snapshot. */
import { writeFileSync } from "node:fs";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import { runHarness } from "../../src/core/eval/harness/run.js";
import { compareReports } from "../../src/core/eval/harness/compare.js";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { RecallMode } from "../../src/shared/types.js";

const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error("usage: context-retrieval.ts <snapshot-directory> <report.json> [keyword|hybrid|semantic ...]");
const modes = (process.argv.slice(4).length ? process.argv.slice(4) : ["keyword", "hybrid"]) as RecallMode[];
if (modes.some((m) => !["keyword", "semantic", "hybrid"].includes(m))) throw new Error("Unknown recall mode");
const client = buildEmbedder();
const cache = new Map<string, Promise<EmbedResult>>();
// Reuse identical query vectors across arms; the experiment changes candidate
// selection, not the embedding model. Wall times are not latency comparisons.
const embedder: LLMClient = new Proxy(client, {
  get(target, prop) {
    if (prop === "embed") return (...args: Parameters<LLMClient["embed"]>) => {
      const key = JSON.stringify(args.slice(0, 2));
      let result = cache.get(key);
      if (!result) { result = target.embed(...args); cache.set(key, result); }
      return result;
    };
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const original = SqliteFactStore.prototype.listForRecall;
try {
  SqliteFactStore.prototype.listForRecall = function (tenantId, filter) {
    const { query: _query, ...priorFilter } = filter;
    return original.call(this, tenantId, priorFilter);
  };
  const baseline = await runHarness(snapshot, { modes, embedder });
  SqliteFactStore.prototype.listForRecall = original;
  const candidate = await runHarness(snapshot, { modes, embedder });
  const comparison = compareReports(baseline, candidate);
  writeFileSync(output, JSON.stringify({ baseline, candidate, comparison,
    caveats: ["Fact topic labels are synthetic subject/predicate queries, not independently judged answers.",
      "Session citation labels measure used results, not all relevant evidence.",
      "Embedding results are cached across arms; runtimeSeconds is not a latency comparison."],
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ retrieval: { baseline: baseline.retrieval, candidate: candidate.retrieval },
    factR1Regressions: comparison.factR1Regressions }));
  if (comparison.factR1Regressions.length) process.exitCode = 2;
} finally {
  SqliteFactStore.prototype.listForRecall = original;
}
