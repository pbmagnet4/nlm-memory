/** Compare full-corpus fact candidates to the former recency window on one frozen snapshot. */
import { chmodSync, constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { GoldenFile } from "../../src/core/eval/harness/run.js";
import type { Golden } from "../../src/core/eval/harness/goldens.js";
import { runEval } from "../../src/core/eval/run-eval.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { encode as toonEncode } from "@toon-format/toon";
import { getSessionHandler } from "../../src/mcp/server.js";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { RecallMode } from "../../src/shared/types.js";

const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error("usage: context-retrieval.ts <snapshot-directory> <report.json> [keyword|hybrid|semantic ...]");
const payloadOnly = process.argv.includes("--payload-only");
const requestedModes = process.argv.slice(4).filter((arg) => arg !== "--payload-only");
const modes = (payloadOnly ? [] : requestedModes.length ? requestedModes : ["keyword", "hybrid"]) as RecallMode[];
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
const goldens = JSON.parse(readFileSync(join(snapshot, "goldens.json"), "utf8")) as GoldenFile;
const dir = mkdtempSync(join(tmpdir(), "nlm-context-eval-"));
const dbPath = join(dir, "canonical.sqlite");
copyFileSync(join(snapshot, "canonical.sqlite"), dbPath, constants.COPYFILE_FICLONE);
chmodSync(dbPath, 0o600);
const storage = SqliteStorage.create({ dbPath, migrationsDir: resolve("migrations") });
const original = SqliteFactStore.prototype.listForRecall;
const sessionRecall = new RecallService({ store: storage.sessions, llm: embedder });
const factRecall = new FactRecallService({ factStore: storage.facts, llm: embedder });
async function lane(goldenSet: readonly Golden[], service: RecallService | FactRecallService) {
  const result: Record<string, Record<string, Awaited<ReturnType<typeof runEval>>>> = {};
  for (const split of ["dev", "heldout"]) {
    result[split] = {};
    const queries = goldenSet.filter((g) => g.split === split).map((g) => ({ query: g.query, expectedIds: g.relevantIds }));
    for (const mode of modes) {
      result[split]![mode] = await runEval({ recall: { search: (q) => service.search(DEFAULT_TEAM_ID, q) } }, queries, { mode, k: 5 });
    }
  }
  return result;
}
try {
  if (modes.some((m) => m !== "keyword")) await embedder.embed("context eval embedder probe", "query");
  SqliteFactStore.prototype.listForRecall = function (tenantId, filter) {
    const { query: _query, ...priorFilter } = filter;
    return original.call(this, tenantId, priorFilter);
  };
  console.error("Scoring baseline fact candidates");
  const baseline = await lane(goldens.factTopic, factRecall);
  SqliteFactStore.prototype.listForRecall = original;
  console.error("Scoring full-corpus fact candidates");
  const candidate = await lane(goldens.factTopic, factRecall);
  const session = await lane(goldens.session, sessionRecall);
  const regressions: string[] = [];
  for (const split of ["dev", "heldout"]) {
    for (const mode of modes) {
      if (candidate[split]![mode]!.rAt1 + 1e-9 < baseline[split]![mode]!.rAt1) regressions.push(`${split}.${mode}`);
    }
  }
  const sample = new Map(goldens.session.filter((g) => g.split === "heldout")
    .flatMap((g) => g.relevantIds.slice(0, 1).map((id) => [id, g.query] as const)));
  const payloads = { n: 0, rawChars: 0, contextChars: 0, rawOver25000: 0, contextErrors: 0, overBudget: 0 };
  for (const [id, query] of sample) {
    const source = await storage.sessions.getById(DEFAULT_TEAM_ID, id);
    if (!source) continue;
    const raw = process.env.NLM_FORMAT === "toon" ? toonEncode(source) : JSON.stringify(source);
    const response = await getSessionHandler({ recall: sessionRecall, store: storage.sessions, factStore: storage.facts },
      DEFAULT_TEAM_ID, { id, query: query.slice(0, 2_000) });
    const chars = response.content[0]!.text.length;
    payloads.n++;
    payloads.rawChars += raw.length;
    payloads.contextChars += chars;
    if (raw.length > 25_000) payloads.rawOver25000++;
    if (response.isError) payloads.contextErrors++;
    if (chars > 8_000) payloads.overBudget++;
  }
  writeFileSync(output, JSON.stringify({ snapshot, modes, baseline, candidate, session, regressions, payloads,
    caveats: ["Fact topic labels are synthetic subject/predicate queries, not independently judged answers.",
      "Session citation labels measure used results, not all relevant evidence.",
      "Both arms share embeddings and a migrated disposable snapshot clone; this is not a latency comparison."],
  }, null, 2), { mode: 0o600 });
  const brief = (arm: typeof baseline) => Object.fromEntries(Object.entries(arm).map(([split, values]) => [split,
    Object.fromEntries(Object.entries(values).map(([mode, { n, rAt1, rAt5, mrr }]) => [mode, { n, rAt1, rAt5, mrr }]))]));
  console.log(JSON.stringify({ baseline: brief(baseline), candidate: brief(candidate), session: brief(session), regressions, payloads }));
  if (regressions.length) process.exitCode = 2;
} finally {
  SqliteFactStore.prototype.listForRecall = original;
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
}
