/**
 * T1778 E1 step 1 — extract the session bodies behind the cached 27B gate panel.
 *
 * Reads the cached answers from ~/.nlm/eval/gate-tune/answers.json (the 27B panel
 * collected by scripts/eval/clef-gate-collect.ts) and pulls the matching session
 * bodies out of a read-only snapshot copy of the live database, so the flash
 * re-run asks the exact same 1,221 sessions with the exact same capState the
 * daemon applies. Writes ./.eval/gate/bodies.jsonl. Neither ~/.nlm nor /tmp is
 * written: the snapshot copy lives in the git-ignored ./.eval/db.sqlite inside
 * this worktree and is deleted at the end.
 *
 * Run: npx tsx scripts/eval/t1778-e1-extract.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { capState } from "../../src/core/classifier/triage-panel.js";
import { loadAvg } from "./lib/t1778-clef.js";

const HOME = homedir();
const evalDir = join(HOME, ".nlm", "eval");
const outDir = join(import.meta.dirname, "../../.eval/gate");
mkdirSync(outDir, { recursive: true });

interface PanelRow { id: string; set: string }
const rows = JSON.parse(readFileSync(join(evalDir, "gate-tune", "answers.json"), "utf8")) as PanelRow[];
const want = new Map(rows.map((r) => [r.id, r.set]));
console.log(`panel rows ${rows.length}, distinct sessions ${want.size}, load ${loadAvg()}`);

const src = join(HOME, ".nlm", "canonical.sqlite");
const evalRoot = join(import.meta.dirname, "../../.eval");
mkdirSync(evalRoot, { recursive: true });
const snap = join(evalRoot, "db.sqlite");
for (const ext of ["", "-wal", "shm"]) if (existsSync(snap + (ext ? `-${ext}` : ""))) rmSync(snap + (ext ? `-${ext}` : ""), { force: true });
for (const ext of ["", "-wal", "-shm"]) {
  if (existsSync(src + ext)) copyFileSync(src + ext, snap + ext);
}
const db = new Database(snap, { readonly: true });
const get = db.prepare("select runtime, body from sessions where id = ?");

const lines: string[] = [];
let missing = 0;
for (const [id, set] of want) {
  const s = get.get(id) as { runtime: string; body: string | null } | undefined;
  if (!s?.body) { missing++; continue; }
  lines.push(JSON.stringify({ id, set, runtime: s.runtime, chars: s.body.length, state: capState(s.body) }));
}
db.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(snap + ext, { force: true });
writeFileSync(join(outDir, "bodies.jsonl"), `${lines.join("\n")}\n`);
console.log(`wrote ${lines.length} bodies (${missing} missing) to ${join(outDir, "bodies.jsonl")}`);
