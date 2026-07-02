/**
 * Task 8 runbook pointer: tuning levers are the prompt in src/llm/naming.ts,
 * NLM_CLASSIFIER_MAX_TOKENS, and the candidate content budget (NAMING_CONTENT_CHARS
 * in src/core/workstream/bind.ts). Change one lever, re-run, compare to the
 * baseline table committed with this file.
 *
 * Tracked naming-evaluation harness against the locked gold set.
 * Measures the SHIPPED classifier-naming binding path: precision, recall, and
 * negative-abstain rate. No writes to the live DB; no output files.
 *
 * Run:
 *   npx tsx scripts/eval/tune-naming.ts
 *   npx tsx scripts/eval/tune-naming.ts --gold=/path/to/gold.jsonl --db=/path/to/canonical.sqlite
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { buildClassifier } from "../../src/llm/build-classifier.js";
import { NAMING_CONTENT_CHARS } from "../../src/core/workstream/bind.js";
import { decideWorkstreamByName } from "../../src/core/workstream/name-match.js";
import { parseWorkTopics, aliasToLabelMap, aliasesForLabel } from "../../src/core/workstream/work-topics.js";

const HOME = homedir();
const DEFAULT_GOLD = join(HOME, ".nlm", "eval", "gold-matcher.jsonl");
const DEFAULT_DB = join(HOME, ".nlm", "canonical.sqlite");
const DEFAULT_TOPICS = join(HOME, ".nlm", "work-topics.json");

function arg(k: string): string | undefined {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : undefined;
}

interface GoldRow {
  readonly key: string;
  readonly sessionId: string;
  readonly label: string;
  readonly summary: string;
  readonly goldWorkstream: string;
}

interface Workstream {
  readonly id: string;
  readonly label: string;
}

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx]!, idx);
      }
    }),
  );
}

async function main(): Promise<void> {
  const goldPath = arg("gold") ?? DEFAULT_GOLD;
  const dbPath = arg("db") ?? DEFAULT_DB;

  const gold: GoldRow[] = readFileSync(goldPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldRow);

  const db = new Database(dbPath, { readonly: true });

  const wsRows = db
    .prepare<[], Workstream>("SELECT id, label FROM workstreams WHERE status = 'active'")
    .all();

  const topics = parseWorkTopics(JSON.parse(readFileSync(DEFAULT_TOPICS, "utf8")));
  const aliasMap = aliasToLabelMap(topics);

  const sessionIds = gold.map((g) => g.sessionId);
  const ph = sessionIds.map(() => "?").join(",");
  const bodyRows = db
    .prepare<string[], { id: string; body: string | null; summary: string }>(
      `SELECT id, body, COALESCE(summary,'') AS summary FROM sessions WHERE id IN (${ph})`,
    )
    .all(...sessionIds);
  const bodyMap = new Map(bodyRows.map((r) => [r.id, r.body ?? ""]));

  const classifier = buildClassifier();
  const hints = wsRows.map((w) => ({ label: w.label, aliases: aliasesForLabel(aliasMap, w.label) }));
  const wsById = new Map(wsRows.map((w) => [w.id, w.label]));

  console.log(
    `tune-naming  provider=${process.env["NLM_CLASSIFIER"] ?? "ollama"}` +
      `  model=${process.env["NLM_CLASSIFIER_MODEL"] ?? "qwen3.5:4b"}` +
      `  base=${process.env["NLM_CLASSIFIER_BASE_URL"] ?? "http://localhost:11434"}` +
      `  gold n=${gold.length}  workstreams n=${wsRows.length}`,
  );

  type Result = {
    g: GoldRow;
    named: string | null;
    predId: string;
  };
  const results: Result[] = new Array(gold.length);
  const t0 = Date.now();

  await pool(gold, 2, async (g, idx) => {
    const bodyText = bodyMap.get(g.sessionId) ?? "";
    const text = bodyText.length > 0 ? bodyText : g.summary;
    const content = `${g.label}\n${text.slice(0, NAMING_CONTENT_CHARS)}`;
    let named: string | null = null;
    try {
      named = await classifier.nameWorkstream(content, hints);
    } catch {
      named = null;
    }
    const decision = decideWorkstreamByName(named, wsRows, aliasMap);
    results[idx] = { g, named, predId: decision.kind === "bind" ? decision.workstreamId : "" };
    process.stdout.write(".");
  });

  console.log(`\nruntime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  db.close();

  let correctBind = 0;
  let wrongBind = 0;
  let missedBind = 0;
  let correctAbstain = 0;
  let falseBind = 0;

  const misses: string[] = [];

  for (const { g, named, predId } of results) {
    const isPositive = g.goldWorkstream !== "";
    if (isPositive) {
      if (predId === g.goldWorkstream) {
        correctBind++;
      } else if (predId === "") {
        missedBind++;
        misses.push(
          `  missed    sid=${g.sessionId.slice(0, 20)}  gold="${wsById.get(g.goldWorkstream) ?? g.goldWorkstream}"  model="${named ?? "null"}"  label="${g.label.slice(0, 48)}"`,
        );
      } else {
        wrongBind++;
        misses.push(
          `  wrong     sid=${g.sessionId.slice(0, 20)}  gold="${wsById.get(g.goldWorkstream) ?? g.goldWorkstream}"  model="${named ?? "null"}"  pred="${wsById.get(predId) ?? predId}"`,
        );
      }
    } else {
      if (predId === "") {
        correctAbstain++;
      } else {
        falseBind++;
        misses.push(
          `  false-bind  sid=${g.sessionId.slice(0, 20)}  gold=none  model="${named ?? "null"}"  pred="${wsById.get(predId) ?? predId}"`,
        );
      }
    }
  }

  const posTotal = gold.filter((g) => g.goldWorkstream !== "").length;
  const negTotal = gold.length - posTotal;
  const totalBinds = correctBind + wrongBind + falseBind;
  const precision = totalBinds === 0 ? 0 : correctBind / totalBinds;
  const recall = posTotal === 0 ? 0 : correctBind / posTotal;
  const negAbstain = negTotal === 0 ? 0 : correctAbstain / negTotal;

  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

  console.log("=== RESULTS ===");
  console.log(`  positives (n=${posTotal}): correct-bind=${correctBind}  wrong-bind=${wrongBind}  missed=${missedBind}`);
  console.log(`  negatives (n=${negTotal}): correct-abstain=${correctAbstain}  false-bind=${falseBind}`);
  console.log(
    `\n  precision=${pct(precision)}  recall=${pct(recall)}  neg-abstain=${pct(negAbstain)}`,
  );

  if (misses.length > 0) {
    console.log("\n--- misses & errors ---");
    for (const m of misses) console.log(m);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error("tune-naming: fatal", err);
    process.exit(1);
  });
}
