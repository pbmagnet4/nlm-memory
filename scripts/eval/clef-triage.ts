/**
 * H2 evaluation: can one Clef call per session (kind, importance, flags) tell the
 * sessions worth a generative classifier call from the ones that are not.
 *
 * Gold and results live in $NLM_EVAL_DATA_DIR/triage (never in the repo):
 *   gold-bodies.json     [{ id, runtime, cited, body }]   from build-classifier-gold.ts
 *   labels-final.json    [{ id, importance, kind, has_decision }]   audited labels
 *   classifier-out.json  [{ id, confidence }]   optional, production classifier self-confidence
 * Clef answers are cached in clef-triage-answers.json so reruns are free.
 *
 * Run: npx tsx scripts/eval/clef-triage.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askClef, type ClefAnswer } from "../../src/llm/clef-client.js";
import { capState, triageQuestions } from "../../src/core/classifier/triage-panel.js";
import { auc, brier, splitOf, sweep, wilson } from "./lib/clef-stats.js";

const dataDir = join((process.env["NLM_EVAL_DATA_DIR"] ?? join(homedir(), ".nlm", "eval")).replace(/^~/, homedir()), "triage");
const env = Object.fromEntries(readFileSync(join(homedir(), ".nlm", ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]! };

interface Gold { id: string; runtime: string; cited: boolean; body: string }
interface Label { id: string; importance: number; kind: string; has_decision: boolean }
interface Answered { id: string; ms: number; answers: Record<string, ClefAnswer> }

const gold = JSON.parse(readFileSync(join(dataDir, "gold-bodies.json"), "utf8")) as Gold[];
const answersPath = join(dataDir, "clef-triage-answers.json");
const cached: Answered[] = existsSync(answersPath) ? (JSON.parse(readFileSync(answersPath, "utf8")) as Answered[]) : [];
const have = new Set(cached.map((a) => a.id));
for (const g of gold) {
  if (have.has(g.id)) continue;
  const { answers, ms } = await askClef({ session: capState(g.body) }, triageQuestions(), opts);
  cached.push({ id: g.id, ms, answers });
  writeFileSync(answersPath, JSON.stringify(cached));
}
console.log(`clef answers: ${cached.length} sessions, median ${[...cached.map((a) => a.ms)].sort((a, b) => a - b)[Math.floor(cached.length / 2)]} ms`);

const labelsPath = join(dataDir, "labels-final.json");
if (!existsSync(labelsPath)) {
  console.log("no labels-final.json yet; stop after collecting answers");
  process.exit(0);
}
const labels = new Map((JSON.parse(readFileSync(labelsPath, "utf8")) as Label[]).map((l) => [l.id, l]));
const byId = new Map(cached.map((a) => [a.id, a]));
const cite = new Map(gold.map((g) => [g.id, g.cited]));

const scoreOf = (a: ClefAnswer | undefined): number => (a?.type === "score" ? a.score : Number.NaN);
const rows = [...labels.values()].map((l) => {
  const a = byId.get(l.id)!;
  const kind = a.answers["kind"];
  return {
    id: l.id,
    cited: cite.get(l.id) ?? false,
    score: scoreOf(a.answers["importance"]),
    positive: l.importance >= 2,
    labelImportance: l.importance,
    kindOk: kind?.type === "choice" && kind.choice === l.kind,
  };
});

const report = (name: string, part: typeof rows, thresholds: number[]) => {
  const pos = part.filter((r) => r.positive).length;
  console.log(`\n${name}: ${part.length} sessions, ${pos} worth classifying, ${part.length - pos} not, AUC ${auc(part).toFixed(3)}${pos < 30 || part.length - pos < 30 ? " (indicative only, a class is under 30)" : ""}`);
  for (const t of sweep(part, thresholds)) {
    const kept = Math.round(t.positiveKept * pos);
    const [lo] = wilson(kept, pos);
    const skipShare = part.filter((r) => r.score < t.threshold).length / part.length;
    console.log(`  thr ${t.threshold}: worthwhile kept ${(t.positiveKept * 100).toFixed(0)}% (lower ${(lo * 100).toFixed(0)}%), not-worthwhile skipped ${(t.negativeSkipped * 100).toFixed(0)}%, all sessions skipped ${(skipShare * 100).toFixed(0)}%`);
  }
};
const THRESHOLDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const tune = rows.filter((r) => splitOf(r.id) === "tune");
const holdout = rows.filter((r) => splitOf(r.id) === "holdout");
report("tune", tune, THRESHOLDS);
report("holdout", holdout, THRESHOLDS);
report("holdout, not cited only", holdout.filter((r) => !r.cited), THRESHOLDS);

// Pick the highest threshold that keeps every worthwhile tune session, then read it on holdout.
const safe = sweep(tune, THRESHOLDS).filter((t) => t.positiveKept === 1).map((t) => t.threshold);
const chosen = safe.length ? Math.max(...safe) : undefined;
console.log(`\nthreshold chosen on tune (keeps all worthwhile): ${chosen ?? "none"}`);
if (chosen !== undefined) {
  const missed = holdout.filter((r) => r.positive && r.score < chosen).length;
  const skipped = holdout.filter((r) => r.score < chosen).length;
  console.log(`holdout at ${chosen}: worthwhile sessions skipped ${missed} of ${holdout.filter((r) => r.positive).length}, all sessions skipped ${skipped} of ${holdout.length}`);
}

const within1 = rows.filter((r) => Math.abs(Math.round(r.score) - r.labelImportance) <= 1).length;
console.log(`\nimportance within one level of label: ${within1} of ${rows.length}; kind exact: ${rows.filter((r) => r.kindOk).length} of ${rows.length}`);

const clsPath = join(dataDir, "classifier-out.json");
if (existsSync(clsPath)) {
  const cls = new Map((JSON.parse(readFileSync(clsPath, "utf8")) as { id: string; confidence: number | null }[]).map((c) => [c.id, c.confidence]));
  const both = holdout.filter((r) => typeof cls.get(r.id) === "number");
  if (both.length > 0) {
    const clefP = both.map((r) => ({ p: Math.min(1, Math.max(0, r.score / 3)), y: r.positive }));
    const clsP = both.map((r) => ({ p: cls.get(r.id) as number, y: r.positive }));
    console.log(`\ncalibration on ${both.length} holdout sessions (lower is better): classifier self-confidence Brier ${brier(clsP).toFixed(3)} (AUC ${auc(both.map((r) => ({ score: cls.get(r.id) as number, positive: r.positive }))).toFixed(3)}), Clef importance/3 Brier ${brier(clefP).toFixed(3)} (AUC ${auc(both).toFixed(3)})`);
  }
}
