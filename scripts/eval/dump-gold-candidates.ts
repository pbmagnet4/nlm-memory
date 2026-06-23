/**
 * Dump a stable, balanced sample of (prompt, injected-context, response) triples
 * for frontier labeling into a usefulness gold set. Writes candidates JSONL +
 * a readable view. The gold set (with labels) lives OUTSIDE the repo
 * (~/.nlm/eval/) because it contains real prompts/responses.
 *
 * Run: npx tsx scripts/eval/dump-gold-candidates.ts [--thin=10] [--specific=10] [--days=60]
 *        [--out=/tmp/gold-candidates.jsonl]
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { topicalWordCount } from "../../src/hook/recent-context.js";
import { readInjectFires, responseFor, evenStride, openSessionContext, type Fire } from "./lib/transcript.js";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const N_THIN = Number.parseInt(get("thin") ?? "10", 10);
const N_SPEC = Number.parseInt(get("specific") ?? "10", 10);
const DAYS = Number.parseInt(get("days") ?? "60", 10);
const OUT = get("out") ?? "/tmp/gold-candidates.jsonl";

const thin: Fire[] = [], spec: Fire[] = [];
for (const f of readInjectFires(DAYS)) (topicalWordCount(f.prompt) < 3 ? thin : spec).push(f);

const ctx = openSessionContext();
const rows: Array<{ key: string; band: string; prompt: string; context: string; response: string }> = [];
for (const [band, pool, n] of [["thin", thin, N_THIN], ["specific", spec, N_SPEC]] as const) {
  for (const f of evenStride(pool, n * 2)) {
    if (rows.filter((r) => r.band === band).length >= n) break;
    const response = responseFor(f.cid, f.prompt); if (!response) continue;
    const context = ctx.get(f.injId); if (!context) continue;
    const key = createHash("sha1").update(f.cid + f.prompt).digest("hex").slice(0, 10);
    rows.push({ key, band, prompt: f.prompt, context, response });
  }
}
ctx.close();
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.error(`wrote ${rows.length} candidates to ${OUT}`);
for (const r of rows) {
  console.log(`\n### ${r.key}  [${r.band}]`);
  console.log(`PROMPT:   ${r.prompt.replace(/\n/g, " ").slice(0, 150)}`);
  console.log(`INJECTED: ${r.context.replace(/\n/g, " ").slice(0, 240)}`);
  console.log(`RESPONSE: ${r.response.replace(/\n/g, " ").slice(0, 380)}`);
}
