/**
 * T1778 E2 — recall relevance gate on the usefulness gold.
 *
 * One call per prompt: the prompt is the shared Clef state, every candidate
 * memory for that prompt is one `score` question, so the state is read once
 * (docs/clef-decision-panel-findings.md: six questions in one call cost about
 * what one costs). Three phrasings, two models.
 *
 * Label caveat (Operations/Tool Lessons/nlm-memory.md, "NLM eval numbers that
 * mislead"): gold-usefulness marks whether the response USED the injected
 * context, not whether it was on topic, so some `unused` rows are relevant and
 * the measured AUC is a lower bound on relevance skill.
 *
 * Split: fixed hash of the PROMPT text, so a prompt's items never straddle tune
 * and holdout. Phrasing and threshold are chosen on tune and reported on holdout.
 *
 * Run: npx tsx scripts/eval/t1778-e2-recall.ts --model=clef-flash-oQ8e
 *      npx tsx scripts/eval/t1778-e2-recall.ts --report
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitOf } from "./lib/clef-stats.js";
import { ask, loadAvg, mapLimit, pctl, warm, type ClefModel } from "./lib/t1778-clef.js";
import { recallQuestions, recallState, type RecallVariant } from "./lib/t1778-questions.js";
import { auc, thresholdForKeep, wilson } from "./lib/t1778-stats.js";

export interface GoldRow { key: string; band: string; prompt: string; context: string; response: string; gold: string }
export interface ItemRow {
  key: string; prompt: string; itemIndex: number; variant: string; model: string;
  gold: string; scores: number[]; pHigh: number[]; ms: number; itemCount: number; error?: string;
}

const ALLV: RecallVariant[] = ["R1_generic", "R2_productLine", "R3_lossIfDropped"];
const arg2 = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const VARIANTS: RecallVariant[] = (arg2("variants")?.split(",").filter(Boolean) ?? ALLV) as RecallVariant[];
const arg = (k: string, def: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? def;
const dir = join(import.meta.dirname, "../../.eval/recall");
mkdirSync(dir, { recursive: true });
const goldPath = process.env["T1778_GOLD"] ?? join(homedir(), ".nlm/eval/gold-usefulness.jsonl");
const gold = readFileSync(goldPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GoldRow);
const groups = [...gold.reduce((m, r) => m.set(r.prompt, [...(m.get(r.prompt) ?? []), r]), new Map<string, GoldRow[]>()).entries()];

if (arg("report", "") === "go") { report(); } else { void collect(); }

async function collect(): Promise<void> {
  const model = arg("model", "clef-flash-oQ8e") as ClefModel;
  const parallel = Number.parseInt(arg("parallel", "2"), 10);
  console.log(`E2 ${model}: ${gold.length} rows in ${groups.length} prompt calls, variants ${VARIANTS.join(",")}, load ${loadAvg()}`);
  console.log(`warm ${await warm(model)} ms`);
  for (const variant of VARIANTS) {
    const outPath = join(dir, `items-${model}-${variant}.json`);
    const done: ItemRow[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as ItemRow[]) : [];
    const have = new Set(done.map((r) => `${r.key}`));
    const todo = groups
      .map(([prompt, rows]) => ({ prompt, rows }))
      .filter((g) => !g.rows.every((r) => have.has(r.key)));
    let calls = 0;
    const rows = await mapLimit(todo, parallel, async (g) => {
      const items = g.rows.map((r) => r.context);
      try {
        const r = await ask(model, recallState(g.prompt), recallQuestions(items, variant));
        calls++;
        return g.rows.map((row, i): ItemRow => {
          const a = r.answers[`i${i}`];
          const probs = a && a.type === "score" ? a.probabilities : {};
          const pHigh = (probs["2"] ?? 0) + (probs["3"] ?? 0);
          return {
            key: row.key, prompt: g.prompt, itemIndex: i, variant, model, gold: row.gold,
            scores: [a && a.type === "score" ? a.score : Number.NaN], pHigh: [pHigh], ms: r.ms, itemCount: items.length,
          };
        });
      } catch (e) {
        return g.rows.map((row, i): ItemRow => ({
          key: row.key, prompt: g.prompt, itemIndex: i, variant, model, gold: row.gold,
          scores: [Number.NaN], pHigh: [0], ms: 0, itemCount: items.length, error: e instanceof Error ? e.message : String(e),
        }));
      }
    });
    const all = [...done, ...rows.flat()];
    writeFileSync(outPath, JSON.stringify(all));
    const ms = rows.map((r) => r[0]!.ms).filter((v) => v > 0);
    console.log(`  ${variant}: ${rows.length} items in ${calls} calls, call ms p50 ${pctl(ms, 0.5)} p95 ${pctl(ms, 0.95)} (items/call avg ${(rows.length / Math.max(calls, 1)).toFixed(1)}), load ${loadAvg()}`);
  }
}

/** score*8/3 puts every variant on one 0-8 scale; the operating points are per model+variant. */
function flat(): ItemRow[] {
  const out: ItemRow[] = [];
  for (const model of ["clef-flash-oQ8e", "clef-oQ4e"]) {
    for (const variant of VARIANTS) {
      const p = join(dir, `items-${model}-${variant}.json`);
      if (existsSync(p)) out.push(...(JSON.parse(readFileSync(p, "utf8")) as ItemRow[]).filter((r) => !r.error && Number.isFinite(r.scores[0]!)));
    }
  }
  return out;
}

function report(): void {
  const rows = flat();
  const positive = (r: ItemRow): boolean => r.gold !== "unused";
  console.log(`E2 recall gate — ${rows.length} scored items, labels used|partial vs unused`);
  const byCall = new Map<string, ItemRow[]>();
  for (const r of rows) byCall.set(`${r.model}|${r.variant}`, [...(byCall.get(`${r.model}|${r.variant}`) ?? []), r]);
  for (const [k, set] of byCall) {
    const scored = set.map((r) => ({ score: r.scores[0]!, positive: positive(r), split: splitOf(r.prompt), key: r.key, ms: r.ms, n: r.itemCount }));
    const tune = scored.filter((s) => s.split === "tune");
    const hold = scored.filter((s) => s.split === "holdout");
    const thr = thresholdForKeep(tune, 0.9);
    const kept = hold.filter((s) => s.score >= thr);
    const keptPos = kept.filter((s) => s.positive).length, allPos = hold.filter((s) => s.positive).length;
    const skippedNeg = hold.filter((s) => !s.positive && s.score < thr).length, allNeg = hold.filter((s) => !s.positive).length;
    const [lo] = wilson(keptPos, allPos);
    const ms = set.map((s) => s.ms);
    console.log(`  ${k.padEnd(32)} holdout n=${hold.length} AUC ${auc(hold).toFixed(3)} (tune ${auc(tune).toFixed(3)}) | thr ${thr.toFixed(2)}: positives kept ${keptPos}/${allPos} (LB ${(100 * lo).toFixed(0)}%) negatives skipped ${skippedNeg}/${allNeg} | call ms p50 ${pctl(ms, 0.5)} p95 ${pctl(ms, 0.95)}`);
  }
  const byCallLen = new Map<number, number[]>();
  for (const r of rows) if (r.itemCount > 0) byCallLen.set(r.itemCount, [...(byCallLen.get(r.itemCount) ?? []), r.ms]);
  for (const [n, ms] of [...byCallLen.entries()].sort()) console.log(`  call with ${n} item(s): n=${ms.length} p50 ${pctl(ms, 0.5)} ms p95 ${pctl(ms, 0.95)} ms`);
}
