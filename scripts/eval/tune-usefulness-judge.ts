/**
 * Tune a small LOCAL usefulness judge against the frontier-labeled gold set.
 *
 * The recall/telemetry layers need a small, portable, *reliable* usefulness
 * judge. The naive config over-counts topical adjacency; the strict evidence
 * config under-counts. This harness scores a candidate (model + prompt style +
 * params) against the gold labels so we can iterate to a config that matches
 * the frontier within tolerance — the #309 classifier-tuning method, applied to
 * the judge.
 *
 * Gold lives OUTSIDE the repo (~/.nlm/eval/gold-usefulness.jsonl) because it
 * holds real prompts/responses. This harness is generic.
 *
 * Run: npx tsx scripts/eval/tune-usefulness-judge.ts [--model=qwen3.5:4b]
 *        [--style=naive|grounded|reason] [--url=http://localhost:11434]
 *        [--gold=~/.nlm/eval/gold-usefulness.jsonl]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USEFULNESS_DEFS as DEFS, USEFULNESS_SYSTEM, USEFULNESS_MODEL } from "./lib/usefulness-judge.js";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const MODEL = get("model") ?? USEFULNESS_MODEL;
const STYLE = (get("style") ?? "naive") as "naive" | "grounded" | "reason";
const URL = get("url") ?? "http://localhost:11434";
const GOLD = (get("gold") ?? join(homedir(), ".nlm", "eval", "gold-usefulness.jsonl")).replace(/^~/, homedir());
const numOpt = (k: string) => { const v = get(k); return v === undefined ? undefined : Number.parseFloat(v); };
// Sampling overrides. Default to a clean deterministic classifier (greedy, no penalties) rather
// than inheriting the model's chat-tuned Modelfile defaults (presence_penalty 1.5, top_p 0.95).
const OPTS: Record<string, number> = { temperature: numOpt("temp") ?? 0, top_p: numOpt("top_p") ?? 1, top_k: numOpt("top_k") ?? 0, presence_penalty: numOpt("pp") ?? 0, frequency_penalty: numOpt("fp") ?? 0 };

type V = "used" | "partial" | "unused";
interface Gold { key: string; band: string; prompt: string; context: string; response: string; gold: V }

const STYLES = {
  naive: {
    format: { type: "object", properties: { verdict: { type: "string", enum: ["used", "partial", "unused"] } }, required: ["verdict"] },
    system: USEFULNESS_SYSTEM,
  },
  grounded: {
    format: { type: "object", properties: { evidence: { type: "string" }, verdict: { type: "string", enum: ["used", "partial", "unused"] } }, required: ["evidence", "verdict"] },
    system: `Decide if the RESPONSE used the INJECTED context. FIRST set evidence: a specific detail in BOTH injected context and response, not in the prompt, not generic; "" if none. THEN verdict. ${DEFS}`,
  },
  reason: {
    format: { type: "object", properties: { reasoning: { type: "string" }, verdict: { type: "string", enum: ["used", "partial", "unused"] } }, required: ["reasoning", "verdict"] },
    system: `Judge whether the RESPONSE used information from the INJECTED context. FIRST write one sentence of reasoning comparing what the response actually says against the injected context (look for a specific borrowed detail vs mere topical overlap). THEN give the verdict. ${DEFS}`,
  },
} as const;

function parseV(s: string): V { const t = s.toLowerCase(); if (t.includes("unused")) return "unused"; if (t.includes("partial")) return "partial"; if (t.includes("used")) return "used"; return "unused"; }

async function judge(g: Gold): Promise<V> {
  const cfg = STYLES[STYLE];
  const messages = [
    { role: "system", content: cfg.system },
    { role: "user", content: `USER PROMPT:\n${g.prompt}\n\nINJECTED CONTEXT:\n${g.context}\n\nASSISTANT RESPONSE:\n${g.response}` },
  ];
  try {
    const r = await fetch(`${URL}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, stream: false, think: false, format: cfg.format, options: OPTS, messages }) });
    const d = (await r.json()) as { message?: { content?: string } };
    return parseV((JSON.parse(d.message?.content ?? "{}") as { verdict?: string }).verdict ?? "unused");
  } catch { return "unused"; }
}

const gold: Gold[] = readFileSync(GOLD, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Gold);
const num = { used: 1, partial: 0.5, unused: 0 } as const;
const bin = (v: V) => (v === "unused" ? "off" : "on"); // coarse: useful-ish vs off-topic

const CONC = Number.parseInt(get("conc") ?? "8", 10);
const verdicts: V[] = new Array(gold.length);
for (let i = 0; i < gold.length; i += CONC) {
  const batch = gold.slice(i, i + CONC);
  const res = await Promise.all(batch.map((g) => judge(g)));
  res.forEach((v, j) => { verdicts[i + j] = v; });
}

let exact = 0, binAgree = 0, candSum = 0, goldSum = 0;
const conf: Record<string, number> = {};
for (let i = 0; i < gold.length; i++) {
  const g = gold[i]!, v = verdicts[i]!;
  if (v === g.gold) exact++;
  if (bin(v) === bin(g.gold)) binAgree++;
  candSum += num[v]; goldSum += num[g.gold];
  conf[`${g.gold}->${v}`] = (conf[`${g.gold}->${v}`] ?? 0) + 1;
}
const n = gold.length;
console.log(`tune-usefulness-judge — ${MODEL} / style=${STYLE} / opts=${JSON.stringify(OPTS)} vs frontier gold (n=${n})`);
console.log(`  exact verdict agreement:  ${((exact / n) * 100).toFixed(0)}%`);
console.log(`  binary (useful vs off):   ${((binAgree / n) * 100).toFixed(0)}%`);
console.log(`  candidate usefulness:     ${((candSum / n) * 100).toFixed(1)}%   (gold: ${((goldSum / n) * 100).toFixed(1)}%)`);
console.log(`  confusion (gold->cand):`, conf);
