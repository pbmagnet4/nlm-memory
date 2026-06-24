/**
 * Dump stratified session candidates for hand-labeling the matcher gold set.
 *
 * Reads sessions from ~/.nlm/canonical.sqlite, samples ~50 stratified across
 * distinct project labels (for coverage, NOT used as gold labels — spec §13
 * mandates grading against transcripts, not the alias map), and emits JSONL
 * with goldWorkstream="" for the operator to fill in manually.
 *
 * Output: ~/.nlm/eval/gold-matcher.candidates.jsonl
 *   Each line: { key, sessionId, label, summary, goldWorkstream: "" }
 *
 * After editing the file, rename to gold-matcher.jsonl and run tune-matcher.ts.
 *
 * Run: npx tsx scripts/eval/dump-matcher-candidates.ts
 *      [--count=50]
 *      [--out=~/.nlm/eval/gold-matcher.candidates.jsonl]
 *      [--db=~/.nlm/canonical.sqlite]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { evenStride, openSessionContext } from "./lib/transcript.js";
import type { GoldMatch } from "./lib/matcher-gold.js";

const get = (k: string): string | undefined => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const COUNT = Number.parseInt(get("count") ?? "50", 10);
const OUT = (get("out") ?? join(homedir(), ".nlm", "eval", "gold-matcher.candidates.jsonl")).replace(/^~/, homedir());
const DB_PATH = (get("db") ?? join(homedir(), ".nlm", "canonical.sqlite")).replace(/^~/, homedir());

function sha1Prefix(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

interface SessionRow { id: string; label: string; summary: string }

const db = new Database(DB_PATH, { readonly: true });

// Pull all sessions with a non-empty label for stratification.
const rows = db.prepare<[], SessionRow>(
  "SELECT id, label, COALESCE(summary,'') AS summary FROM sessions WHERE label IS NOT NULL AND label != '' ORDER BY ts DESC",
).all();

db.close();

if (rows.length === 0) {
  console.error("No sessions found in canonical.sqlite — run NLM for a while first.");
  process.exit(1);
}

// Stratify by first token of label (loose project grouping for coverage).
const buckets = new Map<string, SessionRow[]>();
for (const r of rows) {
  const bucket = r.label.split(/[\s/]/)[0]!.toLowerCase();
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket)!.push(r);
}

// Even-stride sample within each bucket, then cap to COUNT total.
const perBucket = Math.max(1, Math.ceil(COUNT / buckets.size));
const candidates: SessionRow[] = [];
for (const pool of buckets.values()) {
  candidates.push(...evenStride(pool, perBucket));
}
const sampled = evenStride(candidates, COUNT);

const ctx = openSessionContext();
const out: GoldMatch[] = sampled.map((r) => ({
  key: sha1Prefix(r.id),
  sessionId: r.id,
  label: r.label,
  summary: ctx.get(r.id).slice(0, 200),
  goldWorkstream: "", // operator fills this in
}));
ctx.close();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

console.log(`dump-matcher-candidates — wrote ${out.length} candidates to ${OUT}`);
console.log("  Next: open the file, assign goldWorkstream for each row, rename to gold-matcher.jsonl, run tune-matcher.ts");
