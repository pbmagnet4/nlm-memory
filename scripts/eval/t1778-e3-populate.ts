/**
 * T1778 E3 — populate precision gate.
 *
 * The T1633 exact-baseline sample: 100 pages with the statements the populate
 * step pulled, each row labelled CORRECT or WRONG by the grader, plus the step-C
 * file with the lines populate actually drafted. One call per page: the page is
 * the shared state, every statement on it is one score question.
 *
 * Split: fixed hash of the SUBJECT, so 86 subjects never straddle tune/holdout.
 * The operating point is the highest threshold still keeping >= 80 % of the
 * CORRECT rows on tune, then read on holdout: precision there, plus how many
 * WRONG rows it removes. A free rule (the statement is more than a bare token)
 * is printed next to it because that is the bar the findings doc sets.
 *
 * Run: npx tsx scripts/eval/t1778-e3-populate.ts --model=clef-flash-oQ8e
 *      npx tsx scripts/eval/t1778-e3-populate.ts --report=go
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitOf } from "./lib/clef-stats.js";
import { ask, loadAvg, mapLimit, pctl, warm, type ClefModel } from "./lib/t1778-clef.js";
import { populateQuestions, populateState, type PopulateVariant } from "./lib/t1778-questions.js";
import { auc, rate, thresholdForKeep } from "./lib/t1778-stats.js";

interface BaseRow { i: number; subject: string; label: string; statements: string[]; page_title: string; verdict: "CORRECT" | "WRONG"; category: string }
interface GradedRow { i: number; subject: string; statements: string[]; outcome: string; verdict?: "CORRECT" | "WRONG"; base_verdict: "CORRECT" | "WRONG" }
export interface ScoredRow {
  set: "base" | "stepc"; i: number; subject: string; title: string; stmtIndex: number;
  statement: string; correct: boolean; category: string; variant: string; model: string;
  score: number; pHigh: number; ms: number; error?: string;
}

const VARIANTS: PopulateVariant[] = ["P1_informative", "P2_pageworthy", "P3_notAssumable"];
const arg = (k: string, def: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? def;
const dir = join(import.meta.dirname, "../../.eval/populate");
mkdirSync(dir, { recursive: true });
const evRoot = join(import.meta.dirname, "../../.eval");

const base = readFileSync(join(evRoot, "precision-sample.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as BaseRow);
const graded = readFileSync(join(evRoot, "graded.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GradedRow)
  .filter((r) => r.outcome === "drafted" && (r.verdict === "CORRECT" || r.verdict === "WRONG") && r.statements.length > 0);

console.log(`base rows ${base.length} (${base.filter((r) => r.verdict === "CORRECT").length} CORRECT), step-C drafted+graded ${graded.length}`);

if (arg("report", "") === "go") { report(); } else { void collect(); }

async function collect(): Promise<void> {
  const model = arg("model", "clef-flash-oQ8e") as ClefModel;
  const parallel = Number.parseInt(arg("parallel", "3"), 10);
  const variants = arg("variants", "all") === "all" ? VARIANTS : [arg("variants", "") as PopulateVariant];
  console.log(`E3 ${model}: ${variants.join(",")}, load ${loadAvg()}`);
  console.log(`warm ${await warm(model)} ms`);
  for (const variant of variants) {
    const outPath = join(dir, `rows-${model}-${variant}.json`);
    const done: ScoredRow[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as ScoredRow[]) : [];
    const have = new Set(done.map((r) => `${r.set}:${r.i}:${r.stmtIndex}`));

    type Job = { set: "base" | "stepc"; i: number; subject: string; title: string; statements: string[]; correct: boolean; category: string };
    const jobs: Job[] = [];
    for (const r of base) {
      if (r.statements.some((_, si) => !have.has(`base:${r.i}:${si}`))) {
        jobs.push({ set: "base", i: r.i, subject: r.subject, title: r.page_title, statements: r.statements, correct: r.verdict === "CORRECT", category: r.category });
      }
    }
    for (const r of graded) {
      if (r.statements.some((_, si) => !have.has(`stepc:${r.i}:${si}`))) {
        jobs.push({ set: "stepc", i: r.i, subject: r.subject, title: `${r.subject} (drafted line)`, statements: r.statements, correct: r.verdict === "CORRECT", category: "" });
      }
    }
    const rows = await mapLimit(jobs, parallel, async (job) => {
      const page = { subject: job.subject, title: job.title };
      try {
        const res = await ask(model, populateState(page), populateQuestions(page, job.statements, variant));
        return job.statements.map((s, si): ScoredRow => {
          const a = res.answers[`s${si}`];
          const probs = a && a.type === "score" ? a.probabilities : {};
          return {
            set: job.set, i: job.i, subject: job.subject, title: job.title, stmtIndex: si, statement: s,
            correct: job.correct, category: job.category, variant, model,
            score: a && a.type === "score" ? a.score : Number.NaN, pHigh: (probs["2"] ?? 0) + (probs["3"] ?? 0), ms: res.ms,
          };
        });
      } catch (e) {
        return job.statements.map((s, si): ScoredRow => ({
          set: job.set, i: job.i, subject: job.subject, title: job.title, stmtIndex: si, statement: s,
          correct: job.correct, category: job.category, variant, model, score: Number.NaN, pHigh: 0, ms: 0,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    });
    const all = [...done, ...rows.flat()];
    writeFileSync(outPath, JSON.stringify(all));
    const ms = rows.flat().map((r) => r.ms).filter((v) => v > 0);
    console.log(`  ${variant}: ${rows.flat().length} statements in ${jobs.length} calls, call ms p50 ${pctl(ms, 0.5)} p95 ${pctl(ms, 0.95)}, load ${loadAvg()}`);
  }
}

/** A bare token (a hash, "missing", a date) is the free rule the gate must beat. */
function freeRule(s: string): number {
  return /[A-Za-z]{4}/.test(s) && s.trim().split(/\s+/).length >= 3 ? 1 : 0;
}

function rows(): ScoredRow[] {
  const out: ScoredRow[] = [];
  for (const model of ["clef-flash-oQ8e", "clef-oQ4e"]) {
    for (const variant of VARIANTS) {
      const p = join(dir, `rows-${model}-${variant}.json`);
      if (existsSync(p)) out.push(...(JSON.parse(readFileSync(p, "utf8")) as ScoredRow[]).filter((r) => !r.error && Number.isFinite(r.score)));
    }
  }
  return out;
}

function report(): void {
  const all = rows().filter((r) => r.set === "base");
  const stepc = rows().filter((r) => r.set === "stepc");
  console.log(`E3 populate gate — base statements ${all.length}, step-C drafted ${stepc.length}`);
  const key = (r: ScoredRow): string => `${r.model} ${r.variant}`;
  for (const set of [all, stepc]) {
    if (!set.length) continue;
    console.log(`\n  ${set === all ? "base (extracted statements)" : "step-C (drafted lines)"} — split by subject, threshold keeps >= 90 % of tune CORRECT, reported on holdout:`);
    const groups = new Map<string, ScoredRow[]>();
    for (const r of set) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    for (const [k, set2] of [...groups.entries()].sort()) {
      const tune = set2.filter((r) => splitOf(r.subject) === "tune");
      const hold = set2.filter((r) => splitOf(r.subject) === "holdout");
      const thr = thresholdForKeep(tune.map((r) => ({ score: r.score, positive: r.correct })), 0.9);
      const kept = hold.filter((r) => r.score >= thr);
      const tp = kept.filter((r) => r.correct).length;
      const wrongKept = kept.filter((r) => !r.correct).length;
      const wrongAll = hold.filter((r) => !r.correct).length;
      const corAll = hold.filter((r) => r.correct).length;
      const prec = tp / Math.max(tp + wrongKept, 1);
      console.log(`    ${k.padEnd(32)} holdout n=${hold.length} AUC ${auc(hold.map((r) => ({ score: r.score, positive: r.correct }))).toFixed(3)} (tune ${auc(tune.map((r) => ({ score: r.score, positive: r.correct }))).toFixed(3)}) thr ${thr.toFixed(2)} | correct kept ${rate(tp, corAll)} | precision ${rate(tp, tp + wrongKept)} | wrong removed ${rate(wrongAll - wrongKept, wrongAll)}`);
    }
    const freeH = set.filter((r) => splitOf(r.subject) === "holdout");
    const freeKept = freeH.filter((r) => freeRule(r.statement) === 1);
    console.log(`    ${"FREE RULE (multi-word, not a bare token)".padEnd(32)} holdout n=${freeH.length} AUC ${auc(freeH.map((r) => ({ score: freeRule(r.statement), positive: r.correct }))).toFixed(3)} | correct kept ${rate(freeKept.filter((r) => r.correct).length, freeH.filter((r) => r.correct).length)} | precision ${rate(freeKept.filter((r) => r.correct).length, freeKept.length)} | wrong removed ${rate(freeH.filter((r) => !r.correct).length - freeKept.filter((r) => !r.correct).length, freeH.filter((r) => !r.correct).length)}`);
  }
  const catCount = new Map<string, number>();
  for (const r of all.filter((x) => !x.correct)) catCount.set(r.category, (catCount.get(r.category) ?? 0) + 1);
  console.log(`\n  WRONG statement categories (base): ${[...catCount.entries()].map(([c, n]) => `${c || "uncategorised"} ${n}`).join(", ")}`);
}
