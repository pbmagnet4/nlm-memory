/**
 * Diagnostic: does the recall similarity SCORE of the injected top hit predict
 * whether the agent finds it off-topic? Decides the recall-precision approach.
 *
 *   off-topic fires have LOW scores  -> a relevance threshold fixes it (easy).
 *   off-topic fires have HIGH scores -> embedding/scoring quality problem (hard).
 *
 * Samples live inject-fires, reconstructs the triple, judges with the locked
 * usefulness judge, and reports the top-hit score distribution split by verdict,
 * plus the off-topic rate per score quartile.
 *
 * Run: npx tsx scripts/eval/offtopic-score.ts [--n=60] [--days=60]
 */
import { judgeUsefulness, USEFULNESS_MODEL, type Verdict } from "./lib/usefulness-judge.js";
import { readInjectFires, responseFor, evenStride, openSessionContext } from "./lib/transcript.js";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const N = Number.parseInt(get("n") ?? "60", 10);
const DAYS = Number.parseInt(get("days") ?? "60", 10);
const URL = get("url") ?? "http://localhost:11434";

const fires = readInjectFires(DAYS).filter((f) => Number.isFinite(f.topScore));
const ctx = openSessionContext();

type Row = { score: number; verdict: Verdict };
const rows: Row[] = [];
for (const f of evenStride(fires, N * 3)) {
  if (rows.length >= N) break;
  const response = responseFor(f.cid, f.prompt); if (!response) continue;
  const context = ctx.get(f.injId); if (!context) continue;
  const verdict = await judgeUsefulness(URL, USEFULNESS_MODEL, { prompt: f.prompt, context, response });
  rows.push({ score: f.topScore, verdict });
}
ctx.close();

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const median = (xs: number[]) => { if (!xs.length) return Number.NaN; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const off = rows.filter((r) => r.verdict === "unused");
const informed = rows.filter((r) => r.verdict !== "unused");

console.log(`offtopic-score — n=${rows.length} judged fires (window ${DAYS}d), top-hit score by verdict`);
console.log(`  OFF-TOPIC (unused)  n=${off.length}  score mean=${mean(off.map((r) => r.score)).toFixed(2)} median=${median(off.map((r) => r.score)).toFixed(2)}`);
console.log(`  INFORMED (used/part) n=${informed.length}  score mean=${mean(informed.map((r) => r.score)).toFixed(2)} median=${median(informed.map((r) => r.score)).toFixed(2)}`);

// Off-topic rate per score quartile — if a threshold helps, the lowest quartile is far more off-topic.
const sorted = [...rows].sort((a, b) => a.score - b.score);
const q = Math.max(1, Math.floor(sorted.length / 4));
console.log("  off-topic rate by score quartile (low->high score):");
for (let i = 0; i < 4; i++) {
  const slice = sorted.slice(i * q, i === 3 ? sorted.length : (i + 1) * q);
  if (!slice.length) continue;
  const offRate = slice.filter((r) => r.verdict === "unused").length / slice.length;
  console.log(`    Q${i + 1} score ${slice[0]!.score.toFixed(1)}-${slice[slice.length - 1]!.score.toFixed(1)}  off-topic ${(offRate * 100).toFixed(0)}%  (n=${slice.length})`);
}
