/**
 * Shadow mode for the H2 importance gate. Changes nothing in the pipeline.
 *
 * Run mode (default): score every session ingested since the last run with Clef and
 * append what the gate WOULD have done to ~/.nlm/clef-shadow.jsonl. A Clef error is
 * logged as "kept" with a null score, never as a skip.
 * Report mode (--report): join the log with what the classifier actually stored for
 * each session (decision markers and live facts, read now) and print the cost of the gate.
 *
 * Reads the live database read-only (safe under WAL). Never writes to it.
 *
 * Run:    npx tsx scripts/eval/clef-shadow.ts [--limit=300] [--threshold=1.5] [--since="YYYY-MM-DD HH:MM:SS"]
 * Report: npx tsx scripts/eval/clef-shadow.ts --report [--threshold=1.5]
 */
import Database from "better-sqlite3";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askClef } from "./lib/clef-client.js";
import { capState, triageQuestions } from "./lib/clef-panels.js";
import { printYieldReport, type YieldRow } from "./lib/clef-yield-report.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const THRESHOLD = Number.parseFloat(arg("threshold") ?? "1.5");
const nlmDir = join(homedir(), ".nlm");
const logPath = join(nlmDir, "clef-shadow.jsonl");
const cursorPath = join(nlmDir, "clef-shadow-cursor.json");
const db = new Database(join(nlmDir, "canonical.sqlite"), { readonly: true, fileMustExist: true });

interface LogLine { ts: string; id: string; runtime: string; chars: number; score: number | null; kind: string | null; wouldSkip: boolean; threshold: number; ms: number; error?: string }

const countMarkers = db.prepare("select kind, count(*) as n from markers where session_id = ? group by kind");
const countFacts = db.prepare("select count(*) as n from facts where source_session_id = ? and retired_at is null");
const stored = (id: string) => {
  const m = Object.fromEntries((countMarkers.all(id) as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  return { decisions: m["decision"] ?? 0, facts: (countFacts.get(id) as { n: number }).n, opens: m["open"] ?? 0 };
};

if (process.argv.includes("--report")) {
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine) : [];
  const rows: YieldRow[] = lines.map((l) => ({ id: l.id, runtime: l.runtime, chars: l.chars, score: l.score, ms: l.ms, ...stored(l.id) }));
  console.log(`shadow log: ${lines.length} sessions, ${lines.filter((l) => l.error).length} Clef errors`);
  if (rows.length > 0) printYieldReport(rows, THRESHOLD);
  process.exit(0);
}

const env = Object.fromEntries(readFileSync(join(nlmDir, ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]!, timeoutMs: 30_000 };
const limit = Number.parseInt(arg("limit") ?? "300", 10);
let cursor: string = existsSync(cursorPath)
  ? (JSON.parse(readFileSync(cursorPath, "utf8")) as { createdAt: string }).createdAt
  : (arg("since") ?? (db.prepare("select datetime('now', '-1 day') as t").get() as { t: string }).t);

const pending = db.prepare("select id, runtime, body, created_at from sessions where status = 'closed' and created_at > ? order by created_at limit ?")
  .all(cursor, limit) as { id: string; runtime: string; body: string; created_at: string }[];
for (const s of pending) {
  let line: LogLine;
  try {
    const { answers, ms } = await askClef({ session: capState(s.body) }, triageQuestions(), opts);
    const imp = answers["importance"];
    const kind = answers["kind"];
    const score = imp?.type === "score" ? imp.score : null;
    line = { ts: new Date().toISOString(), id: s.id, runtime: s.runtime, chars: s.body.length, score, kind: kind?.type === "choice" ? kind.choice : null, wouldSkip: score !== null && score < THRESHOLD, threshold: THRESHOLD, ms };
  } catch (e) {
    line = { ts: new Date().toISOString(), id: s.id, runtime: s.runtime, chars: s.body.length, score: null, kind: null, wouldSkip: false, threshold: THRESHOLD, ms: 0, error: String(e).slice(0, 120) };
  }
  appendFileSync(logPath, JSON.stringify(line) + "\n");
  cursor = s.created_at;
  writeFileSync(cursorPath, JSON.stringify({ createdAt: cursor }));
}
console.log(`shadow run: scored ${pending.length} sessions since ${arg("since") ?? "last cursor"}; cursor now ${cursor}`);
