/**
 * Fact-recall benchmark — measures recall_facts quality (R@1/R@3/R@5, mean
 * rank) over a sandbox copy of the production corpus, driving the REAL
 * FactRecallService code path the MCP tool uses.
 *
 * Methodology: each current decision fact's (subject, predicate) is unique
 * among current facts (supersedence collapses collisions), so a query framed
 * from subject+predicate has exactly ONE correct answer with the value (the
 * answer) held out. That makes this a well-posed retrieval task: "given a
 * topic, does the right decision rank top-k among facts that share those
 * tokens." Deterministic, reproducible, no LLM in gold generation. A natural-
 * language-paraphrase gold set (LLM-framed queries) is a harder future arm.
 *
 * Production safety: opens a COPY of canonical.sqlite under a temp dir. The
 * live daemon DB at ~/.nlm is never opened.
 *
 * Run: npx tsx scripts/eval/fact-recall-eval.ts [--limit=80] [--probe=50]
 *        [--modes=keyword,semantic,hybrid] [--db=<path>] [--json=<out>]
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "@core/storage/sqlite-storage.js";
import { OllamaClient } from "../../src/llm/ollama-client.js";
import { FactRecallService } from "@core/recall-facts/fact-recall-service.js";
import type { Fact, RecallMode } from "@shared/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

interface Args {
  limit: number;
  probe: number;
  modes: RecallMode[];
  dbPath: string;
  jsonOut: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const modesRaw = get("modes") ?? "keyword,semantic,hybrid";
  return {
    limit: Number.parseInt(get("limit") ?? "80", 10),
    probe: Number.parseInt(get("probe") ?? "50", 10),
    modes: modesRaw.split(",").map((m) => m.trim() as RecallMode),
    dbPath: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
    jsonOut: get("json") ?? null,
  };
}

/** Copy the corpus (+ WAL/SHM if present) into a throwaway sandbox dir. */
function sandboxCopy(srcDb: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nlm-fact-recall-"));
  const dst = join(dir, "canonical.sqlite");
  copyFileSync(srcDb, dst);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(srcDb + suffix)) copyFileSync(srcDb + suffix, dst + suffix);
  }
  return { path: dst, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Deterministic even-stride sample of `count` facts from the candidate pool
 * (already ordered by listForRecall). Stride sampling spreads the picks across
 * the whole corpus instead of clustering on the most-recent N.
 */
function sample(facts: ReadonlyArray<Fact>, count: number): ReadonlyArray<Fact> {
  if (facts.length <= count) return facts;
  const stride = facts.length / count;
  const out: Fact[] = [];
  for (let i = 0; i < count; i++) out.push(facts[Math.floor(i * stride)]!);
  return out;
}

interface ModeMetrics {
  mode: RecallMode;
  n: number;
  found: number;
  r1: number;
  r3: number;
  r5: number;
  meanRankWhenFound: number;
}

function pct(num: number, denom: number): number {
  return denom === 0 ? 0 : Math.round((num / denom) * 1000) / 10;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.error(`fact-recall-eval: corpus=${args.dbPath}`);
  if (!existsSync(args.dbPath)) {
    console.error(`fact-recall-eval: corpus not found at ${args.dbPath}`);
    process.exit(2);
  }

  const sb = sandboxCopy(args.dbPath);
  const storage = SqliteStorage.create({ dbPath: sb.path, migrationsDir: MIGRATIONS_DIR });
  const embedder = new OllamaClient({});
  const factRecall = new FactRecallService({ factStore: storage.facts, llm: embedder });

  // Candidate pool: current decision facts at/above the recall confidence floor.
  const pool = await storage.facts.listForRecall({
    kind: "decision",
    minConfidence: 0.6,
    includeSuperseded: false,
    limit: 100_000,
  });
  const gold = sample(pool, args.limit);
  console.error(
    `fact-recall-eval: ${pool.length} current decision facts; sampled ${gold.length} gold queries`,
  );

  const queries = gold.map((f) => ({
    goldId: f.id,
    query: `${f.subject} ${f.predicate}`,
    subject: f.subject,
    predicate: f.predicate,
  }));

  const allMetrics: ModeMetrics[] = [];
  for (const mode of args.modes) {
    let found = 0;
    let r1 = 0;
    let r3 = 0;
    let r5 = 0;
    let rankSum = 0;
    for (const q of queries) {
      const res = await factRecall.search({ query: q.query, mode, limit: args.probe });
      const idx = res.results.findIndex((h) => h.id === q.goldId);
      if (idx >= 0) {
        const rank = idx + 1;
        found += 1;
        rankSum += rank;
        if (rank <= 1) r1 += 1;
        if (rank <= 3) r3 += 1;
        if (rank <= 5) r5 += 1;
      }
    }
    const m: ModeMetrics = {
      mode,
      n: queries.length,
      found,
      r1: pct(r1, queries.length),
      r3: pct(r3, queries.length),
      r5: pct(r5, queries.length),
      meanRankWhenFound: found === 0 ? 0 : Math.round((rankSum / found) * 100) / 100,
    };
    allMetrics.push(m);
    console.error(
      `  ${mode.padEnd(9)} R@1 ${String(m.r1).padStart(5)}%  R@3 ${String(m.r3).padStart(5)}%  ` +
        `R@5 ${String(m.r5).padStart(5)}%  found ${found}/${m.n}  meanRank ${m.meanRankWhenFound}`,
    );
  }

  await storage.close();
  sb.cleanup();

  if (args.jsonOut) {
    writeFileSync(
      args.jsonOut,
      JSON.stringify({ corpus: args.dbPath, poolSize: pool.length, args, metrics: allMetrics }, null, 2),
    );
    console.error(`fact-recall-eval: wrote ${args.jsonOut}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
