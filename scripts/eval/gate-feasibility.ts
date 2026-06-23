/**
 * Feasibility mine for the pre-injection relevance GATE (recall-precision option A).
 *
 * The shipped usefulness judge sees the agent's RESPONSE and detects whether the
 * context was USED. A hot-path gate has no response yet — it must predict, from
 * (prompt, candidate context) ALONE, whether injecting would help. This is a
 * harder task. Before designing the gate we test whether a small local model can
 * do it at all, scored against the same frontier gold set.
 *
 * Gate target: SKIP the off-topic (gold=unused) without dropping the informed
 * (gold=used/partial). The asymmetry matters — dropping a useful injection
 * forfeits memory's signature value, so recall-on-informed is the hard floor.
 *
 * Run: npx tsx scripts/eval/gate-feasibility.ts [--model=qwen3.5:4b] [--conc=8]
 *        [--gold=~/.nlm/eval/gold-usefulness.jsonl]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const MODEL = get("model") ?? "qwen3.5:4b";
const URL = get("url") ?? "http://localhost:11434";
const CONC = Number.parseInt(get("conc") ?? "8", 10);
const GOLD = (get("gold") ?? join(homedir(), ".nlm", "eval", "gold-usefulness.jsonl")).replace(/^~/, homedir());

type V = "used" | "partial" | "unused";
interface Gold { prompt: string; context: string; response: string; gold: V }

const MODE = (get("mode") ?? "balanced") as "balanced" | "conservative";
const SYSTEM = MODE === "conservative"
  ? "You are a recall GATE protecting against off-topic memory injection. Given a USER PROMPT and a CANDIDATE prior-session context, answer irrelevant ONLY when the candidate is CLEARLY about a completely different topic, project, or task than the prompt (e.g. the prompt is about debugging a website and the candidate is about a trading pipeline). If there is ANY plausible topical connection, or you are at all unsure, answer relevant. Dropping a useful memory is worse than keeping a marginal one. You do NOT see the assistant's answer. " +
    'Output {"gate":"relevant"|"irrelevant"}.'
  : "You are a recall GATE. Given a USER PROMPT and a CANDIDATE prior-session context, decide whether injecting the candidate would likely HELP the assistant answer this prompt. " +
    "relevant = the candidate is about the same topic/task/project as the prompt and plausibly carries information the assistant would use. " +
    "irrelevant = the candidate is about a different topic/task, or shares only a word with the prompt. " +
    "You do NOT see the assistant's answer — judge only from the prompt and candidate. When genuinely unsure, answer relevant. " +
    'Output {"gate":"relevant"|"irrelevant"}.';

const FORMAT = { type: "object", properties: { gate: { type: "string", enum: ["relevant", "irrelevant"] } }, required: ["gate"] };
const OPTS = { temperature: 0, top_p: 1, top_k: 0, presence_penalty: 0, frequency_penalty: 0 };

async function gate(g: Gold): Promise<"relevant" | "irrelevant"> {
  try {
    const r = await fetch(`${URL}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      model: MODEL, stream: false, think: false, format: FORMAT, options: OPTS,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `USER PROMPT:\n${g.prompt}\n\nCANDIDATE CONTEXT:\n${g.context}` }],
    }) });
    const d = (await r.json()) as { message?: { content?: string } };
    const v = (JSON.parse(d.message?.content ?? "{}") as { gate?: string }).gate ?? "relevant";
    return v === "irrelevant" ? "irrelevant" : "relevant";
  } catch { return "relevant"; }
}

const gold: Gold[] = readFileSync(GOLD, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Gold);
const verdicts: Array<"relevant" | "irrelevant"> = new Array(gold.length);
for (let i = 0; i < gold.length; i += CONC) {
  const batch = gold.slice(i, i + CONC);
  const res = await Promise.all(batch.map((g) => gate(g)));
  res.forEach((v, j) => { verdicts[i + j] = v; });
}

// informed = gold used|partial (should KEEP); offtopic = gold unused (should SKIP).
let infKept = 0, infTotal = 0, offSkipped = 0, offTotal = 0;
for (let i = 0; i < gold.length; i++) {
  const informed = gold[i]!.gold !== "unused";
  const kept = verdicts[i] === "relevant";
  if (informed) { infTotal++; if (kept) infKept++; } else { offTotal++; if (!kept) offSkipped++; }
}
const keptOff = offTotal - offSkipped;
const totalInjected = infKept + keptOff;
console.log(`gate-feasibility — ${MODEL} / mode=${MODE} on frontier gold (n=${gold.length}: informed=${infTotal} offtopic=${offTotal})`);
console.log(`  recall on INFORMED (kept):     ${infTotal ? ((infKept / infTotal) * 100).toFixed(0) : 0}%   (dropped ${infTotal - infKept} useful)  <- hard floor, want >=90%`);
console.log(`  OFF-TOPIC skipped:             ${offTotal ? ((offSkipped / offTotal) * 100).toFixed(0) : 0}%   (the precision win)`);
console.log(`  injected-set precision after gate: ${totalInjected ? ((infKept / totalInjected) * 100).toFixed(0) : 0}%   (was ${((infTotal / gold.length) * 100).toFixed(0)}% pre-gate)`);
console.log(`  volume injected: ${totalInjected}/${gold.length} = ${((totalInjected / gold.length) * 100).toFixed(0)}% of fires kept`);
