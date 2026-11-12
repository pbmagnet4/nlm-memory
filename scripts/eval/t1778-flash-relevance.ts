/**
 * T1778 E2 + E3 — Clef as a relevance gate (recall hook) and as a populate gate.
 *
 * Both are the same shape: one call, one state read, one ordered-level `score`
 * question per thing being judged. E2 puts the prompt and every candidate memory in
 * the state and asks one relevance question per memory (that is the 5-10 item hook).
 * E3 puts a page's subject and its drafted statements in the state and asks one
 * informativeness question per statement.
 *
 * Two phrasings ride in the same call so the wording choice costs nothing extra; the
 * winner is picked on the tune split and only then read on holdout.
 *
 * Run: npx tsx scripts/eval/t1778-flash-relevance.ts --model flash --task e2 [--probe=8]
 *      npx tsx scripts/eval/t1778-flash-relevance.ts --model flash --task e3
 * Out: .eval/relevance/<task>-<model>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClefAnswer, ClefQuestion } from "../../src/llm/clef-client.js";
import { CLEF_MODELS, askClefDirect, clefBaseUrl, flag, latency, load, mapPool, parseModelFlag, type ClefModelKey } from "./lib/clef-direct.js";

const EVAL = join(import.meta.dirname, "../../.eval");
const DIR = join(EVAL, "relevance");
mkdirSync(DIR, { recursive: true });


/** The recall hook: is this memory worth the tokens under this prompt? */
const RECALL_LEVELS = [
  "Unrelated: another project, subject or task; nothing here bears on the prompt.",
  "Neighbourhood: the same general area, but nothing the reply could act on.",
  "Useful: the same project or component, and real background for what is being asked.",
  "Load-bearing: it holds the specific decision, value, path or status the prompt needs.",
];
const RECALL_PHRASES: Record<string, string> = {
  relevant: "How relevant is this memory to the prompt?",
  needed: "Before answering the prompt, how much of this memory would an assistant need?",
};

/** The populate gate: does this drafted line actually tell a reader something? */
const POP_LEVELS = [
  "Nothing: a fragment, a bare identifier or a restatement of the page name.",
  "Barely: a status word with no subject content, e.g. 'missing' or 'retired'.",
  "Something: one concrete attribute, setting or action of the subject.",
  "A lot: a specific, checkable claim a reader could act on or quote.",
];
const POP_PHRASES: Record<string, (subject: string) => string> = {
  tell: (s) => `How much does this statement tell a reader about ${s}?`,
  check: (s) => `How specific and checkable is this statement about ${s}?`,
};

const questions = (names: string[], stateOrSubject: unknown, phrases: Record<string, unknown>, levels: string[]): Record<string, ClefQuestion> => {
  const q: Record<string, ClefQuestion> = {};
  names.forEach((_, i) => {
    for (const [name, ins] of Object.entries(phrases)) {
      q[`x${i}_${name}`] = { type: "score", instructions: typeof ins === "function" ? (ins as (s: string) => string)(String(stateOrSubject)) : String(ins), criteria: levels };
    }
  });
  return q;
};

interface Unit { key: string; state: unknown; subject: string; phrases: Record<string, unknown>; levels: string[]; n: number }

function units(task: string): Unit[] {
  if (task === "e2") {
    const gold = readFileSync(join(EVAL, "gold-usefulness.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { key: string; prompt: string; context: string });
    const byPrompt = new Map<string, string[]>();
    for (const g of gold) byPrompt.set(g.key, [g.prompt, g.context]);
    return [...byPrompt.entries()].map(([key, [prompt, context]]) => ({
      key, subject: "", phrases: RECALL_PHRASES, levels: RECALL_LEVELS, n: 1,
      state: { prompt, memories: [{ n: 1, memory: context }] },
    }));
  }
  const rows = readFileSync(join(EVAL, "precision-sample.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { i: number; subject: string; label: string; page_title: string; statements: string[] });
  return rows.map((r) => ({
    key: String(r.i), subject: r.subject, phrases: POP_PHRASES, levels: POP_LEVELS, n: r.statements.length,
    state: { page_title: r.page_title, subject: r.subject, label: r.label, statements: r.statements },
  }));
}

interface Row { key: string; ms: number; stateChars: number; nQuestions: number; answers: Record<string, ClefAnswer> | null; error?: string }

const task = flag("task", "e2");
const model = parseModelFlag(process.argv.slice(2));
const parallel = Number(flag("parallel", "2"));
const outPath = join(DIR, `${task}-${model}.json`);
const all = units(task);
const rows: Row[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as Row[]) : [];
const done = new Set(rows.filter((r) => r.answers).map((r) => r.key));
const todo = all.filter((u) => !done.has(u.key));
console.log(`${task} ${CLEF_MODELS[model]}: ${all.length} calls, ${done.size} done, ${todo.length} to go`);

let since = 0;
await mapPool(todo, parallel, async (u) => {
  const q = questions(Array.from({ length: u.n }, (_, i) => String(i)), u.subject, u.phrases, u.levels);
  const row: Row = { key: u.key, ms: 0, stateChars: JSON.stringify(u.state).length, nQuestions: Object.keys(q).length, answers: null };
  try {
    const r = await askClefDirect(u.state, q, { baseUrl: clefBaseUrl(), model: CLEF_MODELS[model], timeoutMs: 60_000 });
    row.answers = r.answers;
    row.ms = r.ms;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  const i = rows.findIndex((r) => r.key === u.key);
  if (i >= 0) rows[i] = row; else rows.push(row);
  if (++since >= 25) { since = 0; writeFileSync(outPath, JSON.stringify(rows)); }
}, 25);
writeFileSync(outPath, JSON.stringify(rows));
const ok = rows.filter((r) => r.answers).map((r) => r.ms);
const l0 = latency(ok);
console.log(`${task} ${model}: ${ok.length}/${all.length} answered, p50 ${l0.p50}ms p95 ${l0.p95}ms at parallel ${parallel}, load ${load()}`);

/**
 * The hook-cost question in E2: a real hook scores 8 memories at once, and the budget
 * is 1000 ms for the whole hook. Measured serially, both models, one phrasing (what
 * adoption would send) and both (what tuning sends).
 */
const probeIndex = process.argv.indexOf("--probe");
if (probeIndex >= 0 && task === "e2") {
  const n = Number(process.argv[probeIndex + 1]) || 8;
  const gold = readFileSync(join(EVAL, "gold-usefulness.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { prompt: string; context: string });
  const picked = Array.from({ length: n }, (_, i) => gold[Math.round((i * (gold.length - 1)) / (n - 1))]!);
  const state = { prompt: picked[0]!.prompt, memories: picked.map((g, i) => ({ n: i + 1, memory: g.context })) };
  for (const [label, phrases] of [["one phrasing", { relevant: RECALL_PHRASES.relevant! }], ["two phrasings", RECALL_PHRASES]] as const) {
    const q = questions(picked.map((_, i) => String(i)), "", phrases, RECALL_LEVELS);
    const ms: Record<string, number[]> = { flash: [], base: [] };
    // Per-model batches: the host swaps checkpoints, so alternating models per call
    // would charge every call for a reload and measure nothing.
    for (const key of ["flash", "base"] as ClefModelKey[]) {
      for (let i = 0; i < 5; i++) {
        ms[key]!.push((await askClefDirect(state, q, { baseUrl: clefBaseUrl(), model: CLEF_MODELS[key], timeoutMs: 60_000 })).ms);
      }
    }
    for (const key of ["flash", "base"] as ClefModelKey[]) {
      const l = latency(ms[key]!);
      console.log(`probe ${n} memories ${label} (${Object.keys(q).length} questions), ${JSON.stringify(state).length} chars, ${key}: p50 ${l.p50}ms p95 ${l.p95}ms, load ${load()}`);
    }
  }
}
