/**
 * LongMemEval-S baseline harness for NLM.
 *
 * Body-only ingest (skip classifier) + local Ollama nomic-embed-text. For
 * each evaluation instance: spin up an in-memory NLM corpus loaded with
 * the haystack sessions, query in each retrieval mode (keyword / semantic
 * / hybrid+RRF), score R@5 plus the session-body companion metric.
 *
 * Pure body-only retrieval — this measures the retrieval *algorithm*, not
 * the full classifier-in-loop NLM pipeline. The number is comparable to
 * agentmemory's published R@5 because both bench bodies-only.
 *
 * Usage:
 *   node dist/scripts/longmemeval/run-harness.js \
 *     --variant longmemeval_s_cleaned.json \
 *     --modes keyword,semantic,hybrid \
 *     --limit 500 \
 *     --report-dir reports/longmemeval \
 *     --classifier none
 *
 * The `--classifier` flag enables classifier-in-the-loop benchmarking.
 * Values: "none" (default, body-only — published 97.2% baseline path), or
 * "<provider>:<model>" where provider is "ollama" or "deepseek". Example:
 *   --classifier ollama:qwen3:4b-instruct-2507-q4_K_M
 *   --classifier deepseek:deepseek-v4-flash
 * Classification results cache in ~/.cache/longmemeval/classifier.sqlite
 * keyed by sha256(provider+model+body). First run per model takes hours
 * (one LLM call per unique body); subsequent re-runs hit cache only.
 *
 * Re-runs are fast: embeddings cache in ~/.cache/longmemeval/embeddings.sqlite
 * keyed by sha256(kind + text). First run = ~30 min embedding; subsequent = seconds.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { OllamaClient } from "../../src/llm/ollama-client.js";
import { DeepSeekClient } from "../../src/llm/deepseek-client.js";
import type {
  EmbedResult,
  EmbeddingKind,
  LLMClient,
} from "../../src/ports/llm-client.js";
import type { RecallMode } from "../../src/shared/types.js";
import { EmbeddingCache } from "./embedding-cache.js";
import { ClassifierCache, type ClassifierClient } from "./classifier-cache.js";
import { scoreOne, aggregate, type SingleScore } from "./scorer.js";
import { turnsToBody, type LongMemEvalInstance } from "./types.js";
import { chunkSessionText } from "../../src/core/embedding/chunk-body.js";

interface ClassifierSpec {
  readonly provider: "ollama" | "deepseek";
  readonly model: string;
}

interface Args {
  readonly datasetPath: string;
  readonly modes: ReadonlyArray<RecallMode>;
  readonly limit: number;
  readonly k: number;
  readonly reportDir: string;
  readonly cacheDir: string;
  readonly migrationsDir: string;
  readonly classifier: ClassifierSpec | null;
  /** When true, pick `limit` instances evenly distributed across question_type. */
  readonly stratify: boolean;
}

function parseClassifierFlag(raw: string): ClassifierSpec | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "none" || trimmed === "off") return null;
  const idx = trimmed.indexOf(":");
  if (idx < 1) {
    throw new Error(
      `--classifier expects "<provider>:<model>" (e.g. "ollama:qwen3:4b-instruct-2507-q4_K_M") or "none", got ${JSON.stringify(raw)}`,
    );
  }
  const provider = trimmed.slice(0, idx) as ClassifierSpec["provider"];
  const model = trimmed.slice(idx + 1);
  if (provider !== "ollama" && provider !== "deepseek") {
    throw new Error(`--classifier: unsupported provider ${JSON.stringify(provider)} (use "ollama" or "deepseek")`);
  }
  if (!model) throw new Error(`--classifier: model is empty`);
  return { provider, model };
}

function classifierSlug(spec: ClassifierSpec | null): string {
  if (!spec) return "body-only";
  return `${spec.provider}-${spec.model.replace(/[:/]/g, "_")}`;
}

function buildClassifierClient(spec: ClassifierSpec): ClassifierClient {
  if (spec.provider === "ollama") {
    return new OllamaClient({ classifyModel: spec.model });
  }
  return new DeepSeekClient({ classifyModel: spec.model });
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (flag: string, fallback?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0) {
      if (fallback === undefined) throw new Error(`missing required flag: ${flag}`);
      return fallback;
    }
    return argv[i + 1] ?? "";
  };
  const cacheDir =
    process.env["LONGMEMEVAL_CACHE_DIR"] ?? join(homedir(), ".cache", "longmemeval");
  const variant = get("--variant", "longmemeval_s_cleaned.json");
  const datasetPath = join(cacheDir, variant);
  const modes = get("--modes", "keyword,semantic,hybrid")
    .split(",")
    .map((m) => m.trim()) as RecallMode[];
  const limit = Number.parseInt(get("--limit", "500"), 10);
  const k = Number.parseInt(get("--k", "5"), 10);
  const reportDir = get("--report-dir", resolve("reports/longmemeval"));
  const migrationsDir = resolve(__dirname, "../../migrations");
  const classifier = parseClassifierFlag(get("--classifier", "none"));
  const stratify = argv.includes("--stratify");
  return { datasetPath, modes, limit, k, reportDir, cacheDir, migrationsDir, classifier, stratify };
}

/**
 * Pick a subset of size `limit` evenly distributed across `question_type`.
 *
 * LongMemEval-S is sorted by question_type — the first 70 instances are all
 * `single-session-user` (the easiest category), the next 133 are `multi-session`,
 * etc. A naive `slice(0, limit)` therefore measures only the easiest category
 * unless `limit` ≥ 444. Stratified sampling fixes this: limit / numTypes
 * instances per type, picked deterministically by index so re-runs hit the
 * same instances (and therefore the same cached classifier outputs).
 */
function stratifiedPick<T extends { question_type: string }>(
  dataset: ReadonlyArray<T>,
  limit: number,
): T[] {
  const byType = new Map<string, T[]>();
  for (const inst of dataset) {
    const arr = byType.get(inst.question_type) ?? [];
    arr.push(inst);
    byType.set(inst.question_type, arr);
  }
  const types = Array.from(byType.keys()).sort();
  const perType = Math.max(1, Math.floor(limit / types.length));
  const out: T[] = [];
  for (const t of types) {
    const subset = byType.get(t) ?? [];
    const step = Math.max(1, Math.floor(subset.length / perType));
    for (let i = 0, taken = 0; i < subset.length && taken < perType; i += step, taken++) {
      out.push(subset[i] as T);
    }
  }
  return out.slice(0, limit);
}

/** LLMClient wrapper: routes embed() through the on-disk cache. */
class CachingEmbedder implements LLMClient {
  constructor(private readonly cache: EmbeddingCache) {}
  async embed(text: string, kind: EmbeddingKind): Promise<EmbedResult> {
    const vector = await this.cache.embed(text, kind);
    return { vector, model: "nomic-embed-text@cached" };
  }
  async classify(): Promise<never> {
    throw new Error("classify not used in LongMemEval body-only harness");
  }
}

interface InstanceResult {
  readonly question_id: string;
  readonly question_type: string;
  readonly by_mode: Record<string, SingleScore & { returnedIds: string[] }>;
  readonly embed_failures: number;
  readonly classify_failures: number;
  readonly classify_count: number;
}

async function runInstance(
  instance: LongMemEvalInstance,
  args: Args,
  cache: EmbeddingCache,
  embedder: LLMClient,
  classifierCache: ClassifierCache | null,
): Promise<InstanceResult> {
  const needsEmbeddings = args.modes.some(
    (m) => m === "semantic" || m === "hybrid",
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "nlm-lmeval-"));
  const store = new SqliteSessionStore({
    dbPath: join(tmpDir, "canonical.sqlite"),
    migrationsDir: args.migrationsDir,
  });
  const bodyById = new Map<string, string>();
  let embedFailures = 0;
  let classifyFailures = 0;
  let classifyCount = 0;
  const seen = new Set<string>();
  try {
    for (let i = 0; i < instance.haystack_sessions.length; i++) {
      const id = instance.haystack_session_ids[i];
      const date = instance.haystack_dates[i];
      const turns = instance.haystack_sessions[i];
      if (!id || !date || !turns) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const body = turnsToBody(turns);
      bodyById.set(id, body);

      let label = "";
      let summary = "";
      let entities: string[] = [];
      let decisions: string[] = [];
      let open: string[] = [];
      if (classifierCache) {
        classifyCount++;
        const entry = await classifierCache.classify(body);
        if (entry.failed || !entry.result) {
          classifyFailures++;
        } else {
          label = entry.result.label;
          summary = entry.result.summary;
          entities = [...entry.result.entities];
          decisions = [...entry.result.decisions];
          open = [...entry.result.open];
        }
      }

      store.insertSessionForTest({
        id,
        runtime: "longmemeval",
        runtimeSessionId: id,
        startedAt: date,
        endedAt: date,
        durationMin: 0,
        label,
        summary,
        body,
        status: "closed",
        transcriptKind: "longmemeval-jsonl",
        transcriptPath: null,
        entities,
        decisions,
        open,
      });
      if (needsEmbeddings) {
        const chunks = chunkSessionText({ body });
        for (let c = 0; c < chunks.length; c++) {
          try {
            const vector = await cache.embed(chunks[c]!, "document");
            store.insertChunkEmbeddingForTest(id, c, vector);
          } catch {
            // Per-chunk embed failure is non-fatal — successfully embedded
            // chunks still contribute via max-pool. Counter tracks attempts.
            embedFailures++;
          }
        }
      }
    }

    const recall = new RecallService({ store, llm: embedder });
    const byMode: InstanceResult["by_mode"] = {};
    for (const mode of args.modes) {
      const result = await recall.search({
        query: instance.question,
        mode,
        limit: args.k,
      });
      const returnedIds = result.results.map((r) => r.id);
      const returnedBodies = returnedIds.map((id) => bodyById.get(id) ?? "");
      const score = scoreOne({
        returnedIds,
        goldIds: instance.answer_session_ids,
        returnedBodies,
        answer: instance.answer,
        k: args.k,
      });
      byMode[mode] = { ...score, returnedIds };
    }
    return {
      question_id: instance.question_id,
      question_type: instance.question_type,
      by_mode: byMode,
      embed_failures: embedFailures,
      classify_failures: classifyFailures,
      classify_count: classifyCount,
    };
  } finally {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`longmemeval-harness: loading ${args.datasetPath}`);
  const raw = readFileSync(args.datasetPath, "utf8");
  const dataset = JSON.parse(raw) as LongMemEvalInstance[];
  const slice = args.stratify
    ? stratifiedPick(dataset, args.limit)
    : dataset.slice(0, args.limit);
  const classifierLabel = args.classifier
    ? `${args.classifier.provider}:${args.classifier.model}`
    : "none (body-only)";
  const samplingLabel = args.stratify ? "stratified" : "first-N";
  console.log(
    `longmemeval-harness: ${slice.length}/${dataset.length} instances (${samplingLabel}), modes=${args.modes.join(",")}, k=${args.k}, classifier=${classifierLabel}`,
  );
  if (args.stratify) {
    const dist: Record<string, number> = {};
    for (const inst of slice) dist[inst.question_type] = (dist[inst.question_type] ?? 0) + 1;
    console.log(`longmemeval-harness: question_type distribution: ${JSON.stringify(dist)}`);
  }

  // Warm the embedding cache and the LLM transport.
  const llm = new OllamaClient({ embedModel: "nomic-embed-text" });
  const cache = new EmbeddingCache({
    dbPath: join(args.cacheDir, "embeddings.sqlite"),
    llm,
  });
  const embedder = new CachingEmbedder(cache);

  let classifierCache: ClassifierCache | null = null;
  if (args.classifier) {
    const client = buildClassifierClient(args.classifier);
    classifierCache = new ClassifierCache({
      dbPath: join(args.cacheDir, "classifier.sqlite"),
      provider: args.classifier.provider,
      model: args.classifier.model,
      client,
    });
    const s = classifierCache.stats();
    console.log(
      `longmemeval-harness: classifier cache has ${s.total} entries for ${classifierLabel} (${s.ok} ok, ${s.failed} failed)`,
    );
  }

  console.log(`longmemeval-harness: cache contains ${cache.size()} embeddings on entry`);

  const results: InstanceResult[] = [];
  const t0 = Date.now();
  for (let i = 0; i < slice.length; i++) {
    const inst = slice[i];
    if (!inst) continue;
    const result = await runInstance(inst, args, cache, embedder, classifierCache);
    results.push(result);
    if ((i + 1) % 10 === 0 || i === slice.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const cached = cache.size();
      console.log(
        `  [${i + 1}/${slice.length}] ${elapsed}s elapsed, cache=${cached}`,
      );
    }
  }

  // Aggregate.
  const aggregated: Record<string, ReturnType<typeof aggregate>> = {};
  for (const mode of args.modes) {
    aggregated[mode] = aggregate(
      results.map((r) => r.by_mode[mode] as SingleScore).filter(Boolean),
    );
  }

  // Per-question-type breakdown.
  const byType: Record<string, Record<string, ReturnType<typeof aggregate>>> = {};
  const types = new Set(results.map((r) => r.question_type));
  for (const t of types) {
    byType[t] = {};
    for (const mode of args.modes) {
      const subset = results
        .filter((r) => r.question_type === t)
        .map((r) => r.by_mode[mode] as SingleScore)
        .filter(Boolean);
      byType[t]![mode] = aggregate(subset);
    }
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const slug = classifierSlug(args.classifier);
  const outDir = join(args.reportDir, `${stamp}-${slug}`);
  mkdirSync(outDir, { recursive: true });
  const classifierStats = classifierCache ? classifierCache.stats() : null;
  const totalClassifyAttempts = results.reduce((acc, r) => acc + r.classify_count, 0);
  const totalClassifyFailures = results.reduce((acc, r) => acc + r.classify_failures, 0);
  const json = {
    dataset: args.datasetPath,
    n: results.length,
    k: args.k,
    modes: args.modes,
    sampling: args.stratify ? "stratified" : "first-N",
    classifier: args.classifier
      ? {
          provider: args.classifier.provider,
          model: args.classifier.model,
          cache_total: classifierStats?.total ?? 0,
          cache_ok: classifierStats?.ok ?? 0,
          cache_failed: classifierStats?.failed ?? 0,
          cache_mean_elapsed_ms: classifierStats?.meanElapsedMs ?? null,
          run_classify_attempts: totalClassifyAttempts,
          run_classify_failures: totalClassifyFailures,
        }
      : null,
    aggregate: aggregated,
    by_question_type: byType,
    results,
    elapsed_seconds: (Date.now() - t0) / 1000,
  };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(json, null, 2));
  writeFileSync(join(outDir, "summary.md"), renderSummary(json));
  console.log(`longmemeval-harness: wrote ${outDir}/`);
  console.log(renderSummary(json));

  classifierCache?.close();
  cache.close();
}

function renderSummary(json: {
  dataset: string;
  n: number;
  k: number;
  modes: ReadonlyArray<RecallMode>;
  classifier: { provider: string; model: string; cache_total: number; cache_ok: number; cache_failed: number; cache_mean_elapsed_ms: number | null; run_classify_attempts: number; run_classify_failures: number } | null;
  aggregate: Record<string, ReturnType<typeof aggregate>>;
  by_question_type: Record<string, Record<string, ReturnType<typeof aggregate>>>;
  elapsed_seconds: number;
}): string {
  const lines: string[] = [];
  const mode = json.classifier ? `classifier=${json.classifier.provider}:${json.classifier.model}` : "body-only";
  lines.push(`# LongMemEval-S — NLM (${mode}, n=${json.n}, k=${json.k})`);
  lines.push("");
  lines.push(`Dataset: \`${json.dataset}\``);
  lines.push(`Elapsed: ${json.elapsed_seconds.toFixed(1)}s`);
  if (json.classifier) {
    const c = json.classifier;
    const failPct = c.run_classify_attempts ? ((c.run_classify_failures / c.run_classify_attempts) * 100).toFixed(1) : "0.0";
    lines.push(`Classifier: ${c.provider}:${c.model} — ${c.cache_ok}/${c.cache_total} ok in cache, ${failPct}% failure on this run, mean ${c.cache_mean_elapsed_ms ?? "?"}ms/session`);
  }
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`| Mode | R@1 | R@3 | R@${json.k} | Session-body hit |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const mode of json.modes) {
    const a = json.aggregate[mode];
    if (!a) continue;
    lines.push(
      `| ${mode} | ${(a.recallAt1 * 100).toFixed(1)}% | ${(a.recallAt3 * 100).toFixed(1)}% | ${(a.recallAtK * 100).toFixed(1)}% | ${(a.sessionBodyHitRate * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  lines.push("## By question type");
  lines.push("");
  const types = Object.keys(json.by_question_type).sort();
  lines.push(
    `| Question type | ${json.modes.map((m) => `${m} R@${json.k}`).join(" | ")} |`,
  );
  lines.push(`| --- | ${json.modes.map(() => "---").join(" | ")} |`);
  for (const t of types) {
    const row = json.by_question_type[t]!;
    const cells = json.modes.map((m) => {
      const a = row[m];
      return a ? `${(a.recallAtK * 100).toFixed(1)}% (n=${a.n})` : "—";
    });
    lines.push(`| ${t} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

void main().catch((err) => {
  console.error("longmemeval-harness: fatal", err);
  process.exit(1);
});
