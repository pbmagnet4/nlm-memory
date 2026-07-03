/**
 * Private-corpus bench harness for NLM.
 *
 * Queries an EXISTING corpus snapshot (the operator's canonical.sqlite,
 * snapshotted via VACUUM INTO) using the same in-process RecallService path
 * as scripts/eval/context-recall-ab.ts. The query set is operator-managed
 * and lives OUTSIDE the repo; it is referenced only through the env var
 * NLM_PRIVATE_BENCH_QUERIES.
 *
 * The harness REFUSES (exit 1) if:
 *   - NLM_PRIVATE_BENCH_QUERIES is unset, the file is missing, "locked" is
 *     not exactly true, or the query set is empty.
 *   - --report-dir is not provided.
 *   - --db is not provided (except during --dry-run).
 *
 * Usage:
 *   NLM_PRIVATE_BENCH_QUERIES=/path/outside/repo/queries.json \
 *   node dist/scripts/private-bench/run-harness.js \
 *     --db /path/outside/repo/canonical-snapshot.sqlite \
 *     --modes keyword,semantic,hybrid \
 *     --limit 100 \
 *     --k 5 \
 *     --report-dir /path/outside/repo/reports/private-bench
 *
 * Dry-run (validates the lock file and prints the plan; no DB or recall):
 *   NLM_PRIVATE_BENCH_QUERIES=/path/outside/repo/queries.json \
 *   node dist/scripts/private-bench/run-harness.js \
 *     --dry-run --modes keyword --limit 10 \
 *     --report-dir /tmp/unused
 *
 * Report outputs (written to --report-dir):
 *   summary.md   human-readable aggregates + per-category table
 *   results.json aggregates + per-category rows + per-query id/category/scores
 *
 * Query ids and categories appear in reports. Question text is NEVER written
 * to any output. Keep report directories outside the repo to avoid committing
 * client content.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { OllamaClient } from "../../src/llm/ollama-client.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import type { RecallMode } from "../../src/shared/types.js";
import { scoreOne, aggregate, type SingleScore } from "../longmemeval/scorer.js";
import {
  loadLockedQueries,
  PrivateBenchRefusalError,
  type LockedQuery,
} from "./locked-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Args {
  readonly modes: ReadonlyArray<RecallMode>;
  readonly limit: number;
  readonly k: number;
  readonly reportDir: string;
  readonly db: string | null;
  readonly dryRun: boolean;
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
  const dryRun = argv.includes("--dry-run");
  const modes = get("--modes", "keyword,semantic,hybrid")
    .split(",")
    .map((m) => m.trim()) as RecallMode[];
  const limit = Number.parseInt(get("--limit", "0"), 10);
  const k = Number.parseInt(get("--k", "5"), 10);
  const reportDir = get("--report-dir");
  const db = argv.includes("--db") ? get("--db") : null;
  return { modes, limit, k, reportDir, db, dryRun };
}

interface QueryResult {
  readonly id: string;
  readonly category: string;
  readonly by_mode: Record<string, SingleScore & { returnedIds: string[] }>;
}

async function runQuery(
  query: LockedQuery,
  modes: ReadonlyArray<RecallMode>,
  k: number,
  recall: RecallService,
): Promise<QueryResult> {
  const by_mode: Record<string, SingleScore & { returnedIds: string[] }> = {};
  for (const mode of modes) {
    const result = await recall.search({ query: query.question, mode, limit: k });
    const returnedIds = result.results.map((r) => r.id);
    const score = scoreOne({
      returnedIds,
      goldIds: query.goldSessionIds,
      // Private bench queries carry no gold answer text; session-body-hit is
      // not a meaningful metric here and will always be 0.
      returnedBodies: [],
      answer: "",
      k,
    });
    by_mode[mode] = { ...score, returnedIds };
  }
  return { id: query.id, category: query.category, by_mode };
}

function renderSummary(report: {
  readonly n: number;
  readonly k: number;
  readonly modes: ReadonlyArray<RecallMode>;
  readonly lockedAt: string;
  readonly ranAt: string;
  readonly db: string;
  readonly aggregate: Record<string, ReturnType<typeof aggregate>>;
  readonly by_category: Record<string, Record<string, ReturnType<typeof aggregate>>>;
}): string {
  const lines: string[] = [];
  lines.push(`# Private-corpus bench (n=${report.n}, k=${report.k})`);
  lines.push("");
  lines.push(`Locked at: ${report.lockedAt}`);
  lines.push(`Run at: ${report.ranAt}`);
  lines.push(`DB snapshot: ${report.db}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(`| Mode | R@1 | R@3 | R@${report.k} |`);
  lines.push("| --- | --- | --- | --- |");
  for (const mode of report.modes) {
    const a = report.aggregate[mode];
    if (!a) continue;
    lines.push(
      `| ${mode} | ${(a.recallAt1 * 100).toFixed(1)}% | ${(a.recallAt3 * 100).toFixed(1)}% | ${(a.recallAtK * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  lines.push("## By category");
  lines.push("");
  const cats = Object.keys(report.by_category).sort();
  lines.push(
    `| Category | ${report.modes.map((m) => `${m} R@${report.k}`).join(" | ")} |`,
  );
  lines.push(`| --- | ${report.modes.map(() => "---").join(" | ")} |`);
  for (const cat of cats) {
    const row = report.by_category[cat]!;
    const cells = report.modes.map((m) => {
      const a = row[m];
      return a ? `${(a.recallAtK * 100).toFixed(1)}% (n=${a.n})` : "N/A";
    });
    lines.push(`| ${cat} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let lockedAt: string;
  let queries: ReadonlyArray<LockedQuery>;
  try {
    const loaded = loadLockedQueries();
    lockedAt = loaded.lockedAt;
    queries = loaded.queries;
  } catch (e) {
    if (e instanceof PrivateBenchRefusalError) {
      console.error(`private-bench: REFUSED: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const slice = args.limit > 0 ? queries.slice(0, args.limit) : queries;

  if (args.dryRun) {
    console.log(
      `private-bench: dry-run: query file validated (${slice.length} of ${queries.length} queries)`,
    );
    console.log(`  lockedAt=${lockedAt}, modes=${args.modes.join(",")}, k=${args.k}`);
    const cats = new Set(slice.map((q) => q.category));
    console.log(`  categories: ${[...cats].sort().join(", ")}`);
    return;
  }

  if (!args.db) {
    console.error(
      "private-bench: REFUSED: --db is required for real runs. " +
        "Run: sqlite3 ~/.nlm/canonical.sqlite 'VACUUM INTO \"/path/to/snapshot.sqlite\"' " +
        "then pass --db /path/to/snapshot.sqlite.",
    );
    process.exit(1);
  }

  const migrationsDir = resolve(__dirname, "../../migrations");
  const storage = SqliteStorage.create({ dbPath: args.db, migrationsDir });

  // OllamaClient handles query embedding for semantic and hybrid modes.
  // Keyword mode never calls llm.embed(), so this is safe even for
  // keyword-only runs.
  const llm: LLMClient = new OllamaClient({ embedModel: "nomic-embed-text" });
  const recall = new RecallService({ store: storage.sessions, llm });

  console.log(
    `private-bench: ${slice.length} queries, modes=${args.modes.join(",")}, k=${args.k}`,
  );

  const results: QueryResult[] = [];
  const t0 = Date.now();
  for (let i = 0; i < slice.length; i++) {
    const query = slice[i];
    if (!query) continue;
    const result = await runQuery(query, args.modes, args.k, recall);
    results.push(result);
    if ((i + 1) % 10 === 0 || i === slice.length - 1) {
      console.log(`  [${i + 1}/${slice.length}]`);
    }
  }

  const agg: Record<string, ReturnType<typeof aggregate>> = {};
  for (const mode of args.modes) {
    agg[mode] = aggregate(
      results.map((r) => r.by_mode[mode] as SingleScore).filter(Boolean),
    );
  }

  const byCategory: Record<string, Record<string, ReturnType<typeof aggregate>>> = {};
  const categories = new Set(results.map((r) => r.category));
  for (const cat of categories) {
    byCategory[cat] = {};
    for (const mode of args.modes) {
      const subset = results
        .filter((r) => r.category === cat)
        .map((r) => r.by_mode[mode] as SingleScore)
        .filter(Boolean);
      byCategory[cat]![mode] = aggregate(subset);
    }
  }

  const ranAt = new Date().toISOString();
  const reportPayload = {
    n: results.length,
    k: args.k,
    modes: args.modes,
    lockedAt,
    ranAt,
    db: args.db,
    elapsed_seconds: (Date.now() - t0) / 1000,
    aggregate: agg,
    by_category: byCategory,
    // per_query contains id + category + scores. Question text is excluded.
    per_query: results.map((r) => ({
      id: r.id,
      category: r.category,
      by_mode: r.by_mode,
    })),
  };

  mkdirSync(args.reportDir, { recursive: true });
  writeFileSync(join(args.reportDir, "results.json"), JSON.stringify(reportPayload, null, 2));
  writeFileSync(join(args.reportDir, "summary.md"), renderSummary(reportPayload));

  console.log(`private-bench: wrote reports to ${args.reportDir}/`);
  console.log(renderSummary(reportPayload));

  await storage.close();
}

void main().catch((err) => {
  console.error("private-bench: fatal", err);
  process.exit(1);
});
