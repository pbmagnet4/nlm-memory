/**
 * Context-recall A/B — the gate for flipping NLM_HOOK_CONTEXT_RECALL on.
 *
 * For each historical THIN-prompt fire (the band context-recall targets), run
 * session recall TWO ways against the current corpus and judge each arm's top
 * hit for usefulness against the agent's actual response:
 *   - bare:      query = the prompt alone (today's behavior)
 *   - augmented: query = recent conversation turns (reconstructed at the fire
 *                point) + the prompt (the flagged behavior)
 *
 * Same corpus, same judge, same response — the only variable is the query, so
 * the delta isolates the augmentation effect. Judge is the artifact-not-self
 * call (default qwen3.5:4b; --model to drive a bigger run through DS4 Flash).
 *
 * Run: npx tsx scripts/eval/context-recall-ab.ts [--limit=16] [--days=45]
 *        [--model=qwen3.5:4b] [--port=3940] [--verbose] [--json=<out>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { topicalWordCount } from "../../src/hook/recent-context.js";

interface Args {
  limit: number;
  days: number;
  model: string;
  ollamaUrl: string;
  port: number;
  verbose: boolean;
  json: string | null;
}
function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const h = argv.find((a) => a.startsWith(`--${k}=`));
    return h ? h.slice(k.length + 3) : undefined;
  };
  return {
    limit: Number.parseInt(get("limit") ?? "16", 10),
    days: Number.parseInt(get("days") ?? "45", 10),
    model: get("model") ?? "qwen3.5:4b",
    ollamaUrl: get("ollama") ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    port: Number.parseInt(get("port") ?? "3940", 10),
    verbose: argv.includes("--verbose"),
    json: get("json") ?? null,
  };
}

const MAX_TURNS = 3;
const PER_TURN_CHARS = 400;

function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const c = (message as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

let TRANSCRIPTS: string[] | null = null;
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
  if (TRANSCRIPTS === null) {
    TRANSCRIPTS = [];
    walk(base, TRANSCRIPTS);
  }
  return TRANSCRIPTS.find((p) => p.endsWith(`${cid}.jsonl`)) ?? TRANSCRIPTS.find((p) => p.includes(cid)) ?? null;
}

/** Reconstruct {context-before-fire, response-after-fire} anchored at the prompt. */
function reconstruct(transcript: string, prompt: string): { context: string; response: string } | null {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  const needle = prompt.trim().slice(0, 25);
  if (!needle) return null;
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!["type"] === "user" && textOf(rows[i]!["message"]).trim().startsWith(needle)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  // context = up to MAX_TURNS message-turns immediately BEFORE the fire
  const ctx: string[] = [];
  for (let i = idx - 1; i >= 0 && ctx.length < MAX_TURNS; i--) {
    const t = rows[i]!["type"];
    if (t !== "user" && t !== "assistant") continue;
    const text = textOf(rows[i]!["message"]).trim();
    if (text) ctx.unshift(text.slice(0, PER_TURN_CHARS));
  }
  // response = assistant text after the fire, until the next user turn
  const resp: string[] = [];
  for (let i = idx + 1; i < rows.length; i++) {
    if (rows[i]!["type"] === "user") break;
    if (rows[i]!["type"] === "assistant") {
      const text = textOf(rows[i]!["message"]).trim();
      if (text) resp.push(text);
    }
  }
  return { context: ctx.join(" ").trim(), response: resp.join(" ").slice(0, 1200) };
}

async function topHit(args: Args, query: string): Promise<string | null> {
  try {
    const url = `http://localhost:${args.port}/api/recall?q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url);
    const data = (await res.json()) as { results?: Array<{ id?: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

type Verdict = "used" | "partial" | "unused";
async function judge(args: Args, prompt: string, context: string, response: string): Promise<Verdict> {
  try {
    const res = await fetch(`${args.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        stream: false,
        think: false,
        format: { type: "object", properties: { verdict: { type: "string", enum: ["used", "partial", "unused"] } }, required: ["verdict"] },
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              "Judge whether the assistant RESPONSE used information from the INJECTED prior-session context. " +
              "used = clearly drew on specific info from it not in the prompt and not generic; partial = on-topic, " +
              "plausibly informed, no specific borrowed detail; unused = off-topic or absent. Judge the response " +
              'against the context only, never the assistant\'s quality. Output {"verdict":"..."}.',
          },
          { role: "user", content: `USER PROMPT:\n${prompt}\n\nINJECTED CONTEXT:\n${context}\n\nASSISTANT RESPONSE:\n${response}` },
        ],
      }),
    });
    const data = (await res.json()) as { message?: { content?: string } };
    return (JSON.parse(data.message?.content ?? "{}") as { verdict?: Verdict }).verdict ?? "unused";
  } catch {
    return "unused";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(join(homedir(), ".nlm", "canonical.sqlite"), { readonly: true });
  const summ = db.prepare<[string], { label: string; summary: string; body: string }>(
    "SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,500),'') AS body FROM sessions WHERE id = ?",
  );
  const ctxOf = (id: string | null): string => {
    if (!id) return "";
    const r = summ.get(id);
    return r ? `${r.label}\n${r.summary}\n${r.body}`.trim() : "";
  };

  // thin-prompt fires
  const cutoff = Date.now() - args.days * 86_400_000;
  const seen = new Set<string>();
  const fires: Array<{ cid: string; prompt: string }> = [];
  for (const line of readFileSync(join(homedir(), ".nlm", "hook-log.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d["mode"] !== "live" || d["gate"] !== "evaluate") continue;
    if (((d["wouldInject"] as string[]) ?? []).length === 0) continue;
    if (Date.parse(String(d["ts"] ?? "")) < cutoff) continue;
    const prompt = String(d["promptPreview"] ?? "");
    if (topicalWordCount(prompt) >= 3) continue; // thin only
    const cid = String(d["conversationId"] ?? "");
    const key = `${cid}:${prompt.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fires.push({ cid, prompt });
  }

  const tally = { bare: { used: 0, partial: 0, unused: 0 }, aug: { used: 0, partial: 0, unused: 0 } };
  let scored = 0;
  let augChanged = 0; // fires where augmentation changed the top hit
  for (const f of fires) {
    if (scored >= args.limit) break;
    const tpath = locate(f.cid);
    if (!tpath) continue;
    const rec = reconstruct(readFileSync(tpath, "utf8"), f.prompt);
    if (!rec || !rec.response) continue;
    if (!rec.context) continue; // no prior turns to augment with — augmentation is a no-op here

    const bareHit = await topHit(args, f.prompt);
    const augHit = await topHit(args, `${rec.context} ${f.prompt}`);
    if (!bareHit && !augHit) continue;
    if (bareHit !== augHit) augChanged += 1;

    const bareV = await judge(args, f.prompt, ctxOf(bareHit), rec.response);
    const augV = await judge(args, f.prompt, ctxOf(augHit), rec.response);
    tally.bare[bareV] += 1;
    tally.aug[augV] += 1;
    scored += 1;
    if (args.verbose) {
      console.error(
        `${JSON.stringify(f.prompt.slice(0, 48))}  bare=${bareV}  aug=${augV}` +
          (bareHit !== augHit ? "  [hit changed]" : ""),
      );
    }
  }
  db.close();

  const score = (t: { used: number; partial: number; unused: number }) =>
    scored > 0 ? (t.used + 0.5 * t.partial) / scored : 0;
  const bareU = score(tally.bare);
  const augU = score(tally.aug);
  const report = {
    sample: scored,
    augChangedTopHit: augChanged,
    bare: { ...tally.bare, usefulness: Number(bareU.toFixed(3)), offTopic: Number((tally.bare.unused / Math.max(1, scored)).toFixed(3)) },
    augmented: { ...tally.aug, usefulness: Number(augU.toFixed(3)), offTopic: Number((tally.aug.unused / Math.max(1, scored)).toFixed(3)) },
    deltaUsefulness: Number((augU - bareU).toFixed(3)),
    model: args.model,
  };
  console.log("context-recall A/B — thin-prompt fires, bare vs augmented query");
  console.log(`  sample: ${scored}  | augmentation changed the top hit in ${augChanged}`);
  console.log(`  BARE       usefulness ${(bareU * 100).toFixed(1)}%  off-topic ${(report.bare.offTopic * 100).toFixed(1)}%  (u/p/x ${tally.bare.used}/${tally.bare.partial}/${tally.bare.unused})`);
  console.log(`  AUGMENTED  usefulness ${(augU * 100).toFixed(1)}%  off-topic ${(report.augmented.offTopic * 100).toFixed(1)}%  (u/p/x ${tally.aug.used}/${tally.aug.partial}/${tally.aug.unused})`);
  console.log(`  DELTA usefulness: ${(report.deltaUsefulness * 100).toFixed(1)} pts  => ${report.deltaUsefulness > 0 ? "AUGMENTED WINS" : report.deltaUsefulness < 0 ? "BARE WINS" : "tie"}`);
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
}

await main();
