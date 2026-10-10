/**
 * H2 at scale: how much stored extraction would a Clef importance gate have cost.
 *
 * For a seeded random sample of closed sessions, ask Clef for the importance score,
 * then compare it with what the production classifier actually stored for that
 * session: decision markers and live facts. A session that stored nothing is one the
 * classifier call produced nothing from, so skipping it loses nothing. A skipped
 * session that did store something is the cost of the gate.
 *
 * The stored yield is a proxy label. It reflects whichever classifier model ran at
 * the time, not ground truth, so it complements the audited labels and does not
 * replace them.
 *
 * Never reads the live database in place: copies it (and its WAL) to a temp dir first.
 * Output stays outside the repo: $NLM_EVAL_DATA_DIR/yield (default ~/.nlm/eval/yield).
 *
 * Run: npx tsx scripts/eval/clef-yield.ts [--n=800] [--seed=20261010] [--threshold=1.5]
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { askClef } from "./lib/clef-client.js";
import { capState, triageQuestions } from "./lib/clef-panels.js";
import { printYieldReport, type YieldRow } from "./lib/clef-yield-report.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number.parseInt(arg("n", "800"), 10);
const SEED = arg("seed", "20261010");
const THRESHOLD = Number.parseFloat(arg("threshold", "1.5"));
const dataDir = join((process.env["NLM_EVAL_DATA_DIR"] ?? join(homedir(), ".nlm", "eval")).replace(/^~/, homedir()), "yield");
mkdirSync(dataDir, { recursive: true });
const env = Object.fromEntries(readFileSync(join(homedir(), ".nlm", ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]! };

const resultPath = join(dataDir, `clef-yield-${SEED}.json`);
const done: YieldRow[] = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, "utf8")) as YieldRow[]) : [];
const doneIds = new Set(done.map((r) => r.id));

const src = join(homedir(), ".nlm", "canonical.sqlite");
const tmp = mkdtempSync(join(tmpdir(), "clef-yield-"));
for (const ext of ["", "-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, join(tmp, `c.sqlite${ext}`));
const db = new Database(join(tmp, "c.sqlite"), { readonly: true });

const ids = (db.prepare("select id from sessions where status = 'closed'").all() as { id: string }[]).map((r) => r.id)
  .map((id) => ({ id, h: createHash("sha256").update(`${SEED}:${id}`).digest("hex") }))
  .sort((a, b) => (a.h < b.h ? -1 : 1)).slice(0, N).map((x) => x.id);

const getSession = db.prepare("select runtime, body from sessions where id = ?");
const countMarkers = db.prepare("select kind, count(*) as n from markers where session_id = ? group by kind");
const countFacts = db.prepare("select count(*) as n from facts where source_session_id = ? and retired_at is null");

for (const id of ids) {
  if (doneIds.has(id)) continue;
  const s = getSession.get(id) as { runtime: string; body: string };
  const m = Object.fromEntries((countMarkers.all(id) as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  const facts = (countFacts.get(id) as { n: number }).n;
  let score: number | null = null;
  let ms = 0;
  try {
    const r = await askClef({ session: capState(s.body) }, triageQuestions(), opts);
    const a = r.answers["importance"];
    score = a?.type === "score" ? a.score : null;
    ms = r.ms;
  } catch { /* leave score null: counted as kept, never as skipped */ }
  done.push({ id, runtime: s.runtime, chars: s.body.length, score, ms, decisions: m["decision"] ?? 0, facts, opens: m["open"] ?? 0 });
  if (done.length % 20 === 0) writeFileSync(resultPath, JSON.stringify(done));
}
writeFileSync(resultPath, JSON.stringify(done));
db.close();
rmSync(tmp, { recursive: true, force: true });

printYieldReport(done, THRESHOLD);
