/**
 * T1778 E1 — replay the ingest-gate panel on the flash checkpoint.
 *
 * Same 1,220 sessions, same capState, same gateQuestions() panel as the cached
 * 27B answers (~/.nlm/eval/gate-tune/answers.json, copied to .eval/gate-answers-27b.json),
 * so the only thing that changes is which checkpoint answers. Split membership and
 * the labels (what the classifier stored for the session) come from that cache.
 *
 * Sessions are answered in a deterministic hash order rather than cache order, so
 * a run that is cut short still leaves a sample that is balanced over the three
 * sets and both splits — the fit script works with whatever is on disk.
 *
 * Run: npx tsx scripts/eval/t1778-flash-gate-replay.ts --model flash --parallel 4
 * Out: .eval/flash/gate-answers-<model>.json (git-excluded)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClefAnswer } from "../../src/llm/clef-client.js";
import { gateQuestions } from "../../src/core/classifier/triage-panel.js";
import { CLEF_MODELS, askClefDirect, clefBaseUrl, flag as flagArg, latency, load, mapPool, parseModelFlag, type ClefModelKey } from "./lib/clef-direct.js";

export interface GateRow {
  id: string;
  set: "yield" | "live" | "audited";
  runtime: string;
  chars: number;
  stateChars: number;
  decisions: number;
  facts: number;
  answers: Record<string, ClefAnswer> | null;
  ms: number;
  error?: string;
}

const EVAL = join(import.meta.dirname, "../../.eval");
const DIR = join(EVAL, "flash");
mkdirSync(DIR, { recursive: true });

const states = JSON.parse(readFileSync(join(EVAL, "gate-bodies.json"), "utf8")) as Record<string, { session: string; chars: number }>;
const cached = JSON.parse(readFileSync(join(EVAL, "gate-answers-27b.json"), "utf8")) as GateRow[];
const seen = new Set<string>();
const sessions = cached.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).filter((r) => states[r.id]);

// A 32-bit FNV hash of the id: order-independent, stable across runs.
const h = (s: string): number => {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return x >>> 0;
};

const flag = (name: string, def: number): number => Number(flagArg(name, String(def)));
const model = parseModelFlag(process.argv.slice(2));
const parallel = flag("parallel", 3);
// The host is shared with other inference, so a capped run is often all that fits in
// a window. The cap applies to the yield/live sets only, taken in hash order, which is
// a uniform sample of those sets; the audited set is small and always worth its cost.
const limit = flag("limit", 0);
const outPath = join(DIR, `gate-answers-${model}.json`);
const rows: GateRow[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as GateRow[]) : [];
const done = new Set(rows.filter((r) => r.answers).map((r) => r.id));
let todo = sessions.filter((r) => !done.has(r.id)).sort((a, b) => h(a.id) - h(b.id));
if (limit > 0) {
  const rest = todo.filter((r) => r.set === "audited");
  const main = todo.filter((r) => r.set !== "audited").slice(0, limit);
  todo = [...main, ...rest];
}
const questions = gateQuestions();
console.log(`${CLEF_MODELS[model]} gate panel: ${sessions.length} sessions, ${done.size} answered, ${todo.length} to go, parallel ${parallel}`);

let since = 0;
const t0 = Date.now();
await mapPool(todo, parallel, async (r) => {
  const row: GateRow = { ...r, stateChars: states[r.id]!.session.length, answers: null, ms: 0 };
  try {
    const reply = await askClefDirect({ session: states[r.id]!.session }, questions, { baseUrl: clefBaseUrl(), model: CLEF_MODELS[model], timeoutMs: 90_000 });
    row.answers = reply.answers;
    row.ms = reply.ms;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  const i = rows.findIndex((x) => x.id === r.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  if (++since >= flag("save-every", 25)) {
    since = 0;
    writeFileSync(outPath, JSON.stringify(rows));
    const l = latency(rows.filter((x) => x.answers).map((x) => x.ms));
    console.log(`  ${rows.filter((x) => x.answers).length}/${sessions.length} elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s p50 ${l.p50}ms p95 ${l.p95}ms`);
  }
});
writeFileSync(outPath, JSON.stringify(rows));
const ok = rows.filter((r) => r.answers);
console.log(`done: ${ok.length} answered of ${sessions.length}, ${rows.length - ok.length} failed, ${((Date.now() - t0) / 1000).toFixed(0)}s; this run p50 ${latency(ok.map((r) => r.ms)).p50}ms p95 ${latency(ok.map((r) => r.ms)).p95}ms, load ${load()}`);
