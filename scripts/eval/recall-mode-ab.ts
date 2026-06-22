/**
 * Recall-mode A/B — keyword vs semantic session recall on SPECIFIC prompts.
 *
 * The specific-prompt band measures 70% off-topic on the keyword hot path. These
 * prompts have real content words (not a query problem), so the suspect is weak
 * keyword matching. Replay historical specific-prompt fires (topical >= 3) two
 * ways against the current corpus — mode=keyword vs mode=semantic — and judge
 * each arm's top hit for usefulness against the agent's actual response.
 *
 * Same corpus, same prompt, same judge — only the recall MODE differs. Mines
 * existing data; no waiting.
 *
 * Run: npx tsx scripts/eval/recall-mode-ab.ts [--limit=20] [--days=45]
 *        [--model=qwen3.5:4b] [--port=3940] [--verbose] [--json=<out>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { topicalWordCount } from "../../src/hook/recent-context.js";

const get = (k: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : undefined;
};
const LIMIT = Number.parseInt(get("limit") ?? "20", 10);
const DAYS = Number.parseInt(get("days") ?? "45", 10);
const MODEL = get("model") ?? "qwen3.5:4b";
const OLLAMA = get("ollama") ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434";
const PORT = Number.parseInt(get("port") ?? "3940", 10);
const VERBOSE = process.argv.includes("--verbose");
const JSON_OUT = get("json") ?? null;

function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const c = (message as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
  return "";
}

let TX: string[] | null = null;
function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}
function locate(cid: string): string | null {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return null;
  if (TX === null) {
    TX = [];
    walk(base, TX);
  }
  return TX.find((p) => p.endsWith(`${cid}.jsonl`)) ?? TX.find((p) => p.includes(cid)) ?? null;
}

function responseAfter(transcript: string, prompt: string): string | null {
  const rows: Array<Record<string, unknown>> = [];
  for (const l of transcript.split("\n")) {
    if (!l.trim()) continue;
    try {
      rows.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  const needle = prompt.trim().slice(0, 25);
  if (!needle) return null;
  let idx = -1;
  for (let i = 0; i < rows.length; i++)
    if (rows[i]!["type"] === "user" && textOf(rows[i]!["message"]).trim().startsWith(needle)) {
      idx = i;
      break;
    }
  if (idx === -1) return null;
  const resp: string[] = [];
  for (let i = idx + 1; i < rows.length; i++) {
    if (rows[i]!["type"] === "user") break;
    if (rows[i]!["type"] === "assistant") {
      const t = textOf(rows[i]!["message"]).trim();
      if (t) resp.push(t);
    }
  }
  return resp.length ? resp.join(" ").slice(0, 1200) : null;
}

async function topHit(query: string, mode: string): Promise<string | null> {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/recall?q=${encodeURIComponent(query)}&limit=1&mode=${mode}`);
    const d = (await r.json()) as { results?: Array<{ id?: string }> };
    return d.results?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

type V = "used" | "partial" | "unused";
async function judge(prompt: string, context: string, response: string): Promise<V> {
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: { type: "object", properties: { verdict: { type: "string", enum: ["used", "partial", "unused"] } }, required: ["verdict"] },
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              "Judge whether the assistant RESPONSE used information from the INJECTED prior-session context. used = clearly drew on specific info not in the prompt and not generic; partial = on-topic, plausibly informed, no specific borrowed detail; unused = off-topic or absent. Judge the response against the context only, never the assistant's quality. Output {\"verdict\":\"...\"}.",
          },
          { role: "user", content: `USER PROMPT:\n${prompt}\n\nINJECTED CONTEXT:\n${context}\n\nASSISTANT RESPONSE:\n${response}` },
        ],
      }),
    });
    const d = (await r.json()) as { message?: { content?: string } };
    return (JSON.parse(d.message?.content ?? "{}") as { verdict?: V }).verdict ?? "unused";
  } catch {
    return "unused";
  }
}

const db = new Database(join(homedir(), ".nlm", "canonical.sqlite"), { readonly: true });
const summ = db.prepare<[string], { label: string; summary: string; body: string }>(
  "SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,500),'') AS body FROM sessions WHERE id = ?",
);
const ctxOf = (id: string | null): string => {
  if (!id) return "";
  const r = summ.get(id);
  return r ? `${r.label}\n${r.summary}\n${r.body}`.trim() : "";
};

const cutoff = Date.now() - DAYS * 86_400_000;
const seen = new Set<string>();
const fires: Array<{ cid: string; prompt: string }> = [];
for (const l of readFileSync(join(homedir(), ".nlm", "hook-log.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(l) as Record<string, unknown>;
  } catch {
    continue;
  }
  if (d["mode"] !== "live" || d["gate"] !== "evaluate") continue;
  if (((d["wouldInject"] as string[]) ?? []).length === 0) continue;
  if (Date.parse(String(d["ts"] ?? "")) < cutoff) continue;
  const prompt = String(d["promptPreview"] ?? "");
  if (topicalWordCount(prompt) < 3) continue; // specific band only
  const cid = String(d["conversationId"] ?? "");
  const key = `${cid}:${prompt.slice(0, 40)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  fires.push({ cid, prompt });
}

const tally = { keyword: { used: 0, partial: 0, unused: 0 }, semantic: { used: 0, partial: 0, unused: 0 } };
let scored = 0;
let changed = 0;
for (const f of fires) {
  if (scored >= LIMIT) break;
  const tp = locate(f.cid);
  if (!tp) continue;
  const response = responseAfter(readFileSync(tp, "utf8"), f.prompt);
  if (!response) continue;
  const kHit = await topHit(f.prompt, "keyword");
  const sHit = await topHit(f.prompt, "semantic");
  if (!kHit && !sHit) continue;
  if (kHit !== sHit) changed += 1;
  const kV = await judge(f.prompt, ctxOf(kHit), response);
  const sV = await judge(f.prompt, ctxOf(sHit), response);
  tally.keyword[kV] += 1;
  tally.semantic[sV] += 1;
  scored += 1;
  if (VERBOSE) console.error(`${JSON.stringify(f.prompt.slice(0, 46))}  kw=${kV}  sem=${sV}${kHit !== sHit ? "  [changed]" : ""}`);
}
db.close();

const score = (t: { used: number; partial: number; unused: number }) => (scored ? (t.used + 0.5 * t.partial) / scored : 0);
const kU = score(tally.keyword);
const sU = score(tally.semantic);
const report = {
  sample: scored,
  modeChangedTopHit: changed,
  keyword: { ...tally.keyword, usefulness: Number(kU.toFixed(3)), offTopic: Number((tally.keyword.unused / Math.max(1, scored)).toFixed(3)) },
  semantic: { ...tally.semantic, usefulness: Number(sU.toFixed(3)), offTopic: Number((tally.semantic.unused / Math.max(1, scored)).toFixed(3)) },
  deltaUsefulness: Number((sU - kU).toFixed(3)),
  model: MODEL,
};
console.log("recall-mode A/B — specific-prompt fires, keyword vs semantic");
console.log(`  sample: ${scored}  | mode changed the top hit in ${changed}`);
console.log(`  KEYWORD   usefulness ${(kU * 100).toFixed(1)}%  off-topic ${(report.keyword.offTopic * 100).toFixed(1)}%  (u/p/x ${tally.keyword.used}/${tally.keyword.partial}/${tally.keyword.unused})`);
console.log(`  SEMANTIC  usefulness ${(sU * 100).toFixed(1)}%  off-topic ${(report.semantic.offTopic * 100).toFixed(1)}%  (u/p/x ${tally.semantic.used}/${tally.semantic.partial}/${tally.semantic.unused})`);
console.log(`  DELTA usefulness: ${(report.deltaUsefulness * 100).toFixed(1)} pts  => ${report.deltaUsefulness > 0 ? "SEMANTIC WINS" : report.deltaUsefulness < 0 ? "KEYWORD WINS" : "tie"}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
