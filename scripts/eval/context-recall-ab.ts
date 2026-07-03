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
 * Recall runs IN-PROCESS through the production keyword pipeline
 * (extractRecallQuery -> RecallService mode=keyword), the exact path the flag
 * changes. No daemon required; point --db at a VACUUM INTO snapshot of
 * canonical.sqlite to keep the live DB untouched while other jobs write to it.
 *
 * Run: npx tsx scripts/eval/context-recall-ab.ts [--limit=16] [--days=45]
 *        [--model=qwen3.5:4b] [--db=<sqlite path>] [--verbose] [--json=<out>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { topicalWordCount } from "../../src/hook/recent-context.js";
import { extractRecallQuery } from "../../src/core/hook/query-extract.js";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { LLMClient } from "../../src/ports/llm-client.js";
import { judgeUsefulness, USEFULNESS_MODEL, type Verdict } from "./lib/usefulness-judge.js";

interface Args {
  limit: number;
  days: number;
  model: string;
  ollamaUrl: string;
  db: string;
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
    model: get("model") ?? USEFULNESS_MODEL,
    ollamaUrl: get("ollama") ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    db: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
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

// A local judge call has no business taking minutes; a hung one previously
// stalled the whole run (observed live). Timed-out fires are skipped, never
// tallied.
const JUDGE_TIMEOUT_MS = 90_000;

// mode=keyword through the real RecallService matches the production hook path
// this flag changes (recall-over-http.ts recalls keyword-only; hybrid is too
// slow for the hot path). Measuring hybrid would grade a code path the flag
// never touches. extractRecallQuery mirrors recallOverHttp's preprocessing.
function makeTopHit(recall: RecallService): (query: string) => Promise<string | null> {
  return async (query: string): Promise<string | null> => {
    const extracted = extractRecallQuery(query);
    if (extracted === null) return null;
    try {
      const res = await recall.search({ query: extracted, mode: "keyword", limit: 5 });
      return res.results[0]?.id ?? null;
    } catch {
      return null;
    }
  };
}

// Keyword-only recall never touches the LLM (rewrite defaults off); satisfy
// the deps contract with a client that fails loud if that ever changes.
const NO_LLM: LLMClient = new Proxy({} as LLMClient, {
  get(_t, prop): never {
    throw new Error(`context-recall-ab: unexpected LLM call ${String(prop)} in keyword mode`);
  },
});

/** Judge with a deadline; null means timed out (skip the fire, do not tally). */
async function judgeWithDeadline(
  args: Args,
  triple: { prompt: string; context: string; response: string },
): Promise<Verdict | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), JUDGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      judgeUsefulness(args.ollamaUrl, args.model, triple).catch((): Verdict => "unused"),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storage = SqliteStorage.create({
    dbPath: args.db,
    migrationsDir: join(import.meta.dirname, "..", "..", "migrations"),
  });
  const topHit = makeTopHit(new RecallService({ store: storage.sessions, llm: NO_LLM }));
  const db = new Database(args.db, { readonly: true });
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

    const bareHit = await topHit(f.prompt);
    const augHit = await topHit(`${rec.context} ${f.prompt}`);
    if (!bareHit && !augHit) continue;
    if (bareHit !== augHit) augChanged += 1;

    const bareV = await judgeWithDeadline(args, { prompt: f.prompt, context: ctxOf(bareHit), response: rec.response });
    const augV = await judgeWithDeadline(args, { prompt: f.prompt, context: ctxOf(augHit), response: rec.response });
    if (bareV === null || augV === null) continue;
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
  await storage.close();

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
