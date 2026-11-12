/**
 * T1778 E1 step 2 — re-ask the whole ingest-gate panel with a chosen model.
 *
 * Same 1,220 sessions, same capState, same gateQuestions() panel as the cached
 * 27B answers in ~/.nlm/eval/gate-tune/answers.json, so the only difference is
 * the model behind the call. Resumable: reruns skip sessions already answered.
 *
 * Run: npx tsx scripts/eval/t1778-e1-collect.ts --model=clef-flash-oQ8e --panel=A_prod [--split=all] [--parallel=3]
 * Out: ./.eval/gate/answers-<model>-<panel>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClefAnswer } from "../../src/llm/clef-client.js";
import { splitOf } from "./lib/clef-stats.js";
import { ask, loadAvg, mapLimit, warm, type ClefModel } from "./lib/t1778-clef.js";
import { panel, type Variant } from "./lib/t1778-panels.js";


export interface AnswerRow {
  id: string;
  set: "yield" | "live" | "audited";
  runtime: string;
  chars: number;
  stateChars: number;
  answers: Record<string, ClefAnswer> | null;
  ms: number;
  inputTokens: number;
  error?: string;
}

const arg = (k: string, def: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? def;
const model = arg("model", "clef-flash-oQ8e") as ClefModel;
const variant = arg("panel", "A_prod") as Variant;
const split = arg("split", "all");
const parallel = Number.parseInt(arg("parallel", "3"), 10);

const dir = join(import.meta.dirname, "../../.eval/gate");
mkdirSync(dir, { recursive: true });
const outPath = join(dir, `answers-${model}-${variant}.json`);
const questions = panel(variant);
const bodies = readFileSync(join(dir, "bodies.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as {
  id: string; set: "yield" | "live" | "audited"; runtime: string; chars: number; state: string;
});

const rows: AnswerRow[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as AnswerRow[]) : [];
const done = new Set(rows.filter((r) => r.answers).map((r) => r.id));
const todo0 = bodies.filter((b) => !done.has(b.id) && (split === "all" || splitOf(b.id) === split));
// Order matters when the run is cut short: fit needs the tune split, and a set
// that never gets answered would silently drop a whole holdout row, so answer
// tune before holdout and round-robin the three sets inside each.
const RANK: Record<string, number> = { audited: 0, live: 1, yield: 2 };
const rank = (b: { id: string; set: string }): number => (splitOf(b.id) === "tune" ? 0 : 100) + (RANK[b.set] ?? 3);
const buckets = new Map<number, typeof todo0>();
for (const b of todo0) buckets.set(rank(b), [...(buckets.get(rank(b)) ?? []), b]);
const todo = [...buckets.entries()].sort((a, b2) => a[0] - b2[0]).flatMap(([, v]) => v);
console.log(`${model}/${variant}/${split}: ${bodies.length} sessions, ${done.size} answered, ${todo.length} to go (order: ${[...buckets.keys()].sort((a, b) => a - b).join(",")}); load ${loadAvg()}`);

const t0 = Date.now();
const t = await warm(model);
console.log(`warm-up call ${t} ms, load ${loadAvg()}`);

let i = 0, since = 0;
await mapLimit(todo, parallel, async (b) => {
  let row: AnswerRow;
  try {
    const r = await ask(model, { session: b.state }, questions);
    row = { id: b.id, set: b.set, runtime: b.runtime, chars: b.chars, stateChars: b.state.length, answers: r.answers, ms: r.ms, inputTokens: r.inputTokens };
  } catch (e) {
    row = { id: b.id, set: b.set, runtime: b.runtime, chars: b.chars, stateChars: b.state.length, answers: null, ms: 0, inputTokens: 0, error: e instanceof Error ? e.message : String(e) };
  }
  rows.push(row);
  const n = ++i;
  if (++since >= 25) {
    since = 0;
    writeFileSync(outPath, JSON.stringify(rows));
    const ms = rows.filter((r) => r.answers).map((r) => r.ms).sort((a, b2) => a - b2);
    console.log(`  ${n}/${todo.length} elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s p50 ${ms[ms.length >> 1]}ms load ${loadAvg()}`);
  }
});
writeFileSync(outPath, JSON.stringify(rows));
const ok = rows.filter((r) => r.answers).length;
console.log(`done: ${ok} answered, ${rows.length - ok} failed in ${((Date.now() - t0) / 1000).toFixed(0)}s, load ${loadAvg()}`);
