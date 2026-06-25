/**
 * Tune the workstream matcher against the hand-labeled gold set.
 *
 * Loads ~/.nlm/eval/gold-matcher.jsonl (produced by dump-matcher-candidates.ts
 * and hand-labeled by the operator), runs the real matchWorkstream function per
 * gold session against the live seeded workstream store, and prints precision +
 * recall + a recommended HIGH/LOW threshold pair.
 *
 * NOTE: This script becomes runnable end-to-end only after Plan D seeds
 * candidate workstreams (NLM_WORKSTREAM_BIND flag + seed + backfill). Plan A
 * ships the harness machinery; the threshold-derivation run is Plan D.
 *
 * Run: npx tsx scripts/eval/tune-matcher.ts
 *      [--gold=~/.nlm/eval/gold-matcher.jsonl]
 *      [--min-recall=0.9]
 *      [--db=~/.nlm/canonical.sqlite]
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import { buildMatchInputs } from "../../src/core/workstream/build-match-inputs.js";
import { scoreCandidates } from "../../src/core/workstream/match.js";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS } from "../../src/core/workstream/thresholds.js";
import { loadGold, scoreGold, sweepThresholds } from "./lib/matcher-gold.js";
import type { Prediction } from "./lib/matcher-gold.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const get = (k: string): string | undefined => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const GOLD = (get("gold") ?? join(homedir(), ".nlm", "eval", "gold-matcher.jsonl")).replace(/^~/, homedir());
const MIN_RECALL = Number.parseFloat(get("min-recall") ?? "0.9");
const DB = (get("db") ?? join(homedir(), ".nlm", "canonical.sqlite")).replace(/^~/, homedir());

const gold = loadGold(GOLD);
console.log(`tune-matcher — gold n=${gold.length}, min-recall=${MIN_RECALL}`);
console.log(`  gold path: ${GOLD}`);
console.log("");

if (gold.length === 0) {
  console.log("  No threshold achieves min-recall=90.0% — check gold file or run Plan D seed first.");
  process.exit(0);
}

const storage = SqliteStorage.create({ dbPath: DB, migrationsDir: MIGRATIONS_DIR });
await storage.init();
const embedder = buildEmbedder();

const preds: Prediction[] = [];
for (const g of gold) {
  const entities = await storage.sessions.getEntities(g.sessionId);
  const inputs = await buildMatchInputs(
    { workstreams: storage.workstreams, sessions: storage.sessions, embedder, thresholds: DEFAULT_THRESHOLDS, weights: DEFAULT_WEIGHTS },
    { sessionId: g.sessionId, label: g.label, summary: g.summary, entities },
  );
  const top = scoreCandidates(inputs)[0];
  preds.push({ goldWorkstream: g.goldWorkstream, predicted: top?.workstreamId ?? null, score: top?.score ?? 0 });
}

await storage.close();

const metrics = scoreGold(preds);
const sweep = sweepThresholds(preds, MIN_RECALL);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(`  total gold sessions:  ${metrics.total}`);
console.log(`  binds made:           ${metrics.binds}`);
console.log(`  correct binds:        ${metrics.correct}`);
console.log(`  precision:            ${pct(metrics.precision)}`);
console.log(`  recall:               ${pct(metrics.recall)}`);
console.log("");
if (sweep.high > 0) {
  console.log(`  Recommended thresholds (min-recall >= ${pct(MIN_RECALL)}):`);
  console.log(`    HIGH = ${sweep.high.toFixed(3)}  (precision ${pct(sweep.precision)}, recall ${pct(sweep.recall)})`);
  console.log(`    LOW  = ${sweep.low.toFixed(3)}`);
} else {
  console.log(`  No threshold achieves min-recall=${pct(MIN_RECALL)} — check gold file or run Plan D seed first.`);
}
