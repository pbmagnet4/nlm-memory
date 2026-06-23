/**
 * Diagnostic: do "magnet" sessions (recalled into many distinct prompts) get
 * injected OFF-TOPIC more than ordinary sessions? Tests the lever behind a
 * per-session recall-frequency penalty.
 *
 * Result (2026-06-23): REFUTED. magnet off-topic ~84% vs normal ~80% — no
 * meaningful difference. A frequency cap would only shuffle which off-topic
 * session is injected. Kept as a re-runnable check.
 *
 * Run: npx tsx scripts/eval/magnet-usefulness.ts [--threshold=10] [--n=25] [--days=60]
 */
import { topicalWordCount } from "../../src/hook/recent-context.js";
import { judgeUsefulness, USEFULNESS_MODEL, type Verdict } from "./lib/usefulness-judge.js";
import { readInjectFires, responseFor, evenStride, openSessionContext, type Fire } from "./lib/transcript.js";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const THRESH = Number.parseInt(get("threshold") ?? "10", 10);
const N = Number.parseInt(get("n") ?? "25", 10);
const DAYS = Number.parseInt(get("days") ?? "60", 10);
const URL = get("url") ?? "http://localhost:11434";

// Global injection frequency (all-time, no dedup) classifies a session as a magnet;
// the windowed deduped pool is what we sample.
const freq = new Map<string, number>();
for (const f of readInjectFires(undefined, false)) freq.set(f.injId, (freq.get(f.injId) ?? 0) + 1);

const magnet: Fire[] = [], normal: Fire[] = [];
for (const f of readInjectFires(DAYS)) ((freq.get(f.injId) ?? 0) > THRESH ? magnet : normal).push(f);

const ctx = openSessionContext();
async function scoreGroup(pool: Fire[], name: string): Promise<void> {
  const counts: Record<Verdict, number> = { used: 0, partial: 0, unused: 0 };
  let scored = 0, thin = 0;
  for (const f of evenStride(pool, N * 3)) {
    if (scored >= N) break;
    const response = responseFor(f.cid, f.prompt); if (!response) continue;
    const context = ctx.get(f.injId); if (!context) continue;
    counts[await judgeUsefulness(URL, USEFULNESS_MODEL, { prompt: f.prompt, context, response })] += 1;
    scored += 1;
    if (topicalWordCount(f.prompt) < 3) thin += 1;
  }
  const off = scored ? counts.unused / scored : 0;
  const useful = scored ? (counts.used + 0.5 * counts.partial) / scored : 0;
  console.log(`  ${name.padEnd(11)} n=${scored} (thin ${thin}) | off-topic ${(off * 100).toFixed(1)}% | usefulness ${(useful * 100).toFixed(1)}% | u/p/n ${counts.used}/${counts.partial}/${counts.unused}`);
}

console.log(`magnet-usefulness — threshold>${THRESH}x | pools: magnet=${magnet.length} normal=${normal.length} (window ${DAYS}d)`);
await scoreGroup(magnet, "MAGNET");
await scoreGroup(normal, "NORMAL");
ctx.close();
