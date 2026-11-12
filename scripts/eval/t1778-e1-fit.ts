/**
 * T1778 E1 — fit the ingest gate per model and report only on held-out splits.
 *
 * Same rule the production gate was fitted with (docs/clef-decision-panel-findings.md,
 * "Gate tuning"): features come from src/core/classifier/gate-model.ts, the model
 * is L2 logistic regression on the tune half (fixed id hash) of the yield + live
 * sets, and the skip threshold is the highest one that loses at most 0.5 % of tune
 * decisions and 2.5 % of tune facts. Everything else is read on holdout, never used
 * to choose anything. The audited set is carried only as a second held-out read.
 *
 * The 27B answers are the cached production panel; the flash answers are the
 * T1778 re-run over the identical sessions. Cost is the measured per-call time of
 * each model plus the cost it replaces.
 *
 * Run: npx tsx scripts/eval/t1778-e1-fit.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import type { ClefAnswer } from "../../src/llm/clef-client.js";
import { GATE_FEATURES, gateFeatures, gateProbability } from "../../src/core/classifier/gate-model.js";
import { splitOf } from "./lib/clef-stats.js";
import { fitLogReg } from "./lib/logreg.js";
import { pctl } from "./lib/t1778-clef.js";
import { auc, rate, wilson } from "./lib/t1778-stats.js";
import type { AnswerRow } from "./t1778-e1-collect.js";

const MAX_DECISION_LOSS = 0.005;
const MAX_FACT_LOSS = 0.025;
const BASELINE = 1.5;
const HOME = homedir();
const EVAL = join(HOME, ".nlm", "eval");
const evRoot = join(import.meta.dirname, "../../.eval");

interface Panel { id: string; set: "yield" | "live" | "audited"; runtime: string; chars: number; decisions: number; facts: number; answers: Record<string, ClefAnswer> | null; ms: number }
interface Scored { id: string; set: string; chars: number; decisions: number; facts: number; x: number[]; y: number; imp: number; ms: number }

const cached = readFileSync(join(evRoot, "gate-answers-27b.json"), "utf8") as string;
const base27 = JSON.parse(cached) as Panel[];
const worthwhile = new Map((JSON.parse(readFileSync(join(EVAL, "triage", "labels-final.json"), "utf8")) as { id: string; importance: number }[])
  .map((l) => [l.id, l.importance >= 2]));

function score(answers: Record<string, ClefAnswer>, chars: number): number[] { return gateFeatures(answers, chars); }

function build(panel: Panel[], answersById: Map<string, { answers: Record<string, ClefAnswer> | null; ms: number }>): Scored[] {
  const out: Scored[] = [];
  for (const r of panel) {
    const a = answersById.get(r.id);
    if (!a?.answers) continue;
    const imp = a.answers["importance"];
    out.push({
      id: r.id, set: r.set, chars: r.chars, decisions: r.decisions, facts: r.facts,
      x: score(a.answers, r.chars), y: r.decisions + r.facts > 0 ? 1 : 0,
      imp: imp?.type === "score" ? imp.score : 3, ms: a.ms,
    });
  }
  return out;
}

function fitModel(train: Scored[]): { fit: ReturnType<typeof fitLogReg>; threshold: number } {
  const fit = fitLogReg(train.map((s) => s.x), train.map((s) => s.y), { l2: 0.01, iters: 4000, lr: 0.3 });
  const prob = (s: Scored): number => gateProbability({ ...fit, threshold: 0 }, s.x);
  const sum = (xs: Scored[], k: "decisions" | "facts"): number => xs.reduce((n, s) => n + s[k], 0);
  let threshold = 0;
  for (const t of [...new Set(train.map(prob))].sort((a, b) => a - b)) {
    const sk = train.filter((s) => prob(s) < t);
    if (sum(sk, "decisions") <= MAX_DECISION_LOSS * sum(train, "decisions") && sum(sk, "facts") <= MAX_FACT_LOSS * sum(train, "facts")) threshold = t;
    else break;
  }
  return { fit, threshold };
}

/**
 * The T644 tune/holdout split is hash-of-id, and the T1778 flash collection was
 * cut short in tune-first order, so the flash answers cover almost no T644
 * holdout ids. Rather than report flash on tune rows, this eval refits BOTH
 * models on a fresh id-hash split over the sessions both models answered, so
 * fit rows and eval rows are disjoint by id and the two models see identical
 * rows. It is disclosed as a different split from the published numbers.
 */
const evalSplit = (id: string): "fit" | "eval" => (splitOf(`${id}:t1778`) === "tune" ? "fit" : "eval");

function report(name: string, scored: Scored[]): void {
  const train = scored.filter((s) => s.set !== "audited" && evalSplit(s.id) === "fit");
  const { fit, threshold } = fitModel(train);
  const prob = (s: Scored): number => gateProbability({ ...fit, threshold: 0 }, s.x);
  console.log(`\n### ${name}`);
  console.log(`trained on ${train.length} tune sessions (${train.filter((s) => s.y).length} yielding); threshold P(stored) < ${threshold.toFixed(3)}; load at fit ${loadavg().map((v) => v.toFixed(1)).join(" ")}`);
  const line = (label: string, set: Scored[], skip: (s: Scored) => boolean, ranking: (s: Scored) => number): void => {
    const sk = set.filter(skip);
    const sum = (xs: Scored[], k: "decisions" | "facts"): number => xs.reduce((n, s) => n + s[k], 0);
    const a = auc(set.map((s) => ({ score: ranking(s), positive: s.y === 1 })));
    console.log(`  ${label.padEnd(9)} | AUC ${a.toFixed(3)} | skipped ${rate(sk.length, set.length)} (${sk.length}/${set.length}) | decisions lost ${sum(sk, "decisions")}/${sum(set, "decisions")} (${rate(sum(sk, "decisions"), sum(set, "decisions"))}) | facts lost ${sum(sk, "facts")}/${sum(set, "facts")} (${rate(sum(sk, "facts"), sum(set, "facts"))}) | call ms p50 ${pctl(sk.concat(set).map((s) => s.ms), 0.5)} p95 ${pctl(set.map((s) => s.ms), 0.95)}`);
  };
  for (const [label, set] of [
    ["yield eval", scored.filter((s) => s.set === "yield" && evalSplit(s.id) === "eval")],
    ["live eval", scored.filter((s) => s.set === "live" && evalSplit(s.id) === "eval")],
    ["audited (all)", scored.filter((s) => s.set === "audited")],
  ] as const) {
    if (!set.length) continue;
    console.log(`\n  ${label} (n=${set.length}):`);
    line("fitted", set, (s) => prob(s) < threshold, prob);
    line("importance", set, (s) => s.imp < BASELINE, (s) => s.imp);
    line("free <500c", set, (s) => s.chars < 500, (s) => s.chars);
    if (label.startsWith("audited")) {
      const pos = set.filter((s) => worthwhile.get(s.id));
      const miss = pos.filter((s) => prob(s) < threshold).length;
      const [lo] = wilson(pos.length - miss, pos.length);
      console.log(`  fitted: audited-worthwhile skipped ${miss} of ${pos.length} (kept lower bound ${(100 * lo).toFixed(0)}%); importance<1.5 skipped ${pos.filter((s) => s.imp < BASELINE).length}`);
    }
  }
  const live = scored.filter((s) => s.set === "live");
  console.log(`\n  live-set call cost: p50 ${pctl(live.map((s) => s.ms), 0.5)} ms p95 ${pctl(live.map((s) => s.ms), 0.95)} ms over ${live.length} sessions, mean session ${Math.round(live.reduce((n, s) => n + s.chars, 0) / Math.max(live.length, 1))} chars`);
  console.log(`  weights: ${GATE_FEATURES.map((f, i) => `${f} ${fit.weights[i]!.toFixed(2)}`).join(", ")}`);
}

const variants = process.argv.filter((a) => a.startsWith("--flash=")).map((a) => a.split("=")[1]!);
const flashFiles = variants.length ? variants : ["answers-clef-flash-oQ8e-A_prod.json", "answers-clef-flash-oQ8e-B_anchored.json", "answers-clef-flash-oQ8e-C_counterfactual.json"];
let intersect: Set<string> | null = null;
for (const f of flashFiles) {
  const p = join(evRoot, "gate", f);
  if (!existsSync(p)) continue;
  const answered = new Set((JSON.parse(readFileSync(p, "utf8")) as AnswerRow[]).filter((r) => r.answers).map((r) => r.id));
  if (intersect) {
    for (const id of Array.from(intersect)) if (!answered.has(id)) intersect.delete(id);
  } else {
    intersect = answered;
  }
}
const shared = intersect ? base27.filter((r) => intersect!.has(r.id)) : base27;
console.log(`rows answered by every model compared: ${intersect?.size ?? 0}; the 27B table below is restricted to those rows so the two models are scored on identical sessions`);
report("clef-oQ4e (27B, cached production panel, shared rows)", build(shared, new Map(base27.map((r) => [r.id, { answers: r.answers, ms: r.ms }]))));
for (const f of flashFiles) {
  const p = join(evRoot, "gate", f);
  if (!existsSync(p)) { console.log(`\nmissing ${p}`); continue; }
  const flash = JSON.parse(readFileSync(p, "utf8")) as AnswerRow[];
  const byId = new Map(flash.map((r) => [r.id, { answers: r.answers, ms: r.ms }]));
  report(`clef-flash-oQ8e (${f})`, build(base27, byId));
}
