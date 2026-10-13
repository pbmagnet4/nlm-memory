/**
 * Collect gate-panel answers for tuning the Clef ingest gate (T644).
 *
 * Three sets, each session scored once with gateQuestions():
 *   yield    the seeded 799-session sample from clef-yield.ts
 *   live     sessions from the shadow log (~/.nlm/clef-shadow.jsonl)
 *   audited  the 120 hand-labelled sessions from the T533 triage gold
 * Each row carries what the classifier stored (decision markers, live facts) as the
 * label source. Reads a copy of the database, never the live file.
 * Output: $NLM_EVAL_DATA_DIR/gate-tune/answers.json (cached; reruns only fill gaps).
 *
 * Run: npx tsx scripts/eval/clef-gate-collect.ts
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { askClef, type ClefAnswer } from "../../src/llm/clef-client.js";
import { capState, gateQuestions } from "../../src/core/classifier/triage-panel.js";

export interface GateRow {
  id: string;
  set: "yield" | "live" | "audited";
  runtime: string;
  chars: number;
  decisions: number;
  facts: number;
  answers: Record<string, ClefAnswer> | null;
  ms: number;
}

const HOME = homedir();
const evalDir = (process.env["NLM_EVAL_DATA_DIR"] ?? join(HOME, ".nlm", "eval")).replace(/^~/, HOME);
const outDir = join(evalDir, "gate-tune");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "answers.json");
const env = Object.fromEntries(readFileSync(join(HOME, ".nlm", ".env"), "utf8").split("\n")
  .filter((l) => l.includes("=")).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim()]));
const opts = { baseUrl: env["NLM_CLASSIFIER_BASE_URL"]!, apiKey: env["NLM_CLASSIFIER_API_KEY"]!, timeoutMs: 60_000 };

const sets: Array<{ set: GateRow["set"]; ids: string[] }> = [
  { set: "yield", ids: (JSON.parse(readFileSync(join(evalDir, "yield", "clef-yield-20261010.json"), "utf8")) as { id: string }[]).map((r) => r.id) },
  { set: "live", ids: [...new Set(readFileSync(join(HOME, ".nlm", "clef-shadow.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id))] },
  { set: "audited", ids: (JSON.parse(readFileSync(join(evalDir, "triage", "gold-bodies.json"), "utf8")) as { id: string }[]).map((r) => r.id) },
];

const src = join(HOME, ".nlm", "canonical.sqlite");
const tmp = mkdtempSync(join(tmpdir(), "gate-collect-"));
for (const ext of ["", "-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, join(tmp, `c.sqlite${ext}`));
const db = new Database(join(tmp, "c.sqlite"), { readonly: true });
const getSession = db.prepare("select runtime, body from sessions where id = ?");
const countDecisions = db.prepare("select count(*) as n from markers where session_id = ? and kind = 'decision'");
const countFacts = db.prepare("select count(*) as n from facts where source_session_id = ? and retired_at is null");

const rows: GateRow[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as GateRow[]) : [];
const have = new Set(rows.filter((r) => r.answers).map((r) => `${r.set}:${r.id}`));
const todo: Array<{ set: GateRow["set"]; id: string; runtime: string; body: string }> = [];
for (const { set, ids } of sets) {
  for (const id of ids) {
    if (have.has(`${set}:${id}`)) continue;
    const s = getSession.get(id) as { runtime: string; body: string | null } | undefined;
    if (!s?.body) continue;
    todo.push({ set, id, runtime: s.runtime, body: s.body });
  }
}
console.log(`to score: ${todo.length} (${sets.map((s) => `${s.set} ${s.ids.length}`).join(", ")})`);

let next = 0;
let sinceSave = 0;
await Promise.all(Array.from({ length: 2 }, async () => {
  while (next < todo.length) {
    const t = todo[next++]!;
    let answers: Record<string, ClefAnswer> | null = null;
    let ms = 0;
    try {
      const r = await askClef({ session: capState(t.body) }, gateQuestions(), opts);
      answers = r.answers;
      ms = r.ms;
    } catch (e) {
      console.log(`${t.set} ${t.id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const row: GateRow = {
      id: t.id, set: t.set, runtime: t.runtime, chars: t.body.length,
      decisions: (countDecisions.get(t.id) as { n: number }).n, facts: (countFacts.get(t.id) as { n: number }).n, answers, ms,
    };
    const i = rows.findIndex((r) => r.id === t.id && r.set === t.set);
    if (i >= 0) rows[i] = row; else rows.push(row);
    if (++sinceSave >= 20) { writeFileSync(outPath, JSON.stringify(rows)); sinceSave = 0; }
  }
}));
writeFileSync(outPath, JSON.stringify(rows));
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`done: ${rows.filter((r) => r.answers).length} answered, ${rows.filter((r) => !r.answers).length} failed`);
