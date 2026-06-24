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
import { join } from "node:path";
import { loadGold, scoreGold, sweepThresholds } from "./lib/matcher-gold.js";
import type { Prediction } from "./lib/matcher-gold.js";
import { openSessionContext } from "./lib/transcript.js";

const get = (k: string): string | undefined => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const GOLD = (get("gold") ?? join(homedir(), ".nlm", "eval", "gold-matcher.jsonl")).replace(/^~/, homedir());
const MIN_RECALL = Number.parseFloat(get("min-recall") ?? "0.9");

const gold = loadGold(GOLD);
console.log(`tune-matcher — gold n=${gold.length}, min-recall=${MIN_RECALL}`);
console.log(`  gold path: ${GOLD}`);
console.log("");

// Plan D: replace this stub with a real matchWorkstream call against seeded workstreams.
// matchWorkstream is synchronous and takes a single MatchInputs arg:
//   matchWorkstream(inputs: MatchInputs): MatchDecision   (src/core/workstream/match.ts)
// Build the MatchInputs per gold session the same way bind.ts does: embed label+summary
// as a "query" vector, semanticSearch for neighbor sessions -> their workstreams (max sim
// per ws) for neighborScores, gather entity-overlap candidates, then pass DEFAULT_WEIGHTS
// and the swept thresholds. Map the decision (bind -> predicted=workstreamId+score;
// ambiguous/create -> predicted=null) into a Prediction.
// Until seeded workstreams exist, we emit stub predictions so the harness math is exercised.
const ctx = openSessionContext();
const preds: Prediction[] = [];

for (const g of gold) {
  const _sessionCtx = ctx.get(g.sessionId); // fetched but not used until Plan D wires matchWorkstream
  // Stub: treat every gold item as a no-bind (score=0) until the real matcher exists.
  preds.push({ goldWorkstream: g.goldWorkstream, predicted: null, score: 0 });
}

ctx.close();

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
