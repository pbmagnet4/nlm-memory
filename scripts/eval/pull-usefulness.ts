/**
 * Pull-usefulness instrument - judges whether agent memory pulls were actually
 * used in the agent response that followed them.
 *
 * Reads both query logs, filters to genuine mcp pulls (applying the pre-registered
 * strip set and deduplicating), joins each pull to the transcript that requested it,
 * extracts the assistant response that followed, resolves the pulled context from the
 * db snapshot, and judges with the locked usefulness judge.
 *
 * Run: npx tsx scripts/eval/pull-usefulness.ts [--days=0] [--limit=60]
 *        [--db=<sqlite path>] [--model=qwen3.5:4b] [--ollama=<url>]
 *        [--verbose] [--json=<out>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { judgeUsefulness, USEFULNESS_MODEL, type Verdict } from "./lib/usefulness-judge.js";
import { PROBE_EXACT_QUERIES } from "../../src/core/telemetry/probe-filter.js";

// Pre-registered strip set (2026-07-03 baseline, locked before results).
// Exact match only -- do NOT switch to isProbe (substring) here. This file was
// baseline-calibrated with exact-match stripping; adding substring matching
// would silently change the genuine-pull denominator and invalidate historical
// comparisons. Re-establish the baseline before expanding the match strategy.
const STRIP_FACT_SUBJECTS = new Set(["nlm-memory-ts", "nle-memory-ts", ""]);

const JUDGE_TIMEOUT_MS = 90_000;
const MIN_QUERY_LEN_FOR_SEARCH = 12;

interface Args {
  days: number;
  limit: number;
  db: string;
  model: string;
  ollamaUrl: string;
  json: string | null;
  verbose: boolean;
  qlog: string;
  flog: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  return {
    days: Number.parseInt(get("days") ?? "0", 10),
    limit: Number.parseInt(get("limit") ?? "60", 10),
    db: get("db") ?? join(homedir(), ".nlm", "canonical.sqlite"),
    model: get("model") ?? USEFULNESS_MODEL,
    ollamaUrl: get("ollama") ?? process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    json: get("json") ?? null,
    verbose: argv.includes("--verbose"),
    qlog: get("qlog") ?? join(homedir(), ".nlm", "query_log.jsonl"),
    flog: get("flog") ?? join(homedir(), ".nlm", "fact_query_log.jsonl"),
  };
}

type ToolLabel = "session" | "fact" | "code" | "workstream";

interface Pull {
  tool: ToolLabel;
  query: string;
  runtime: string | null;
  returnedIds: string[];
  conversationId: string | null;
}

interface Tally {
  used: number;
  partial: number;
  unused: number;
}

function bump(map: Record<string, Tally>, key: string, verdict: Verdict): void {
  const existing = map[key];
  if (existing) {
    existing[verdict] += 1;
  } else {
    const t: Tally = { used: 0, partial: 0, unused: 0 };
    t[verdict] += 1;
    map[key] = t;
  }
}

function readSessionPulls(logPath: string, cutoff: number): { seen: number; pulls: Pull[] } {
  if (!existsSync(logPath)) return { seen: 0, pulls: [] };
  const lines = readFileSync(logPath, "utf8").split("\n");
  const seen = new Set<string>();
  let rawSeen = 0;
  const pulls: Pull[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj["source"] !== "mcp") continue;
    rawSeen += 1;
    const ts = Date.parse(String(obj["ts"] ?? ""));
    if (!Number.isFinite(ts)) continue;
    if (cutoff > 0 && ts < cutoff) continue;
    const query = typeof obj["query"] === "string" ? obj["query"] : "";
    if (PROBE_EXACT_QUERIES.has(query)) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const dedupeKey = `${query}:${day}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const returnedIds = (Array.isArray(obj["returned_ids"]) ? obj["returned_ids"] : [])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 3);
    const kind = typeof obj["kind"] === "string" ? obj["kind"] : null;
    const tool: ToolLabel = kind === "code" ? "code" : kind === "workstream" ? "workstream" : "session";
    pulls.push({
      tool,
      query,
      runtime: typeof obj["runtime"] === "string" ? obj["runtime"] : null,
      returnedIds,
      conversationId: typeof obj["conversation_id"] === "string" ? obj["conversation_id"] : null,
    });
  }
  return { seen: rawSeen, pulls };
}

function readFactPulls(logPath: string, cutoff: number): { seen: number; pulls: Pull[] } {
  if (!existsSync(logPath)) return { seen: 0, pulls: [] };
  const lines = readFileSync(logPath, "utf8").split("\n");
  const seen = new Set<string>();
  let rawSeen = 0;
  const pulls: Pull[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj["source"] !== "mcp") continue;
    rawSeen += 1;
    const ts = Date.parse(String(obj["ts"] ?? ""));
    if (!Number.isFinite(ts)) continue;
    if (cutoff > 0 && ts < cutoff) continue;
    const subject = typeof obj["subject"] === "string" ? obj["subject"] : "";
    const query = typeof obj["query"] === "string" ? obj["query"] : "";
    const stripKey = subject || query;
    if (STRIP_FACT_SUBJECTS.has(stripKey)) continue;
    const effectiveQuery = query || subject;
    if (!effectiveQuery) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    const dedupeKey = `${effectiveQuery}:${day}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const returnedIds = (Array.isArray(obj["returned_ids"]) ? obj["returned_ids"] : [])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 3);
    pulls.push({
      tool: "fact",
      query: effectiveQuery,
      runtime: typeof obj["runtime"] === "string" ? obj["runtime"] : null,
      returnedIds,
      conversationId: typeof obj["conversation_id"] === "string" ? obj["conversation_id"] : null,
    });
  }
  return { seen: rawSeen, pulls };
}

let TRANSCRIPTS: string[] | null = null;

function walkJsonl(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJsonl(p, out);
    else if (ent.name.endsWith(".jsonl")) out.push(p);
  }
}

function allTranscripts(): string[] {
  if (TRANSCRIPTS !== null) return TRANSCRIPTS;
  const base = join(homedir(), ".claude", "projects");
  TRANSCRIPTS = [];
  if (existsSync(base)) walkJsonl(base, TRANSCRIPTS);
  return TRANSCRIPTS;
}

function locateByConversationId(cid: string): string | null {
  const paths = allTranscripts();
  return paths.find((p) => p.endsWith(`${cid}.jsonl`)) ?? paths.find((p) => p.includes(cid)) ?? null;
}

function parseRows(content: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function contentBlocks(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const msg = (row["message"] as Record<string, unknown> | undefined) ?? {};
  const c = msg["content"];
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : [];
}

function isNlmRecallTool(name: string): boolean {
  return (
    name.startsWith("mcp__nlm-memory__recall_") ||
    name === "recall_sessions" ||
    name === "recall_facts" ||
    name === "recall_code" ||
    name === "recall_workstream"
  );
}

function toolLabelFromName(name: string): ToolLabel {
  if (name.includes("fact")) return "fact";
  if (name.includes("code")) return "code";
  if (name.includes("workstream")) return "workstream";
  return "session";
}

function isToolResultRow(row: Record<string, unknown>): boolean {
  if (row["type"] !== "user") return false;
  const blocks = contentBlocks(row);
  return blocks.length > 0 && blocks.every((b) => (b as { type?: string })["type"] === "tool_result");
}

function textBlocksJoined(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .filter((b) => (b as { type?: string })["type"] === "text")
    .map((b) => String((b as { text?: string })["text"] ?? ""))
    .join(" ")
    .trim();
}

interface ToolUseMatch {
  rowIdx: number;
  toolName: string;
}

function findNlmToolUse(rows: Array<Record<string, unknown>>, query: string): ToolUseMatch | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row["type"] !== "assistant") continue;
    for (const b of contentBlocks(row)) {
      const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
      if (blk.type !== "tool_use" || !isNlmRecallTool(blk.name ?? "")) continue;
      const input = blk.input ?? {};
      const q = String(input["query"] ?? input["subject"] ?? "");
      if (q === query) return { rowIdx: i, toolName: blk.name ?? "" };
    }
  }
  return null;
}

function responseAfterToolUse(rows: Array<Record<string, unknown>>, fromIdx: number): string | null {
  const parts: string[] = [];
  for (let i = fromIdx + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row["type"] === "user") {
      if (isToolResultRow(row)) continue;
      break;
    }
    if (row["type"] === "assistant") {
      const text = textBlocksJoined(contentBlocks(row));
      if (text) parts.push(text);
    }
  }
  const joined = parts.join(" ").trim();
  return joined ? joined.slice(0, 1500) : null;
}

interface JoinResult {
  tpath: string;
  rows: Array<Record<string, unknown>>;
  match: ToolUseMatch;
}

function joinByConversationId(cid: string, query: string): JoinResult | null {
  const tpath = locateByConversationId(cid);
  if (!tpath) return null;
  let content: string;
  try {
    content = readFileSync(tpath, "utf8");
  } catch {
    return null;
  }
  const rows = parseRows(content);
  const match = findNlmToolUse(rows, query);
  if (!match) return null;
  return { tpath, rows, match };
}

/**
 * Locate a transcript by searching all transcripts for the query string inside
 * an nlm recall tool_use. Returns null when zero or more than one transcript
 * match (unjoinable), or when the query is shorter than MIN_QUERY_LEN_FOR_SEARCH.
 */
function joinByQuerySearch(query: string): JoinResult | null {
  if (query.length < MIN_QUERY_LEN_FOR_SEARCH) return null;
  let hit: JoinResult | null = null;
  for (const tpath of allTranscripts()) {
    let content: string;
    try {
      content = readFileSync(tpath, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(query)) continue;
    const rows = parseRows(content);
    const match = findNlmToolUse(rows, query);
    if (!match) continue;
    if (hit !== null) return null;
    hit = { tpath, rows, match };
  }
  return hit;
}

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
  const cutoff = args.days > 0 ? Date.now() - args.days * 86_400_000 : 0;

  const sessionBatch = readSessionPulls(args.qlog, cutoff);
  const factBatch = readFactPulls(args.flog, cutoff);
  const pullsSeen = sessionBatch.seen + factBatch.seen;
  const allPulls = [...sessionBatch.pulls, ...factBatch.pulls];
  const genuine = allPulls.length;

  let db: Database.Database | null = null;
  let summStmt: Database.Statement<[string], { label: string; summary: string; body: string }> | null = null;

  function ctxOf(ids: string[]): string {
    if (ids.length === 0) return "";
    if (!db) {
      db = new Database(args.db, { readonly: true });
      summStmt = db.prepare<[string], { label: string; summary: string; body: string }>(
        "SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,500),'') AS body FROM sessions WHERE id = ?",
      );
    }
    const parts: string[] = [];
    for (const id of ids) {
      const r = summStmt!.get(id);
      if (r) parts.push(`${r.label}\n${r.summary}\n${r.body}`.trim());
    }
    return parts.join("\n\n").trim();
  }

  const counts: Tally = { used: 0, partial: 0, unused: 0 };
  const byTool: Record<string, Tally> = {};
  const byRuntime: Record<string, Tally> = {};
  let scored = 0;
  let joined = 0;
  let unjoinable = 0;

  for (const pull of allPulls) {
    if (scored >= args.limit) break;

    const jr = pull.conversationId
      ? joinByConversationId(pull.conversationId, pull.query)
      : joinByQuerySearch(pull.query);

    if (!jr) {
      unjoinable += 1;
      continue;
    }

    const response = responseAfterToolUse(jr.rows, jr.match.rowIdx);
    if (!response) {
      unjoinable += 1;
      continue;
    }

    joined += 1;
    const context = ctxOf(pull.returnedIds);
    const verdict = await judgeWithDeadline(args, { prompt: pull.query, context, response });
    if (verdict === null) continue;

    counts[verdict] += 1;
    scored += 1;

    const toolLabel = toolLabelFromName(jr.match.toolName) || pull.tool;
    bump(byTool, toolLabel, verdict);
    bump(byRuntime, pull.runtime ?? "unknown", verdict);

    if (args.verbose) {
      console.error(
        `[${verdict.toUpperCase().padEnd(7)}] tool=${toolLabel} rt=${pull.runtime ?? "?"} q=${JSON.stringify(pull.query.slice(0, 60))}`,
      );
    }
  }

  if (db) db.close();

  const usefulnessAtPull = scored > 0 ? (counts.used + 0.5 * counts.partial) / scored : 0;
  const offTopicRate = scored > 0 ? counts.unused / scored : 0;
  const attempted = joined + unjoinable;
  const joinRate = attempted > 0 ? joined / attempted : 0;

  function tallyStats(t: Tally): { used: number; partial: number; unused: number; usefulness: number } {
    const n = t.used + t.partial + t.unused;
    return { ...t, usefulness: Number((n > 0 ? (t.used + 0.5 * t.partial) / n : 0).toFixed(3)) };
  }

  const report = {
    pullsSeen,
    genuineAfterStrip: genuine,
    joined,
    unjoinable,
    joinRate: Number(joinRate.toFixed(3)),
    scored,
    used: counts.used,
    partial: counts.partial,
    unused: counts.unused,
    usefulnessAtPull: Number(usefulnessAtPull.toFixed(3)),
    offTopicRate: Number(offTopicRate.toFixed(3)),
    byTool: Object.fromEntries(Object.entries(byTool).map(([k, v]) => [k, tallyStats(v)])),
    byRuntime: Object.fromEntries(Object.entries(byRuntime).map(([k, v]) => [k, tallyStats(v)])),
    model: args.model,
    days: args.days,
  };

  console.log("pull-usefulness - judges whether agent pulls were actually used");
  console.log(`  pulls seen (mcp source): ${pullsSeen}  |  genuine after strip: ${genuine}`);
  console.log(`  joined: ${joined}  |  unjoinable: ${unjoinable}  |  join rate: ${(joinRate * 100).toFixed(1)}%`);
  console.log(`  scored: ${scored}`);
  console.log(`  used / partial / unused: ${counts.used} / ${counts.partial} / ${counts.unused}`);
  console.log(`  usefulness@pull: ${(usefulnessAtPull * 100).toFixed(1)}%   off-topic: ${(offTopicRate * 100).toFixed(1)}%`);
  if (Object.keys(byTool).length > 0) {
    console.log("  by tool:");
    for (const [k, v] of Object.entries(report.byTool)) {
      console.log(`    ${k}: usefulness ${(v.usefulness * 100).toFixed(1)}%  (u/p/x ${v.used}/${v.partial}/${v.unused})`);
    }
  }
  if (Object.keys(byRuntime).length > 0) {
    console.log("  by runtime:");
    for (const [k, v] of Object.entries(report.byRuntime)) {
      console.log(`    ${k}: usefulness ${(v.usefulness * 100).toFixed(1)}%  (u/p/x ${v.used}/${v.partial}/${v.unused})`);
    }
  }
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
}

await main();
