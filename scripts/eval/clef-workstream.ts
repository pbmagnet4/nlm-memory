/**
 * Workstream binding with one Clef `choice` call per session, scored against the
 * same gold set and workstream list as tune-naming.ts (the production namer).
 *
 * Gold rows with an empty goldWorkstream belong to no workstream: abstaining on
 * them is correct, binding them is a false bind. Answers are cached in
 * $NLM_EVAL_DATA_DIR/workstream/clef-answers.json so reruns are free.
 *
 * Run: npx tsx scripts/eval/clef-workstream.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { NAMING_CONTENT_CHARS } from "../../src/core/workstream/bind.js";
import { askClef, type ClefAnswer } from "./lib/clef-client.js";
import { capState } from "./lib/clef-panels.js";
import { wilson } from "./lib/clef-stats.js";
import { pickWorkstream, scoreWorkstreams, workstreamQuestion } from "./lib/workstream-panel.js";

const HOME = homedir();
const dataDir = join((process.env["NLM_EVAL_DATA_DIR"] ?? join(HOME, ".nlm", "eval")).replace(/^~/, HOME));
const env = Object.fromEntries(readFileSync(join(HOME, ".nlm", ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]! };

interface GoldRow { key: string; sessionId: string; label: string; summary: string; goldWorkstream: string }
interface Answered { key: string; ms: number; answer: ClefAnswer | null }

const gold = readFileSync(join(dataDir, "gold-matcher.jsonl"), "utf8").split("\n")
  .filter((l) => l.trim()).map((l) => JSON.parse(l) as GoldRow);

const db = new Database(join(HOME, ".nlm", "canonical.sqlite"), { readonly: true });
const workstreams = db.prepare<[], { id: string; label: string }>("SELECT id, label FROM workstreams WHERE status = 'active'").all();
const ph = gold.map(() => "?").join(",");
const bodies = new Map(db.prepare<string[], { id: string; body: string | null }>(`SELECT id, body FROM sessions WHERE id IN (${ph})`)
  .all(...gold.map((g) => g.sessionId)).map((r) => [r.id, r.body ?? ""]));
db.close();

const ids = workstreams.map((w) => w.id);
const question = { workstream: workstreamQuestion(workstreams.map((w) => w.label)) };

const outDir = join(dataDir, "workstream");
mkdirSync(outDir, { recursive: true });
const answersPath = join(outDir, "clef-answers.json");
const cached: Answered[] = existsSync(answersPath) ? (JSON.parse(readFileSync(answersPath, "utf8")) as Answered[]) : [];
const have = new Set(cached.filter((a) => a.answer).map((a) => a.key));
const todo = gold.filter((g) => !have.has(g.key));

let next = 0;
await Promise.all(Array.from({ length: Math.min(2, todo.length) }, async () => {
  while (next < todo.length) {
    const g = todo[next++]!;
    const body = bodies.get(g.sessionId) || g.summary;
    const t0 = Date.now();
    let answer: ClefAnswer | null = null;
    try {
      answer = (await askClef({ session: capState(`${g.label}\n${body.slice(0, NAMING_CONTENT_CHARS)}`) }, question, opts)).answers["workstream"] ?? null;
    } catch (e) {
      console.log(`\nrow ${g.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const i = cached.findIndex((a) => a.key === g.key);
    const row = { key: g.key, ms: Date.now() - t0, answer };
    if (i >= 0) cached[i] = row; else cached.push(row);
    writeFileSync(answersPath, JSON.stringify(cached));
    process.stdout.write(".");
  }
}));

const byKey = new Map(cached.map((a) => [a.key, a]));
const pct = (k: number, n: number): string => {
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} (${(100 * k / Math.max(n, 1)).toFixed(0)}%, CI ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}%)`;
};

console.log(`\nactive workstreams ${workstreams.length}, gold rows ${gold.length}`);
for (const cutoff of [0, 0.5, 0.7, 0.9]) {
  const rows = gold.map((g) => {
    const a = byKey.get(g.key)?.answer;
    if (!a) return { gold: g.goldWorkstream, pred: null, error: true };
    try {
      return { gold: g.goldWorkstream, pred: pickWorkstream(a, ids, cutoff) };
    } catch {
      return { gold: g.goldWorkstream, pred: null, error: true };
    }
  });
  const pos = scoreWorkstreams(rows.filter((r) => r.gold !== ""));
  const neg = scoreWorkstreams(rows.filter((r) => r.gold === ""));
  console.log(`cutoff ${cutoff}: positives correct ${pct(pos.correct, pos.n)}, wrong ${pos.wrong}, missed ${pos.abstained}, errors ${pos.errors}` +
    ` | no-workstream rows: correct abstain ${pct(neg.abstained, neg.n)}, false bind ${neg.wrong}, errors ${neg.errors}`);
}
const ms = cached.filter((a) => a.answer).map((a) => a.ms).sort((a, b) => a - b);
console.log(`latency: min ${ms[0] ?? "n/a"} ms, median ${ms[Math.floor(ms.length / 2)] ?? "n/a"} ms`);
