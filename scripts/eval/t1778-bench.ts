/**
 * T1778 — latency bench. Every Clef decision in this evaluation is bought with
 * one call, so the call's cost is the whole argument (the 27B ingest gate was
 * rejected for cost at 2-10 s per session, not for accuracy).
 *
 * Measures the REAL payload shapes, serially, after warming the model:
 *   gate    the whole ingest panel over a capped 15k-char session transcript
 *   hook    one recall hook: a prompt plus N memory items, one question each
 *   populate one page with its drafted statements, one question each
 *   dream   one stored fact plus its evidence quote
 * Reports the same call against a short session and a trivial one-line state so
 * the state-size cost is visible, and prints the machine load with every number
 * because oMLX on this host shares capacity with the daemon's own lanes.
 *
 * Run: npx tsx scripts/eval/t1778-bench.ts [--reps=5] [--model=both]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gateQuestions } from "../../src/core/classifier/triage-panel.js";
import { ask, loadAvg, pctl, warm, type ClefModel } from "./lib/t1778-clef.js";
import { populateQuestions, populateState, recallQuestions, recallState, dreamQuestions, dreamState, type DreamPair } from "./lib/t1778-questions.js";

const arg = (k: string, def: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? def;
const reps = Number.parseInt(arg("reps", "4"), 10);
const models: ClefModel[] = arg("model", "both") === "both" ? ["clef-flash-oQ8e", "clef-oQ4e"] : [arg("model", "clef-flash-oQ8e") as ClefModel];

const bodies = readFileSync(join(import.meta.dirname, "../../.eval/gate/bodies.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; chars: number; state: string });
const long = bodies.filter((b) => b.state.length > 14_000).slice(0, 3);
const short = bodies.filter((b) => b.state.length < 2_000).slice(0, 2);
const gold = readFileSync(join(import.meta.dirname, "../../.eval/gold-usefulness.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { prompt: string; context: string });
const hookItems = (n: number): string[] => gold.slice(0, n).map((g) => g.context);
const pair: DreamPair = {
  fact: "knxt-fm-deployment status: live on public domain",
  evidence: "lifecycle_stage: building",
};

const payloads: Array<{ name: string; model: string; state: unknown; questions: ReturnType<typeof gateQuestions> }> = [
  ...long.map((b, i) => ({ name: `gate panel, 15k session (${i + 1})`, model: "", state: { session: b.state }, questions: gateQuestions() })),
  ...short.map((b, i) => ({ name: `gate panel, short session (${i + 1})`, model: "", state: { session: b.state }, questions: gateQuestions() })),
  { name: "gate panel, one-line state", model: "", state: { session: "User: hello." }, questions: gateQuestions() },
  { name: "recall hook, 1 item", model: "", state: recallState(gold[0]!.prompt), questions: recallQuestions(hookItems(1), "R2_productLine") },
  { name: "recall hook, 5 items", model: "", state: recallState(gold[1]!.prompt), questions: recallQuestions(hookItems(5), "R2_productLine") },
  { name: "recall hook, 10 items", model: "", state: recallState(gold[2]!.prompt), questions: recallQuestions(hookItems(10), "R2_productLine") },
  { name: "populate page, 3 statements", model: "", state: populateState({ subject: "docs-sync", title: "docs-sync: Track Record" }), questions: populateQuestions({ subject: "docs-sync", title: "docs-sync: Track Record" }, ["handles the docs sync skill", "status: installed", "6776a68"], "P1_informative") },
  { name: "dream pair", model: "", state: dreamState(pair), questions: dreamQuestions("D2_score") },
];

for (const model of models) {
  console.log(`\n=== ${model} — warm ${await warm(model)} ms, load ${loadAvg()} ===`);
  for (const p of payloads) {
    const ms: number[] = [];
    let toks = 0;
    for (let i = 0; i < reps; i++) {
      const r = await ask(model, p.state, p.questions);
      ms.push(r.ms);
      toks = r.inputTokens;
    }
    console.log(`  ${(p.name + ` [${Object.keys(p.questions).length} q, ${toks} in-tok]`).padEnd(46)} p50 ${String(pctl(ms, 0.5)).padStart(6)} ms  p95 ${String(pctl(ms, 0.95)).padStart(6)} ms  min ${String(Math.min(...ms)).padStart(6)} ms  load ${loadAvg()}`);
  }
}
