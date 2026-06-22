/**
 * Candidate-recall vs ranking diagnostic.
 *
 * For a query set with expected (gold) ids, classify every residual recall
 * miss as either:
 *   - ranking-miss   : gold IS in a wide raw candidate pull (top-N union of
 *                      the keyword + semantic legs) but ranked below the final
 *                      top-k cut. A reranker would help.
 *   - candidate-miss : gold never enters the wide candidate pool. A reranker
 *                      cannot help; query expansion is the only lever.
 *
 * The "wide candidate pull" mirrors RecallService step 1 (store.keywordSearch
 * ∪ store.semanticSearch) but at a much larger N, *before* finalize() ranks
 * and slices. The "final top-k" is RecallService.search(...).results.
 *
 * Runs against:
 *   1. the committed golden corpus (tests/fixtures/golden-corpus.ts) — always.
 *   2. LongMemEval-S, if the dataset is cached locally — best effort. Uses the
 *      on-disk embedding cache; if Ollama is unreachable on a cache miss the
 *      semantic leg for that query is skipped (keyword-only candidate pool),
 *      so the diagnostic never requires a live model.
 *
 * Does NOT touch the operator's private store. All writes go to disposable
 * temp DBs.
 *
 * Usage:
 *   tsx scripts/eval/candidate-recall-diagnostic.ts \
 *     [--wide 50] [--k 5] [--lme-limit 50] [--no-lme]
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import type { SessionStore } from "../../src/ports/session-store.js";
import type { EmbedResult, EmbeddingKind, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import type { RecallMode } from "../../src/shared/types.js";
import { GOLDEN_CORPUS, GOLDEN_QUERIES } from "../../tests/fixtures/golden-corpus.js";
import { turnsToBody, type LongMemEvalInstance } from "../longmemeval/types.js";
import { chunkSessionText } from "../../src/core/embedding/chunk-body.js";
import { OllamaClient } from "../../src/llm/ollama-client.js";
import { EmbeddingCache } from "../longmemeval/embedding-cache.js";
import {
  aggregateClasses,
  classifyMiss,
  type MissClass,
  type DiagnosticAggregate,
} from "./candidate-recall-classify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

interface Args {
  readonly wide: number;
  readonly k: number;
  readonly lmeLimit: number;
  readonly runLme: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? fallback : fallback;
  };
  return {
    wide: Number.parseInt(get("--wide", "50"), 10),
    k: Number.parseInt(get("--k", "5"), 10),
    lmeLimit: Number.parseInt(get("--lme-limit", "50"), 10),
    runLme: !argv.includes("--no-lme"),
  };
}

/** Keyword-only embedder: throws so the semantic leg is skipped. */
class UnreachableEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new LLMUnreachableError("ollama");
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

/** Cache-backed embedder that degrades to "unreachable" on any miss/error. */
class CacheOrUnreachableEmbedder implements LLMClient {
  constructor(private readonly cache: EmbeddingCache) {}
  async embed(text: string, kind: EmbeddingKind): Promise<EmbedResult> {
    try {
      const vector = await this.cache.embed(text, kind);
      return { vector, model: "nomic-embed-text@cached" };
    } catch {
      throw new LLMUnreachableError("ollama");
    }
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

/**
 * Build the wide raw candidate pool: the union of the keyword + semantic legs
 * at N=`wide`, exactly the set RecallService step 1 would resolve, but pulled
 * deep. The semantic leg is best-effort — when the embedder is unreachable we
 * return the keyword leg alone.
 */
async function widePool(
  store: SessionStore,
  llm: LLMClient,
  query: string,
  wide: number,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const kw = await store.keywordSearch(query, wide);
  for (const n of kw) ids.add(n.sessionId);
  try {
    const emb = await llm.embed(query, "query");
    const sem = await store.semanticSearch(emb.vector, wide);
    for (const n of sem) ids.add(n.sessionId);
  } catch (err) {
    if (!(err instanceof LLMUnreachableError)) throw err;
  }
  return ids;
}

function fmt(agg: DiagnosticAggregate): string {
  return [
    `n=${agg.n}`,
    `hits=${agg.hits}`,
    `ranking-miss=${agg.rankingMisses}`,
    `candidate-miss=${agg.candidateMisses}`,
    `ranking-share(of misses)=${(agg.rankingMissShare * 100).toFixed(1)}%`,
    `candidate-share(of misses)=${(agg.candidateMissShare * 100).toFixed(1)}%`,
    `verdict=${agg.verdict}`,
  ].join("  ");
}

async function runGolden(args: Args): Promise<DiagnosticAggregate> {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-crd-golden-"));
  const storage = SqliteStorage.create({
    dbPath: join(tmp, "canonical.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  const store = storage.sessions;
  for (const s of GOLDEN_CORPUS) store.insertSessionForTest(s);

  const llm = new UnreachableEmbedder();
  const svc = new RecallService({ store, llm });
  const classes: MissClass[] = [];
  try {
    for (const { query, expectTop3 } of GOLDEN_QUERIES) {
      const result = await svc.search({ query, mode: "keyword", limit: args.k });
      const finalTopKIds = result.results.slice(0, args.k).map((r) => r.id);
      const wide = await widePool(store, llm, query, args.wide);
      const cls = classifyMiss({
        goldIds: [expectTop3],
        finalTopKIds,
        wideCandidateIds: [...wide],
      });
      classes.push(cls);
    }
  } finally {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  return aggregateClasses(classes);
}

function stratifiedPick(
  dataset: ReadonlyArray<LongMemEvalInstance>,
  limit: number,
): LongMemEvalInstance[] {
  const byType = new Map<string, LongMemEvalInstance[]>();
  for (const inst of dataset) {
    const arr = byType.get(inst.question_type) ?? [];
    arr.push(inst);
    byType.set(inst.question_type, arr);
  }
  const types = Array.from(byType.keys()).sort();
  const perType = Math.max(1, Math.floor(limit / types.length));
  const out: LongMemEvalInstance[] = [];
  for (const t of types) {
    const subset = byType.get(t) ?? [];
    const step = Math.max(1, Math.floor(subset.length / perType));
    for (let i = 0, taken = 0; i < subset.length && taken < perType; i += step, taken++) {
      const item = subset[i];
      if (item) out.push(item);
    }
  }
  return out.slice(0, limit);
}

async function runOneLme(
  instance: LongMemEvalInstance,
  args: Args,
  embedder: LLMClient,
  cache: EmbeddingCache,
): Promise<MissClass> {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-crd-lme-"));
  const store = new SqliteSessionStore({
    dbPath: join(tmp, "canonical.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  const seen = new Set<string>();
  try {
    for (let i = 0; i < instance.haystack_sessions.length; i++) {
      const id = instance.haystack_session_ids[i];
      const date = instance.haystack_dates[i];
      const turns = instance.haystack_sessions[i];
      if (!id || !date || !turns || seen.has(id)) continue;
      seen.add(id);
      const body = turnsToBody(turns);
      store.insertSessionForTest({
        id,
        runtime: "longmemeval",
        runtimeSessionId: id,
        startedAt: date,
        endedAt: date,
        durationMin: 0,
        label: "",
        summary: "",
        body,
        status: "closed",
        transcriptKind: "longmemeval-jsonl",
        transcriptPath: null,
        entities: [],
        decisions: [],
        open: [],
      });
      const chunks = chunkSessionText({ body });
      for (let c = 0; c < chunks.length; c++) {
        try {
          const vector = await cache.embed(chunks[c]!, "document");
          store.insertChunkEmbeddingForTest(id, c, vector);
        } catch {
          // document embed miss without Ollama — chunk simply isn't indexed.
        }
      }
    }

    const mode: RecallMode = "hybrid";
    const svc = new RecallService({ store, llm: embedder });
    const result = await svc.search({ query: instance.question, mode, limit: args.k });
    const finalTopKIds = result.results.slice(0, args.k).map((r) => r.id);
    const wide = await widePool(store, embedder, instance.question, args.wide);
    return classifyMiss({
      goldIds: instance.answer_session_ids,
      finalTopKIds,
      wideCandidateIds: [...wide],
    });
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runLongMemEval(args: Args): Promise<DiagnosticAggregate | null> {
  const cacheDir =
    process.env["LONGMEMEVAL_CACHE_DIR"] ?? join(homedir(), ".cache", "longmemeval");
  const variant = process.env["LONGMEMEVAL_VARIANT"] ?? "longmemeval_s_cleaned.json";
  const datasetPath = join(cacheDir, variant);
  if (!existsSync(datasetPath)) {
    console.log(`longmemeval: dataset not cached at ${variant} — skipping.`);
    return null;
  }
  const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as LongMemEvalInstance[];
  const slice = stratifiedPick(dataset, args.lmeLimit);

  const ollama = new OllamaClient({ embedModel: "nomic-embed-text" });
  const cache = new EmbeddingCache({ dbPath: join(cacheDir, "embeddings.sqlite"), llm: ollama });
  const embedder = new CacheOrUnreachableEmbedder(cache);

  console.log(
    `longmemeval: ${slice.length} stratified instances, wide=${args.wide}, k=${args.k}, cache=${cache.size()} embeddings`,
  );
  const classes: MissClass[] = [];
  try {
    for (let i = 0; i < slice.length; i++) {
      const inst = slice[i];
      if (!inst) continue;
      classes.push(await runOneLme(inst, args, embedder, cache));
      if ((i + 1) % 10 === 0 || i === slice.length - 1) {
        console.log(`  [${i + 1}/${slice.length}]`);
      }
    }
  } finally {
    cache.close();
  }
  return aggregateClasses(classes);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `candidate-recall-diagnostic: wide=${args.wide}, k=${args.k}, lme=${args.runLme}`,
  );

  const golden = await runGolden(args);
  console.log(`\n[golden corpus]  ${fmt(golden)}`);

  if (args.runLme) {
    const lme = await runLongMemEval(args);
    if (lme) console.log(`\n[longmemeval-s]  ${fmt(lme)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
