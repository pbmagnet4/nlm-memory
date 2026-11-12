/**
 * Extract the gate-tune session states for the T1778 flash re-run (one-off prep).
 *
 * Reads the live canonical database read-only and writes only what the panel sees —
 * the body after capState(), i.e. head + tail of long transcripts — so the flash
 * answers are directly comparable with the cached 27B answers without copying a
 * 1.8 GB database into the worktree. The audited set ships with full bodies in the
 * triage gold, so those sessions never touch the database.
 *
 * Run: npx tsx scripts/eval/t1778-dump-bodies.ts
 * Out: .eval/gate-bodies.json  (id -> { session: capped state, chars: raw length })
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { capState } from "../../src/core/classifier/triage-panel.js";

const EVAL = join(import.meta.dirname, "../../.eval");
const HOME = process.env["HOME"]!;

const gateRows = JSON.parse(readFileSync(join(EVAL, "gate-answers-27b.json"), "utf8")) as { id: string }[];
const ids = new Set(gateRows.map((r) => r.id));

const bodies = new Map<string, string>();
for (const r of JSON.parse(readFileSync(join(EVAL, "gold-bodies.json"), "utf8")) as { id: string; body: string }[]) bodies.set(r.id, r.body);
const missing = [...ids].filter((id) => !bodies.has(id));
console.log(`gate ids ${ids.size}; from triage gold ${ids.size - missing.length}; to read from db ${missing.length}`);

const db = new Database(join(HOME, ".nlm", "canonical.sqlite"), { readonly: true });
const whole = db.prepare("select body from sessions where id = ?");
let absent = 0;
for (const id of missing) {
  const r = whole.get(id) as { body: string | null } | undefined;
  if (!r?.body) absent++;
  else bodies.set(id, r.body);
}
db.close();

// The gate model's log_chars feature uses the raw session length, not the capped state.
const states: Record<string, { session: string; chars: number }> = {};
for (const id of ids) {
  const b = bodies.get(id);
  if (b) states[id] = { session: capState(b), chars: b.length };
}
mkdirSync(EVAL, { recursive: true });
writeFileSync(join(EVAL, "gate-bodies.json"), JSON.stringify(states));
const lens = Object.values(states).map((v) => v.session.length).sort((a, b) => a - b);
const mb = (JSON.stringify(states).length / 1e6).toFixed(1);
console.log(`db: ${absent} sessions absent; wrote ${lens.length} capped states (${mb} MB, p50 ${lens[Math.floor(lens.length / 2)]} chars, max ${lens[lens.length - 1]})`);
