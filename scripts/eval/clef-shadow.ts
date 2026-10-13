/**
 * Shadow mode for the fitted Clef ingest gate (T644). Changes nothing in the pipeline.
 * The daemon writes the same log itself under NLM_INGEST_GATE=shadow; this backfills it.
 *
 * Run mode (default): score every session ingested since the last run with the
 * production gate and append what it WOULD have done to ~/.nlm/clef-shadow.jsonl.
 * A Clef error is logged as "kept" with a null score, never as a skip.
 * Report mode (--report): join the log with what the classifier actually stored for
 * each session (decision markers and live facts, read now) and print the cost of the gate.
 *
 * Reads the live database read-only (safe under WAL). Never writes to it.
 *
 * Scores are P(stored); the default threshold is the fitted GATE_MODEL.threshold.
 * Run:    npx tsx scripts/eval/clef-shadow.ts [--limit=300] [--since="YYYY-MM-DD HH:MM:SS"]
 * Report: npx tsx scripts/eval/clef-shadow.ts --report [--threshold=0.2]
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendShadowLine, makeClefIngestGate } from "../../src/core/classifier/ingest-gate.js";
import { GATE_MODEL } from "../../src/core/classifier/gate-model-params.js";
import { printYieldReport, type YieldRow } from "./lib/clef-yield-report.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const THRESHOLD = Number.parseFloat(arg("threshold") ?? String(GATE_MODEL.threshold));
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
  if (rows.length > 0) printYieldReport(rows, THRESHOLD, [0.1, 0.15, 0.2, 0.25, 0.3, 0.4]);
  process.exit(0);
}

const env = Object.fromEntries(readFileSync(join(nlmDir, ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const judge = makeClefIngestGate({ baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]!, timeoutMs: 30_000 });
const limit = Number.parseInt(arg("limit") ?? "300", 10);
let cursor: string = existsSync(cursorPath)
  ? (JSON.parse(readFileSync(cursorPath, "utf8")) as { createdAt: string }).createdAt
  : (arg("since") ?? (db.prepare("select datetime('now', '-1 day') as t").get() as { t: string }).t);

const pending = db.prepare("select id, runtime, body, created_at from sessions where status = 'closed' and created_at > ? order by created_at limit ?")
  .all(cursor, limit) as { id: string; runtime: string; body: string; created_at: string }[];
for (const s of pending) {
  appendShadowLine(logPath, { id: s.id, runtime: s.runtime, chars: s.body.length, threshold: GATE_MODEL.threshold, ...(await judge(s.body)) });
  cursor = s.created_at;
  writeFileSync(cursorPath, JSON.stringify({ createdAt: cursor }));
}
console.log(`shadow run: scored ${pending.length} sessions since ${arg("since") ?? "last cursor"}; cursor now ${cursor}`);
